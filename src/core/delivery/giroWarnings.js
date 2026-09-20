"use strict";
// ===============================================================
// PROTOTYPE — validation only, NOT committed. Frozen Delivery V1.
// giroWarnings.js: warnings CERTI (facts only). Never blocking.
// No ETA, no PREP/SOSTA constants, no rider state.
// ===============================================================

const { ZONE_DELIVERY } = require("../../utils/zones");
const { getOrderDeadlineMs, minuteFloor } = require("./deadline");
const { resolveWindowMin } = require("./giroCompat");

const DEPARTED_STATE = "EN_ENTREGA";

/**
 * @param members  [{id, zona, estado, delivery_deadline_at|hora+ts}]  (composition being evaluated)
 * @returns [{ code, member_ids?, data? }]   — always confirmable (no `blocking` concept)
 */
function evaluateGiroWarnings({ members, nowMs, cfg }) {
  const out = [];
  const list = (members || []).filter(Boolean);
  const windowMin = resolveWindowMin(cfg);

  const departed = list.filter(m => m.estado === DEPARTED_STATE);
  if (departed.length) out.push({ code: "already_departed", member_ids: departed.map(m => m.id) });

  const live = list.filter(m => m.estado !== DEPARTED_STATE);
  const dl = live.map(m => ({ m, t: getOrderDeadlineMs(m) })).filter(x => x.t != null);

  const passed = dl.filter(x => x.t < nowMs);
  if (passed.length) out.push({ code: "deadline_passed", member_ids: passed.map(x => x.m.id) });

  const noZone = list.filter(m => !m.zona);
  if (noZone.length) out.push({ code: "no_zone", member_ids: noZone.map(m => m.id) });

  const zones = Array.from(new Set(list.map(m => m.zona).filter(Boolean)));
  if (zones.length > 1) out.push({ code: "zones_differ", data: { zones } });

  if (zones.length) {
    const caps = zones.map(z => (ZONE_DELIVERY.find(x => x.id === z) || {}).maxOrdiniPerGiro).filter(Number.isFinite);
    const cap = caps.length ? Math.min(...caps) : null;   // conservative for mixed zones
    if (cap != null && list.length > cap) out.push({ code: "capacity_exceeded", data: { used: list.length, max: cap } });
  }

  if (dl.length >= 2) {
    const mins = dl.map(x => minuteFloor(x.t));
    const spread = Math.max(...mins) - Math.min(...mins);
    if (spread > windowMin) {
      // outlier = a single member whose deadline is far earlier than an otherwise coherent group
      const outliers = dl.filter(x => {
        const others = dl.filter(y => y !== x).map(y => minuteFloor(y.t));
        const othersSpread = Math.max(...others) - Math.min(...others);
        return othersSpread <= windowMin && (Math.min(...others) - minuteFloor(x.t)) > windowMin;
      });
      if (outliers.length === 1) {
        const others = dl.filter(y => y !== outliers[0]).map(y => minuteFloor(y.t));
        out.push({ code: "deadline_much_closer", member_ids: [outliers[0].m.id],
          data: { delta_min: Math.min(...others) - minuteFloor(outliers[0].t) } });
      } else {
        const earliest = dl.reduce((a, b) => (b.t < a.t ? b : a));
        const latest = dl.reduce((a, b) => (b.t > a.t ? b : a));
        out.push({ code: "spread_over_window", member_ids: [earliest.m.id, latest.m.id], data: { spread_min: spread, window_min: windowMin } });
      }
    }
  }
  return out;
}

module.exports = { evaluateGiroWarnings };
