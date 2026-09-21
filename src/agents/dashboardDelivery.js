"use strict";
// ===============================================================
// PROTOTYPE — validation only, NOT committed. Frozen Delivery V1.
// dashboardDelivery.js: dashboard-only composition layer. agentOrdini.js (shared with the
// WhatsApp bot) is NOT edited: index.js routes call these around the unchanged creaOrdine.
// ===============================================================

const raw = require("../utils/supabase");
const mg = require("./manualGiros");
// [FDV1] giro-path DB access carries a LOCAL timeout (manualGiros.giroDb). supabase.js itself is shared with the WhatsApp bot: untouched.
const { sbSelect, sbUpdate, sbDelete } = mg.giroDb;
const { computeAutoDeadline, resolveDeadlineMin, formatMadridHHMM, getOrderDeadlineMs } = require("../core/delivery/deadline");
const { suggestGiro } = require("../core/delivery/giroCompat");
const { evaluateGiroWarnings } = require("../core/delivery/giroWarnings");
const { maxPerGiro } = require("../core/delivery/giroCompat");

const enc = mg.encodeEqValue;
// [FDV1 R3] ± production priority contract v2: theoretical range −50..+50 (integer minutes).
//   − (earlier in the production queue) is always allowed.
//   + (later in the queue) is allowed while the resulting production target stays at or before the real
//     HORA LÍMITE — NOT before some safety buffer inside it:
//       max_allowed = floor((earliest deadline − now) / 1 min), clamped to 0..OFFSET_MAX.
//     The last minutes before the deadline are URGENTE, which is a VISUAL state, not a forbidden zone:
//     an order created with a +55 deadline may legitimately take +50 and be left with 5 minutes.
//     TARDE (the deadline actually passed) is the only real overrun, and there max_allowed is already 0.
//     For a giro the earliest deadline is the most urgent live member. Lowering an existing + is always allowed.
//   A + beyond the window is REFUSED (409 offset_exceeds_window, with requested + max_allowed): never clamped silently.
//   Only ui_offset_min is written: hora, delivery_deadline_at, ts and the client promise never change.
const OFFSET_MIN = -50, OFFSET_MAX = 50;
const PRIORITY_MARGIN_MIN = 0;           // no artificial buffer: URGENTE is visual, only the real deadline binds
const PRIORITY_CONTRACT = Object.freeze({ version: 2, min: OFFSET_MIN, max: OFFSET_MAX, margin_min: PRIORITY_MARGIN_MIN, rule: "plus_within_window_before_deadline" });

// Largest + (minutes) that still leaves the production target at or before the most urgent real deadline.
// null deadline → 0 (not provably safe).
function maxPlusAllowed(orders, nowMs) {
  const dls = (orders || []).map(getOrderDeadlineMs).filter(Number.isFinite);
  if (!dls.length) return 0;
  const left = Math.floor((Math.min(...dls) - nowMs) / 60000) - PRIORITY_MARGIN_MIN;
  return Math.max(0, Math.min(OFFSET_MAX, left));
}

