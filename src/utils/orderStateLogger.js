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

// SEMANTICA STATI DELIVERY (confermata live 05/06/2026):
//   EN_ENTREGA = il rider ESCE dalla pizzeria (salida rider), NON è consegna.
//   RETIRADO   = il rider TORNA in pizzeria (giro chiuso), NON è consegna cliente.
// L'event_type storico "delivered" per RETIRADO+DOMICILIO è un NOME STORICO: il suo
// significato operativo reale è "rider tornato / giro chiuso", non "consegnato al
// cliente". Non rinominato qui perché radicato in consumer esistenti; le metriche
// NUOVE usano la semantica corretta (vedi deliveryOperationalMetrics.js: la consegna
// cliente è STIMATA = en_entrega_at + durata_andata_min, non retirado_at).
function stateEventType(from, to, tipoConsegna) {
  if (!from) return "created";
  if (to === "EN_COCINA") {
    return from === "POR_CONFIRMAR" ? "confirmed" : "sent_to_kitchen";
  }
  if (to === "LISTO") return "marked_ready";
  if (to === "EN_ENTREGA") return "sent_delivery"; // salida rider, non consegna
  if (to === "RETIRADO") return tipoConsegna === "DOMICILIO" ? "delivered" : "picked_up"; // "delivered" = giro chiuso/rider tornato (nome storico)
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

module.exports = {
  PII_METADATA_KEYS,
  buildStateTimestampPatch,
  logOrderStateTransition,
  sanitizeMetadata,
  stateEventType,
};
