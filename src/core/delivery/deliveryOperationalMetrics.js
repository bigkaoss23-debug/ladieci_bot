// src/core/delivery/deliveryOperationalMetrics.js
// ===============================================================
// Metriche operative delivery — helper PURO read-only.
// Nessun DB, nessun fetch, nessun process.env, nessun side-effect, nessuna PII.
// Origine: live monitoring 05/06/2026. Il collo di bottiglia reale del servizio
// NON è cucina né planner base, ma la finestra `LISTO → EN_ENTREGA`
// (pizza pronta → uscita rider dalla pizzeria).
//
// SEMANTICA STATI DELIVERY (confermata dall'operatore, NON è "colpa rider"):
//   • listo_at      = pizza pronta in pizzeria.
//   • en_entrega_at = il rider ESCE dalla pizzeria (salida rider). NON è consegna.
//   • retirado_at   = il rider TORNA in pizzeria (giro chiuso). NON è consegna cliente.
//   • consegna cliente STIMATA = en_entrega_at + durata_andata_min.
//   • giro reale                = retirado_at - en_entrega_at.
// Wording operativo, mai accusatorio: "pizza pronta in attesa uscita rider",
// "possibile attesa dispatch", "uscita rider da monitorare".
// ===============================================================
"use strict";

// Soglie ready_to_rider_exit (minuti). Calibrate sui dati live:
//   #019 ~5.4 → watch · #006 ~12.2 → late_dispatch_risk · #013 ~8.5 → watch.
const READY_TO_EXIT_OK_MAX = 5;     // 0–5  → ok
const READY_TO_EXIT_WATCH_MAX = 10; // 5–10 → watch · >10 → late_dispatch_risk

// Estrae i minuti-di-giornata (con secondi come frazione) da un timestamp.
// Accetta sia ISO datetime ("...T21:55:37...") sia orari "HH:MM[:SS]".
// Night-service: ore < 6 sono spostate al giorno dopo (+24h), in parità col planner,
// così un giro a 00:20 resta DOPO un LISTO delle 23:50 e i delta non vanno negativi.
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
  let total = Math.round(mins);
  let h = Math.floor(total / 60);
  const m = ((total % 60) + 60) % 60;
  if (h >= 24) h -= 24;
  if (h < 0) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function round1(x) {
  return x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
}

