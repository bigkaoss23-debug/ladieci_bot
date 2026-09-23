const { sbInsert } = require("./supabase");

const STATE_TIMESTAMP_COLUMNS = {
  EN_COCINA: "en_cocina_at",
  LISTO: "listo_at",
  EN_ENTREGA: "en_entrega_at",
  RETIRADO: "retirado_at",
  COMPLETADO: "completado_at",
  CANCELADO: "cancelado_at",
};

const PII_METADATA_KEYS = new Set([
  "alias",
  "chat",
  "cliente",
  "cliente_id",
  "direccion",
  "direccion_note",
  "dirección",
  "items",
  "nombre",
  "nota",
  "nota_cucina",
  "nota_fissa",
  "phone",
  "tel",
  "telefono",
  "teléfono",
  "wa_id",
]);

function cleanMetadataValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value
      .map(cleanMetadataValue)
      .filter(v => v !== undefined);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (PII_METADATA_KEYS.has(String(key).toLowerCase())) continue;
      const cleaned = cleanMetadataValue(child);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return undefined;
}

function sanitizeMetadata(metadata = {}) {
  const cleaned = cleanMetadataValue(metadata);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) ? cleaned : {};
}

// SEMANTICA STATI DELIVERY — [DELIVERY-REFACTOR 2026-09-22].
//   RETIRADO = il cliente ha RICEVUTO (DOMICILIO) o RITIRATO (RITIRO) l'ordine.
//              Fatto di business, non evento del rider.
//   EN_ENTREGA = LEGACY, senza più writer. Il viaggio del driver non è uno stato
//              dell'ordine: durante la consegna l'ordine resta LISTO.
// L'event_type "delivered" per RETIRADO+DOMICILIO ora VUOLE DIRE consegnato al
// cliente, e "picked_up" per RITIRO vuol dire ritirato al banco. Fino a questa
// release "delivered" significava invece "rider tornato / giro chiuso": i dati
// STORICI vanno letti con quella semantica, i nuovi con questa.
function stateEventType(from, to, tipoConsegna) {
  if (!from) return "created";
  if (to === "EN_COCINA") {
    return from === "POR_CONFIRMAR" ? "confirmed" : "sent_to_kitchen";
  }
  if (to === "LISTO") return "marked_ready";
  if (to === "EN_ENTREGA") return "sent_delivery"; // legacy: nessun writer moderno
  if (to === "RETIRADO") return tipoConsegna === "DOMICILIO" ? "delivered" : "picked_up"; // consegnato al cliente / ritirato al banco
  if (to === "COMPLETADO") return "completed";
  if (to === "CANCELADO") return "cancelled";
  return "state_changed";
}

function buildStateTimestampPatch({ from = null, to, now = new Date().toISOString(), tipoConsegna = null, extras = {} } = {}) {
  const patch = { updated_at: now };

  // SELF-LOOP GUARD (live 2026-06-05, ordine #002): un re-click sullo STESSO stato
  // (RETIRADO→RETIRADO ecc.) NON deve sovrascrivere i timestamp lifecycle già
  // committati — altrimenti `retirado_at` (e l'analytics del giro reale) si corrompe.
  // Se `from === to` l'ordine è GIÀ in quello stato: il suo `*_at` è stato valorizzato
  // alla transizione originale e va lasciato intatto. Tocchiamo solo `updated_at`.
  // I derivati legacy (hora_salida/hora_entrega) seguono la stessa regola: non
  // re-iniettarli su un no-op. Le transizioni reali (from ≠ to) non sono toccate.
  const isSelfLoop = from != null && String(from) === String(to);
  if (isSelfLoop) return patch;

  const col = STATE_TIMESTAMP_COLUMNS[to];
  if (col) patch[col] = now;

  if (to === "EN_COCINA" && (!from || from === "POR_CONFIRMAR")) {
    patch.confirmado_at = now;
  }

  if (to === "EN_ENTREGA" && extras.hora_salida === undefined) {
    patch.hora_salida = Date.parse(now);
  }

  if ((to === "RETIRADO" || to === "COMPLETADO") && tipoConsegna === "DOMICILIO" && extras.hora_entrega === undefined) {
    patch.hora_entrega = Date.parse(now);
  }

  return patch;
}

async function logOrderStateTransition({
  orderId,
  numeroOrdine = null,
  from = null,
  to,
  eventType,
  actorType = "unknown",
  actorId = null,
  origin = "unknown",
  metadata = {},
  insert = sbInsert,
} = {}) {
  if (!orderId || !to) return { ok: false, skipped: "missing_order_or_state" };

  const row = {
    orden_id: orderId,
    numero_ordine: numeroOrdine || orderId,
    estado_from: from || null,
    estado_to: to,
    event_type: eventType || stateEventType(from, to, metadata?.tipo_consegna),
    actor_type: actorType || "unknown",
    actor_id: actorId || null,
    origin: origin || "unknown",
    metadata: sanitizeMetadata(metadata),
  };

  try {
    await insert("orden_estado_logs", row);
    return { ok: true };
  } catch (e) {
    console.warn("[orderStateLogger] log insert failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// [PAYMENT-IDEMPOTENCY 2026-09-23] Audit della correzione esplicita del metodo di
// pagamento. Stessa tabella append-only delle transizioni (nessun lettore la
// filtra per estado_to: grep FE/BE vuoto), riga RETIRADO→RETIRADO distinta da
// event_type. A differenza di logOrderStateTransition NON è best-effort: il
// chiamante deve sapere se la riga esiste, perché senza audit la correzione
// viene annullata. PostgREST risponde 2xx con l'array delle righe inserite,
// altrimenti un oggetto errore {code,message} senza lanciare: lo controlliamo.
async function logPaymentMethodChange({
  orderId,
  from,
  to,
  tipoConsegna = null,
  cobradoBefore = null,
  actorType = "operator",
  actorId = null,
  origin = "dashboard",
  eventType,
  insert = sbInsert,
} = {}) {
  const row = {
    orden_id: orderId,
    numero_ordine: orderId,
    estado_from: "RETIRADO",
    estado_to: "RETIRADO",
    event_type: eventType,
    actor_type: actorType || "unknown",
    actor_id: actorId || null,
    origin: origin || "unknown",
    metadata: sanitizeMetadata({
      reason: "payment_method_correction",
      tipo_consegna: tipoConsegna,
      metodo_pago_from: from || null,
      metodo_pago_to: to,
      cobrado_before: cobradoBefore,
    }),
  };
  try {
    const res = await insert("orden_estado_logs", row);
    if (Array.isArray(res) && res.length === 1) return { ok: true, id: res[0].id || null };
    return { ok: false, error: (res && (res.message || res.code)) || "insert_not_confirmed" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  PII_METADATA_KEYS,
  logPaymentMethodChange,
  buildStateTimestampPatch,
  logOrderStateTransition,
  sanitizeMetadata,
  stateEventType,
};
