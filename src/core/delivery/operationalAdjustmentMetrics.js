// src/core/delivery/operationalAdjustmentMetrics.js
// ===============================================================
// Operational Adjustment metrics — helper PURO read-only.
// Nessun DB, nessun fetch, nessun process.env, nessun side-effect, nessuna PII.
//
// SCOPO: interpretare il `ui_offset_min` esistente (oggi snooze visivo +5/+10
// in cucina, cap 20, non letto da planner/shadow) COME `ajuste_operativo_min`,
// e derivare le metriche del modello "originale vs operativo vs reale" SENZA
// cambiare nulla a runtime.
//
// MODELLO (audit 2026-06-06):
//   • hora_original       = hora promessa al cliente (NON viene mai modificata).
//   • ajuste_operativo_min = ui_offset_min (riallineo operativo deciso dal servizio).
//   • hora_operativa       = hora_original + ajuste_operativo_min  (DERIVATA, mai persistita).
//   • reale                = listo_at (e i timestamp lifecycle).
// Confronto: hora_operativa è la "nuova scadenza" dopo il riallineo; il margine
// (default 10 min) tollera lo scarto. NIENTE scrittura, NIENTE planner change.
// ===============================================================
"use strict";

const DEFAULT_MARGIN_MIN = 10;

// Estrae minuti-di-giornata (con secondi come frazione) da "HH:MM[:SS]" o da un
// timestamp ISO ("...T21:33:45..."). Night-service: ore < 6 → +24h (parità planner),
// così 00:15 resta DOPO 23:50 e gli scarti non vanno negativi per il wrap mezzanotte.
function toClockMinutes(value) {
  if (value == null) return null;
  const s = String(value);
  let m = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] != null ? Number(m[3]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 6) h += 24; // night-service
  return h * 60 + min + sec / 60;
}