// ── ± production priority ────────────────────────────────────────
// Writes ONLY ui_offset_min. Order in a giro → the WHOLE block (single PATCH = atomic).
async function setPriorityOffset(orderId, offsetMin, opts = {}) {
  if (!orderId) return { success: false, error: "missing_order_id" };
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const raw = Math.round(Number(offsetMin));
  const off = Number.isFinite(raw) ? Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, raw)) : 0;
  const cols = "id,tipo_consegna,estado,manual_giro_id,ui_offset_min,delivery_deadline_at,hora,ts,created_at";
  const rows = await sbSelect("ordenes", `id=eq.${enc(orderId)}&select=${cols}`);
  if (!Array.isArray(rows)) return { success: false, status: 502, error: "order_read_failed" };   // unreadable ≠ not found
  const o = rows[0] || null;
  if (!o) return { success: false, status: 404, error: "order_not_found" };
  if (o.tipo_consegna !== "DOMICILIO") return { success: false, status: 400, error: "not_delivery" };
  let scopeRows = [o];
  if (o.manual_giro_id) {
    const memRows = await sbSelect("ordenes", `manual_giro_id=eq.${enc(o.manual_giro_id)}&select=${cols}`);
    if (!Array.isArray(memRows)) return { success: false, status: 502, error: "order_read_failed", step: "giro_members" };
    scopeRows = memRows.filter(mg.isOrderEligibleForGiro);
    if (!scopeRows.length) scopeRows = [o];
  }
  const current = Number(o.ui_offset_min) || 0;
  const max_allowed = maxPlusAllowed(scopeRows, nowMs);
  if (off > 0 && off > current && off > max_allowed) {
    return { success: false, status: 409, error: "offset_exceeds_window", requested: off, max_allowed, current, contract: PRIORITY_CONTRACT };
  }
  if (o.manual_giro_id) {
    const w = await sbUpdate("ordenes", `manual_giro_id=eq.${enc(o.manual_giro_id)}`, { ui_offset_min: off });
    if (!mg.wrote(w)) return { success: false, status: 502, error: "db_write_failed", step: "block_offset", details: w };
    return { success: true, ui_offset_min: off, scope: "giro", giro_id: o.manual_giro_id, applied_to: scopeRows.map(x => x.id), max_allowed, contract: PRIORITY_CONTRACT };
  }
  const w = await sbUpdate("ordenes", `id=eq.${enc(orderId)}`, { ui_offset_min: off });
  if (!mg.wrote(w)) return { success: false, status: 502, error: "db_write_failed", step: "order_offset", details: w };
  return { success: true, ui_offset_min: off, scope: "order", applied_to: [orderId], max_allowed, contract: PRIORITY_CONTRACT };
}

// ── hard delete of an order: membership lives on the order row, the giro row stays →
//    recompute the giro it belonged to (no "giro monco", no stale anchor) ──
async function deleteOrderWithGiroRecompute(orderId) {
  const rows = await sbSelect("ordenes", `id=eq.${enc(orderId)}&select=id,manual_giro_id`);
  // fail-safe: if the membership cannot be read we could not recompute the giro afterwards → do not delete blind
  if (!Array.isArray(rows)) return { success: false, status: 502, error: "order_read_failed" };
  const giroId = rows[0] ? rows[0].manual_giro_id : null;
  const del = await sbDelete("ordenes", `id=eq.${enc(orderId)}`);
  if (!mg.wrote(del)) return { success: false, status: 502, error: "db_write_failed", step: "delete_order", details: del };
  let rec = null;
  if (giroId) { try { rec = await mg.recomputeManualGiro(giroId); } catch (_) { rec = null; } }
  // the order IS deleted (verified above); a failed recompute is reported, never turned into a 500 for a done delete
  return { success: true, giro_id: giroId, recompute: rec, ...(giroId && !(rec && rec.ok) ? { giro_recompute_pending: true } : {}) };
}

