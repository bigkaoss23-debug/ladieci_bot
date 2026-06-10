// ===============================================================
// riderAvailability.js — Rider Availability Adapter (2026-06-10)
// ===============================================================
// PURE read-path adapter. Sorgente di verità = `ordenes` (estado +
// hora_salida reale + durata_andata_min). NON legge DB, NON scrive,
// NON usa Date.now, NON usa DRIVER_STATO come verità primaria.
//
// Chiude il gap di RIDER EVENT FEEDBACK LOOP MICRO-01: il bottone UI
// "Salgo" (marcarEnEntrega) registra estado=EN_ENTREGA + hora_salida
// reale (Date.now() ms), ma i planner non lo usavano per dire al
// dashboard che il rider è occupato. Questo adapter deriva la finestra
// di occupazione reale del rider dagli ordini già partiti.
//
// V1 single-rider: il rider è occupato fino al rientro più lontano fra
// gli ordini EN_ENTREGA. Round trip reale = salida_real + 2×andata +
// buffer ops al cliente. (one-way andata × 2 = andata + ritorno.)
// ===============================================================

"use strict";

const DEFAULT_BUFFER_MIN = 3;

// Converte un valore hora_salida in minuti-clock Madrid (0..1439).
// Accetta: number (ms epoch), numeric string, ISO string, "HH:MM". Null/
// malformato → null (il caller decide il fallback senza crashare).
function toMadridMinutes(value) {
  if (value == null) return null;

  // "HH:MM" diretto (robustezza: alcuni path potrebbero passare clock-min).
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value.trim())) {
    const [h, m] = value.trim().split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  }

  // ms epoch (Date.now()) come number o numeric string.
  let ms = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === "string") {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && /^\d+$/.test(value.trim())) {
      ms = asNum;
    } else {
      const parsed = Date.parse(value); // ISO string
      if (Number.isFinite(parsed)) ms = parsed;
    }
  }
  if (ms == null) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch (_) {
    return null;
  }
}

const IGNORED_ESTADOS = new Set(["RETIRADO", "COMPLETATO", "COMPLETADO", "POR_CONFIRMAR"]);

// resolveRiderAvailability(orders, opts)
//   orders: array di righe ordine DOMICILIO già caricate (no DB qui).
//   opts.nowMin:      minuti-clock correnti (OBBLIGATORIO nei test). Default null.
//   opts.bufferMin:   buffer ops al cliente, default 3.
//   opts.singleRider: default true (V1).
//
// Output (deterministico):
//   { ok, nowMin, busyUntilMin, driverLiberoMin, ridersOut[], warnings[] }
// busyUntilMin = max(returnMin) fra gli EN_ENTREGA ancora fuori (returnMin>nowMin).
// null se nessun rider è fuori adesso → driver libero.
function resolveRiderAvailability(orders, opts = {}) {
  const nowMin = Number.isFinite(opts.nowMin) ? opts.nowMin : null;
  const bufferMin = Number.isFinite(opts.bufferMin) ? opts.bufferMin : DEFAULT_BUFFER_MIN;
  const warnings = [];
  const ridersOut = [];

  const list = Array.isArray(orders) ? orders : [];

  for (const o of list) {
    if (!o || o.tipo_consegna !== "DOMICILIO") continue;
    const estado = o.estado;
    if (IGNORED_ESTADOS.has(estado)) continue;

    // Solo gli ordini realmente partiti hanno una finestra rider reale.
    // EN_COCINA / LISTO non hanno partenza reale: non inventiamo (cascade
    // pianificato resta competenza di simulateDriverSchedule altrove).
    if (estado !== "EN_ENTREGA") continue;

    const salidaRealMin = toMadridMinutes(o.hora_salida);
    if (salidaRealMin == null) {
      warnings.push({
        code: "hora_salida_unparseable",
        orderId: o.id != null ? o.id : null,
        message: `EN_ENTREGA senza hora_salida valida (${o.hora_salida}); ordine ignorato per disponibilità reale`,
      });
      continue;
    }

    const durataAndataMin = Number.isFinite(o.durata_andata_min) ? o.durata_andata_min : null;
    if (durataAndataMin == null) {
      warnings.push({
        code: "durata_andata_missing",
        orderId: o.id != null ? o.id : null,
        message: `EN_ENTREGA #${o.id} senza durata_andata_min; rientro reale non calcolabile`,
      });
      continue;
    }

    const returnMin = salidaRealMin + 2 * durataAndataMin + bufferMin;
    ridersOut.push({
      orderId: o.id != null ? o.id : null,
      zona: o.zona != null ? o.zona : null,
      salidaRealMin,
      durataAndataMin,
      returnMin,
      source: "order_hora_salida",
    });
  }

  // busyUntilMin = rientro più lontano fra i rider ANCORA fuori adesso.
  // Se nowMin è noto, scartiamo i giri già rientrati (returnMin <= nowMin).
  const stillOut = ridersOut.filter((r) =>
    nowMin == null ? true : r.returnMin > nowMin
  );
  const busyUntilMin = stillOut.length
    ? Math.max(...stillOut.map((r) => r.returnMin))
    : null;

  return {
    ok: true,
    nowMin,
    busyUntilMin,
    driverLiberoMin: busyUntilMin, // floor reale; null = libero adesso
    ridersOut,
    warnings,
  };
}

module.exports = { resolveRiderAvailability, toMadridMinutes, DEFAULT_BUFFER_MIN };