function fromClockMinutes(mins) {
  if (mins == null || !Number.isFinite(mins)) return null;
  const total = Math.round(mins);
  let h = Math.floor(total / 60);
  const m = ((total % 60) + 60) % 60;
  if (h >= 24) h -= 24;
  if (h < 0) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function round1(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
}

function toAdjustmentMin(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0; // null/0/negativi → nessun ajuste
  return n;
}

const CLASSIFICATION_LABEL = {
  no_adjustment: "Sin ajuste operativo",
  active_adjustment: "Ajuste operativo activo (aún no listo)",
  absorbed: "Ajuste absorbido (listo dentro del horario operativo)",
  within_margin: "Listo con retraso leve dentro de margen",
  outside_margin: "Fuera de margen operativo",
  unknown: "Datos insuficientes para evaluar el ajuste",
};

// Calcola le metriche di aggiustamento operativo di UN ordine. Pure, no PII.
// order: { id, tipo|tipo_consegna, estado, zona, hora, forno_out, ui_offset_min,
//          listo_at, en_cocina_at, en_entrega_at, retirado_at, durata_andata_min,
//          salida_driver_estimada?, entrega_estimada? }
// options: { marginMin = 10 }
function computeOperationalAdjustmentMetric(order = {}, options = {}) {
  const marginMin = Number.isFinite(Number(options.marginMin)) ? Number(options.marginMin) : DEFAULT_MARGIN_MIN;
  const orderId = order.id != null ? order.id : null;
  const tipo = order.tipo != null ? order.tipo : (order.tipo_consegna != null ? order.tipo_consegna : null);
  const estado = order.estado != null ? order.estado : null;
  const zona = order.zona != null ? order.zona : null;

  const horaOriginal = order.hora != null ? String(order.hora) : null;
  const ajuste = toAdjustmentMin(order.ui_offset_min);
  const hasAdjustment = ajuste > 0;

  const ho = toClockMinutes(horaOriginal);
  const hop = ho != null ? ho + ajuste : null;
  const horaOperativa = fromClockMinutes(hop);

  const fornoOutStr = order.forno_out != null ? String(order.forno_out) : null;
  const fornoOutMin = toClockMinutes(fornoOutStr);
  const listoStr = order.listo_at != null ? String(order.listo_at) : null;
  const listoMin = toClockMinutes(listoStr);

  const listoVsOperativa = (listoMin != null && hop != null) ? round1(listoMin - hop) : null;
  const listoVsForno = (listoMin != null && fornoOutMin != null) ? round1(listoMin - fornoOutMin) : null;

  const metric = {
    orderId,
    tipo,
    estado,
    zona,

    hora_original: horaOriginal,
    ajuste_operativo_min: ajuste,
    hora_operativa: horaOperativa,

    forno_out: fornoOutStr,
    listo_at: listoStr,

    has_adjustment: hasAdjustment,
    adjustment_status: "none",   // none | active | absorbed | exceeded
    adjustment_label: CLASSIFICATION_LABEL.unknown,

    listo_vs_hora_operativa_min: listoVsOperativa,
    listo_vs_forno_out_min: listoVsForno,

    within_margin: null,         // true/false/null (null = non valutabile)
    margin_min: marginMin,

    classification: "unknown",
    reasons: [],
  };

  // ── Classificazione ────────────────────────────────────────────────────────
  if (ho == null) {
    metric.classification = "unknown";
    metric.reasons.push("missing_hora_original");
  } else if (listoMin == null) {
    // Ordine non ancora LISTO (o senza timestamp reale).
    if (hasAdjustment) {
      metric.classification = "active_adjustment";
      metric.adjustment_status = "active";
      metric.reasons.push("adjustment_active_not_ready");
    } else {
      metric.classification = "no_adjustment";
      metric.adjustment_status = "none";
      metric.reasons.push("no_operational_adjustment");
    }
  } else if (hasAdjustment) {
    // Ajuste presente + ordine LISTO: la scadenza è hora_operativa.
    if (listoMin <= hop) {
      metric.classification = "absorbed";
      metric.adjustment_status = "absorbed";
      metric.within_margin = true;
      metric.reasons.push(listoMin < hop ? "ready_before_operational_time" : "ready_at_operational_time");
    } else {
      metric.classification = "outside_margin";
      metric.adjustment_status = "exceeded";
      metric.within_margin = false;
      metric.reasons.push("ready_after_operational_time");
    }
  } else {
    // Nessun ajuste + ordine LISTO: margine misurato su hora_original.
    if (listoMin <= ho) {
      metric.classification = "no_adjustment";
      metric.adjustment_status = "none";
      metric.within_margin = true;
      metric.reasons.push("ready_on_time");
    } else if (listoMin <= ho + marginMin) {
      metric.classification = "within_margin";
      metric.adjustment_status = "none";
      metric.within_margin = true;
      metric.reasons.push("ready_after_original_within_margin");
    } else {
      metric.classification = "outside_margin";
      metric.adjustment_status = "none";
      metric.within_margin = false;
      metric.reasons.push("ready_after_original_outside_margin");
    }
  }

  metric.adjustment_label = CLASSIFICATION_LABEL[metric.classification] || CLASSIFICATION_LABEL.unknown;
  return metric;
}

// Aggregato safe su una lista di ordini. Nessuna PII in watchOrders.
function summarizeOperationalAdjustments(orders = [], options = {}) {
  const metrics = (Array.isArray(orders) ? orders : [])
    .map((o) => computeOperationalAdjustmentMetric(o, options));

  const adjusted = metrics.filter((m) => m.has_adjustment);
  const active = metrics.filter((m) => m.classification === "active_adjustment");
  const absorbed = metrics.filter((m) => m.classification === "absorbed");
  const outside = metrics.filter((m) => m.classification === "outside_margin");

  const adjVals = adjusted.map((m) => m.ajuste_operativo_min);
  const maxAdj = adjVals.length ? Math.max(...adjVals) : 0;
  const avgAdj = adjVals.length ? round1(adjVals.reduce((s, v) => s + v, 0) / adjVals.length) : 0;

  // watchOrders: ordini da tenere d'occhio (ajuste attivo o fuori margine). No PII.
  const watchOrders = metrics
    .filter((m) => m.classification === "active_adjustment" || m.classification === "outside_margin")
    .map((m) => ({
      orderId: m.orderId,
      tipo: m.tipo,
      estado: m.estado,
      zona: m.zona,
      hora_original: m.hora_original,
      hora_operativa: m.hora_operativa,
      ajuste_operativo_min: m.ajuste_operativo_min,
      classification: m.classification,
      reasons: m.reasons,
    }));

  return {
    totalOrders: metrics.length,
    adjustedOrders: adjusted.length,
    activeAdjustments: active.length,
    absorbedAdjustments: absorbed.length,
    outsideMargin: outside.length,
    maxAdjustmentMin: maxAdj,
    avgAdjustmentMin: avgAdj,
    watchOrders,
  };
}

module.exports = {
  computeOperationalAdjustmentMetric,
  summarizeOperationalAdjustments,
  _internal: {
    toClockMinutes,
    fromClockMinutes,
    toAdjustmentMin,
    DEFAULT_MARGIN_MIN,
    CLASSIFICATION_LABEL,
  },
};
