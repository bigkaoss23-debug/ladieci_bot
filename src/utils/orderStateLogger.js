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

function stateEventType(from, to, tipoConsegna) {
  if (!from) return "created";
  if (to === "EN_COCINA") {
    return from === "POR_CONFIRMAR" ? "confirmed" : "sent_to_kitchen";
  }
  if (to === "LISTO") return "marked_ready";
  if (to === "EN_ENTREGA") return "sent_delivery";
  if (to === "RETIRADO") return tipoConsegna === "DOMICILIO" ? "delivered" : "picked_up";
  if (to === "COMPLETADO") return "completed";
  if (to === "CANCELADO") return "cancelled";
  return "state_changed";
}

function buildStateTimestampPatch({ from = null, to, now = new Date().toISOString(), tipoConsegna = null, extras = {} } = {}) {
  const patch = { updated_at: now };
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
