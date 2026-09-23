"use strict";
// ===============================================================
// PROTOTYPE — validation only, NOT committed. Frozen Delivery V1.
// giroCompat.js: "esiste qualcosa di già esistente a cui aggregare?"
// Inputs: zone, deadline, capacity, order state, membership. NOTHING else.
// (No rider state, no ETA, no `now`.) Zone table is READ-ONLY from utils/zones.
// ===============================================================

const { ZONE_DELIVERY } = require("../../utils/zones");
const { getOrderDeadlineMs, minuteFloor } = require("./deadline");

const AGGREGABLE_STATES = new Set(["POR_CONFIRMAR", "EN_COCINA", "LISTO"]);
const DEPARTED_STATE = "EN_ENTREGA"; // used ONLY as the fact "this order already left"
const DEFAULT_WINDOW_MIN = 15;

function resolveWindowMin(cfg) {
  const n = Number(cfg && cfg.GIRO_COMPAT_WINDOW_MIN);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : DEFAULT_WINDOW_MIN;
}
function maxPerGiro(zonaId) {
  const z = ZONE_DELIVERY.find(x => x.id === zonaId);
  return z ? z.maxOrdiniPerGiro : null;
}
const numId = (id) => parseInt(String(id).replace(/\D/g, ""), 10) || 0;

/**
 * [GIRO-CANDIDATES 2026-09-23] Tutti i candidati compatibili, nello stesso ordine con cui suggestGiro sceglie
 * il primo. Stessi criteri, stessa finestra, stessa capienza: suggestGiro ne restituisce solo candidates[0].
 * @returns Array<{ kind:'GIRO'|'ORDINE', giro_id?, order_id?, member_ids, delta_min, used, max, zona, window_min }>
 */
function listGiroCandidates({ newOrder, orders, giros, cfg }) {
  if (!newOrder || newOrder.tipo_consegna !== "DOMICILIO" || !newOrder.zona) return [];
  const max = maxPerGiro(newOrder.zona);
  if (!max) return [];
  const nDl = getOrderDeadlineMs(newOrder);
  if (nDl == null) return [];
  const windowMin = resolveWindowMin(cfg);

  const aliveGiros = new Set((giros || []).filter(g => g && !g.dissolved_at).map(g => g.id));
  const byGiro = new Map();
  const singles = [];
  for (const o of orders || []) {
    if (!o || (newOrder.id && o.id === newOrder.id)) continue;
    if (o.tipo_consegna !== "DOMICILIO") continue;
    if (o.manual_giro_id) {
      if (aliveGiros.has(o.manual_giro_id)) {
        if (!byGiro.has(o.manual_giro_id)) byGiro.set(o.manual_giro_id, []);
        byGiro.get(o.manual_giro_id).push(o);
      }
      continue; // orphan link (giro dissolved/unknown) → never a candidate
    }
    singles.push(o);
  }

  const candidates = [];
  for (const [gid, members] of byGiro) {
    if (members.some(m => m.estado === DEPARTED_STATE)) continue;        // giro già partito
    const M = members.filter(m => AGGREGABLE_STATES.has(m.estado));
    if (M.length < 2) continue;                                            // giro monco: mai un target
    if (!M.every(m => m.zona === newOrder.zona)) continue;                 // v1: stessa zona
    if (M.length + 1 > max) continue;                                      // capienza
    const dls = M.map(getOrderDeadlineMs);
    if (dls.some(x => x == null)) continue;
    const delta = Math.abs(minuteFloor(nDl) - minuteFloor(Math.min(...dls)));
    if (delta > windowMin) continue;                                       // inclusivo: Δ = finestra passa
    candidates.push({ kind: "GIRO", giro_id: gid, member_ids: M.map(m => m.id), delta_min: delta, used: M.length, max, head: Math.min(...M.map(m => numId(m.id))) });
  }
  for (const s of singles) {
    if (!AGGREGABLE_STATES.has(s.estado)) continue;                        // EN_ENTREGA / terminali fuori
    if (s.zona !== newOrder.zona) continue;
    if (2 > max) continue;
    const sd = getOrderDeadlineMs(s);
    if (sd == null) continue;
    const delta = Math.abs(minuteFloor(nDl) - minuteFloor(sd));
    if (delta > windowMin) continue;
    candidates.push({ kind: "ORDINE", order_id: s.id, member_ids: [s.id], delta_min: delta, used: 1, max, head: numId(s.id) });
  }

  candidates.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "GIRO" ? -1 : 1) ||
    (a.delta_min - b.delta_min) || (b.used - a.used) || (a.head - b.head) ||
    String(a.giro_id || a.order_id).localeCompare(String(b.giro_id || b.order_id)));

  return candidates.map(({ head, ...c }) => ({ ...c, zona: newOrder.zona, window_min: windowMin }));
}

/**
 * @param newOrder {id?, tipo_consegna, zona, delivery_deadline_at|hora+ts}
 * @param orders   active rows: {id, tipo_consegna, zona, estado, manual_giro_id, delivery_deadline_at|hora+ts}
 * @param giros    active giro rows: {id, dissolved_at}
 * @returns null | { kind:'GIRO'|'ORDINE', giro_id?, order_id?, member_ids, delta_min, used, max, zona, window_min, alternatives }
 */
function suggestGiro(args) {
  const candidates = listGiroCandidates(args);
  if (!candidates.length) return null;
  return { ...candidates[0], alternatives: candidates.length - 1 };
}

module.exports = { suggestGiro, listGiroCandidates, resolveWindowMin, AGGREGABLE_STATES, DEFAULT_WINDOW_MIN, maxPerGiro };