// ── Nuevo Pedido intent: AGGREGA (giro) / CREA GIRO (single order). Idempotent. ──
// Order stays a plain single order if anything fails: the caller reports, never throws.
async function applyGiroIntent(orderId, intent) {
  if (!intent || (!intent.giro_id && !intent.with_order_id)) return { applied: false, reason: "no_intent" };
  const rows = await sbSelect("ordenes", `id=eq.${enc(orderId)}&select=id,tipo_consegna,estado,zona,manual_giro_id`);
  const me = Array.isArray(rows) ? rows[0] : null;
  if (!me) return { applied: false, reason: "order_not_found" };

  if (intent.giro_id) {
    if (me.manual_giro_id === intent.giro_id) return { applied: true, no_op: true, giro_id: intent.giro_id };
    const gRows = await sbSelect("manual_giros", `id=eq.${enc(intent.giro_id)}&select=id,dissolved_at`);
    const g = Array.isArray(gRows) ? gRows[0] : null;
    if (!g || g.dissolved_at) return { applied: false, reason: "giro_not_found_or_dissolved" };
    const mem = ((await sbSelect("ordenes", `manual_giro_id=eq.${enc(g.id)}&select=id,estado,tipo_consegna,zona`)) || []).filter(mg.isOrderEligibleForGiro);
    if (mem.some(m => m.estado === "EN_ENTREGA")) return { applied: false, reason: "giro_departed" };
    const max = maxPerGiro(me.zona);
    if (max != null && mem.length + 1 > max) return { applied: false, reason: "capacity" };
    // [FDV1 ATOMIC] the reads above only give EARLY, readable reasons; capacity and "giro already left" are enforced again,
    // atomically with the write, inside giro_add_member_v1 (two AGGREGA can never both take the last seat).
    const r = await mg.addOrderToManualGiro(g.id, orderId, { maxMembers: max, blockDeparted: true });
    if (r && r.ok) return { applied: true, giro_id: g.id };
    const why = r && r.error;
    return { applied: false, reason: why === "giro_full" ? "capacity" : why === "giro_departed" ? "giro_departed" : (why || "add_failed") };
  }

  // CREA GIRO with an existing single order
  const tRows = await sbSelect("ordenes", `id=eq.${enc(intent.with_order_id)}&select=id,tipo_consegna,estado,zona,manual_giro_id`);
  const t = Array.isArray(tRows) ? tRows[0] : null;
  if (!t) return { applied: false, reason: "target_not_found" };
  // [FDV1 ATOMIC] The decision "is this suggestion still valid?" used to be taken from TWO client reads (me, then t) that could straddle a
  // concurrent create — an impossible "me free / t already in a giro" pair then produced a wrong refusal. It is now taken INSIDE the
  // database call: the same selection already forming one giro is an idempotent no-op; a member already in another alive giro
  // (stale suggestion) or already departed is refused, atomically with the write.
  const r = await mg.createManualGiro([t.id, orderId], null, null, null, { requireFree: true, blockDeparted: true });
  if (r && r.ok) return r.idempotent ? { applied: true, no_op: true, giro_id: r.giro.id } : { applied: true, giro_id: r.giro.id, seq: r.giro.seq };
  const why = r && r.error;
  if (why === "members_already_in_giro") return { applied: false, reason: (r.details || []).includes(t.id) ? "target_already_in_giro" : "order_already_in_giro" };
  if (why === "members_departed") return { applied: false, reason: "target_departed" };
  return { applied: false, reason: why || "create_failed" };
}

// ── create route composition (index.js createOrden around the unchanged-contract creaOrdine) ──
// [FDV1] delivery_deadline_at (ts + 55') is written by creaOrdine itself in the SAME insert, for every new DOMICILIO
// (dashboard AND WhatsApp). `hora` is the client promise and is passed through untouched: two separate data.
// This wrapper only strips the FE-only fields and applies the optional operator giro_intent.
async function createOrdenDeliveryV1(d, { creaOrdine }) {
  const payload = { ...d };
  delete payload.delivery_contract; delete payload.giro_intent;
  const res = await creaOrdine({ ...payload, operatorManual: true });
  if (!res || !res.success || !res.id) return res;
  let giro = null;
  if (d && d.giro_intent) {
    try { giro = await applyGiroIntentLocked(res.id, d.giro_intent); }
    catch (e) { giro = { applied: false, reason: "intent_error", message: e && e.message }; }
  }
  return giro ? { ...res, giro } : res;
}

// [CONTRACT PROTOTYPE] compound operations = read → decide → several giro mutations. They must hold the giro lock ONCE
// (re-entrant with the exported giro primitives), otherwise the decision is taken on a stale read (capacity, "already in
// giro", replay) even though every primitive is individually serialized.
const L = (fn) => (...a) => mg.withGiroLock(() => fn(...a));
const setPriorityOffsetLocked = L(setPriorityOffset);
const deleteOrderWithGiroRecomputeLocked = L(deleteOrderWithGiroRecompute);
const applyGiroIntentLocked = L(applyGiroIntent);