function toFiniteMin(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Classifica la finestra pizza-pronta → uscita rider.
function classifyReadyToExit(min) {
  if (min == null) return "unknown";
  if (min < 0) return "invalid_timing";
  if (min <= READY_TO_EXIT_OK_MAX) return "ok";
  if (min <= READY_TO_EXIT_WATCH_MAX) return "watch";
  return "late_dispatch_risk";
}

const READY_TO_EXIT_LABEL = {
  ok: "Uscita rider rapida dopo pizza pronta",
  watch: "Uscita rider da monitorare (pizza pronta in attesa)",
  late_dispatch_risk: "Possibile attesa dispatch: pizza pronta, rider non ancora uscito",
  pending: "Pizza pronta, in attesa uscita rider",
  unknown: "Dati insufficienti per la finestra pizza-pronta → uscita rider",
  invalid_timing: "Timing incoerente (uscita rider prima di pizza pronta)",
};

// Calcola le metriche operative di UN ordine delivery. Pure, no PII in output.
// order: { id, estado, zona, tipo_consegna, listo_at, en_entrega_at, retirado_at,
//          durata_andata_min, hora }  (hora = ora promessa cliente "HH:MM")
// opts:  { now }  — orario corrente iniettabile ("HH:MM" o ISO) per stimare attese
//                   quando en_entrega_at manca ancora.
function computeDeliveryOperationalMetric(order = {}, opts = {}) {
  const orderId = order.id != null ? order.id : null;
  const estado = order.estado != null ? order.estado : null;
  const zona = order.zona != null ? order.zona : null;

  // Solo DOMICILIO ha senso per queste metriche (rider esce/torna).
  if (order.tipo_consegna && order.tipo_consegna !== "DOMICILIO") {
    return { orderId, estado, zona, applicable: false, reason: "not_domicilio" };
  }

  const listo = toClockMinutes(order.listo_at);
  const enEntrega = toClockMinutes(order.en_entrega_at);
  const retirado = toClockMinutes(order.retirado_at);
  const nowMin = toClockMinutes(opts.now);
  const durata = toFiniteMin(order.durata_andata_min);
  const horaCliente = toClockMinutes(order.hora);

  const metric = {
    orderId,
    estado,
    zona,
    applicable: true,
    // ── finestra pizza pronta → uscita rider ──
    ready_to_rider_exit_min: null,
    ready_to_rider_exit_status: "unknown",
    ready_to_rider_exit_label: READY_TO_EXIT_LABEL.unknown,
    // ── consegna cliente stimata (dall'uscita rider) ──
    estimated_customer_delivery_from_exit: null,
    estimated_customer_delay_from_exit_min: null,
    // ── giro reale (uscita → ritorno rider) ──
    real_trip_min: null,
    trip_expected_min: durata != null ? round1(durata * 2) : null,
    trip_status: "unknown",
  };

  // ── ready_to_rider_exit ──────────────────────────────────────────────────
  if (listo == null) {
    metric.ready_to_rider_exit_status = "unknown";
  } else if (enEntrega != null) {
    const delta = enEntrega - listo;
    if (delta < 0) {
      metric.ready_to_rider_exit_status = "invalid_timing";
    } else {
      metric.ready_to_rider_exit_min = round1(delta);
      metric.ready_to_rider_exit_status = classifyReadyToExit(delta);
    }
  } else if (nowMin != null) {
    // Non ancora uscito: stimiamo l'attesa accumulata con `now` iniettato.
    const waited = nowMin - listo;
    if (waited < 0) {
      metric.ready_to_rider_exit_status = "pending";
    } else {
      metric.ready_to_rider_exit_min = round1(waited);
      const cls = classifyReadyToExit(waited);
      metric.ready_to_rider_exit_status = cls === "ok" ? "pending" : cls;
    }
  } else {
    metric.ready_to_rider_exit_status = "pending";
  }
  metric.ready_to_rider_exit_label =
    READY_TO_EXIT_LABEL[metric.ready_to_rider_exit_status] || READY_TO_EXIT_LABEL.unknown;

  // ── consegna cliente stimata dall'uscita rider ───────────────────────────
  if (enEntrega != null && durata != null) {
    const deliveryMin = enEntrega + durata;
    metric.estimated_customer_delivery_from_exit = fromClockMinutes(deliveryMin);
    if (horaCliente != null) {
      metric.estimated_customer_delay_from_exit_min = round1(deliveryMin - horaCliente);
    }
  }

  // ── giro reale uscita → ritorno rider ────────────────────────────────────
  if (enEntrega != null && retirado != null) {
    const trip = retirado - enEntrega;
    if (trip < 0) {
      metric.trip_status = "invalid_timing"; // ritorno prima dell'uscita
    } else {
      metric.real_trip_min = round1(trip);
      metric.trip_status = "closed";
    }
  } else if (enEntrega != null) {
    metric.trip_status = "in_progress"; // rider uscito, non ancora tornato
  }

  return metric;
}

// Aggregato safe su una lista di ordini (solo delivery contribuiscono).
function summarizeDeliveryOperationalMetrics(orders = [], opts = {}) {
  const metrics = (Array.isArray(orders) ? orders : [])
    .map((o) => computeDeliveryOperationalMetric(o, opts))
    .filter((m) => m.applicable);
  const counts = { ok: 0, watch: 0, late_dispatch_risk: 0, pending: 0, unknown: 0, invalid_timing: 0 };
  for (const m of metrics) {
    const s = m.ready_to_rider_exit_status;
    if (counts[s] === undefined) counts[s] = 0;
    counts[s] += 1;
  }
  return {
    deliveryCount: metrics.length,
    readyToExitStatusCounts: counts,
    lateDispatchRiskCount: counts.late_dispatch_risk,
    metrics,
  };
}

module.exports = {
  computeDeliveryOperationalMetric,
  summarizeDeliveryOperationalMetrics,
  _internal: {
    toClockMinutes,
    fromClockMinutes,
    classifyReadyToExit,
    READY_TO_EXIT_OK_MAX,
    READY_TO_EXIT_WATCH_MAX,
  },
};