// ── preview core (new endpoint; no rider code imported) ──
function previewDeliveryCore({ newOrder, orders, giros, cfg, nowMs }) {
  const min = resolveDeadlineMin(cfg);
  const dl = computeAutoDeadline(nowMs, min);
  const probe = { ...newOrder, delivery_deadline_at: dl.deadlineIso };
  return {
    deadline_min: min,
    delivery_deadline_preview: dl.deadlineIso,
    hora_preview: dl.hora,
    giro_suggestion: suggestGiro({ newOrder: probe, orders, giros, cfg }),
  };
}

// ── [FDV1 LIVE wiring] read-only endpoints (P2 preview / P4a warnings). No rider code, no writes. ──
const ACTIVE_ROWS = `estado=in.(POR_CONFIRMAR,EN_COCINA,LISTO,EN_ENTREGA)&tipo_consegna=eq.DOMICILIO&select=id,manual_giro_id,estado,tipo_consegna,zona,delivery_deadline_at,hora,ts,created_at`;

// Nuevo Pedido (DOMICILIO): deadline preview (now + N) + "is there a compatible persisted giro / single order?".
async function previewDeliveryV1(body = {}, { cfg = {}, nowMs = Date.now() } = {}) {
  const newOrder = { tipo_consegna: "DOMICILIO", zona: body.zona || null, id: body.id || undefined };
  const [orders, giros] = await Promise.all([
    raw.sbSelect("ordenes", ACTIVE_ROWS),
    raw.sbSelect("manual_giros", "dissolved_at=is.null&select=id,seq,dissolved_at"),
  ]);
  if (!Array.isArray(orders) || !Array.isArray(giros)) return { ok: false, status: 502, error: "preview_read_failed" };
  const core = previewDeliveryCore({ newOrder, orders, giros, cfg, nowMs });
  const s = core.giro_suggestion;
  if (s && s.kind === "GIRO") { const g = giros.find(x => x.id === s.giro_id); s.label = g && g.seq != null ? `G${g.seq}` : null; }
  return { ok: true, ...core };
}

// Entregas: factual warnings for a composition (create: order_ids; add/move: giro_id + order_ids). Never blocking.
async function giroWarningsFor(body = {}, { cfg = {}, nowMs = Date.now() } = {}) {
  const ids = Array.from(new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map(String)));
  if (!ids.length && !body.giro_id) return { ok: false, status: 400, error: "missing_order_ids" };
  const COLS = "select=id,manual_giro_id,estado,tipo_consegna,zona,delivery_deadline_at,hora,ts,created_at";
  const [sel, mem] = await Promise.all([
    ids.length ? raw.sbSelect("ordenes", `id=in.(${mg.encodeIdList(ids)})&${COLS}`) : [],
    body.giro_id ? raw.sbSelect("ordenes", `manual_giro_id=eq.${enc(body.giro_id)}&${COLS}`) : [],
  ]);
  if (!Array.isArray(sel) || !Array.isArray(mem)) return { ok: false, status: 502, error: "warnings_read_failed" };
  const byId = new Map();
  for (const r of mem) if (mg.isOrderEligibleForGiro(r)) byId.set(r.id, r);
  for (const r of sel) byId.set(r.id, r);
  const members = [...byId.values()];
  return { ok: true, member_ids: members.map(m => m.id), warnings: evaluateGiroWarnings({ members, nowMs, cfg }) };
}

module.exports = { previewDeliveryV1, giroWarningsFor, setPriorityOffset: setPriorityOffsetLocked, deleteOrderWithGiroRecompute: deleteOrderWithGiroRecomputeLocked, applyGiroIntent: applyGiroIntentLocked, createOrdenDeliveryV1, previewDeliveryCore, OFFSET_MIN, OFFSET_MAX, PRIORITY_MARGIN_MIN, PRIORITY_CONTRACT, maxPlusAllowed };
