"use strict";
// ===============================================================
// TEST SUPPORT ONLY — never required by production code.
// JS reference model of migrations/2026-09-19_fdv1_giro_atomic_v1.sql (the FDV1 atomic giro functions).
//
// Fake databases (tests/manualGiros.test.js, the external concurrency harness) route
// `POST /rest/v1/rpc/giro_*` to apply() so the backend's real code path runs against a faithful, ATOMIC
// (one synchronous call = one transaction) implementation of the same semantics. The model is kept honest by
// the differential test on a real PostgreSQL 17 (random operation sequences, model vs SQL, state + answers).
//
// Contract of createGiroRpcModel({ tables, now, madridToday, onWrite }):
//   tables(name) -> mutable array of row objects ("ordenes", "manual_giros")
//   onWrite(table, keys) -> called for every UPDATE column set written (write-set audits)
//   onInsert(table, row)  -> called for the one INSERT (a new manual_giros row)
// ===============================================================

const ELIGIBLE_STATES = ["POR_CONFIRMAR", "EN_COCINA", "LISTO", "EN_ENTREGA"];
const eligible = (o) => !!o && o.tipo_consegna === "DOMICILIO" && ELIGIBLE_STATES.includes(o.estado);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const err = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

function createGiroRpcModel({ tables, now = () => new Date().toISOString(), madridToday = () => new Date().toISOString().slice(0, 10), onWrite = () => {}, onInsert = () => {} }) {
  const O = () => tables("ordenes");
  const G = () => tables("manual_giros");
  const setLink = (rows, val) => { for (const r of rows) r.manual_giro_id = val; if (rows.length) onWrite("ordenes", ["manual_giro_id"]); return rows.length; };
  const giroOut = (g, ids) => ({ id: g.id, seq: g.seq, giro_day: g.giro_day, created_at: g.created_at, created_by: g.created_by,
    hora_ref: g.hora_ref == null ? null : g.hora_ref, anchor_order_id: g.anchor_order_id == null ? null : g.anchor_order_id,
    entrega_ref: g.entrega_ref == null ? null : g.entrega_ref, order_ids: ids });

  function settle(giroId, align = true) {
    if (giroId == null) return err(400, "missing_giro_id");
    const g = G().find((x) => x.id === giroId);
    if (!g) return err(404, "giro_not_found");
    if (g.dissolved_at) {                                     // a dissolved giro owns no members
      const n = setLink(O().filter((o) => o.manual_giro_id === giroId), null);
      return { ok: true, dissolved: true, no_op: true, changed: n > 0, member_ids: [] };
    }
    let changed = setLink(O().filter((o) => o.manual_giro_id === giroId && !eligible(o)), null) > 0;
    const members = O().filter((o) => o.manual_giro_id === giroId).map((o) => o.id).sort(cmp);
    if (members.length < 2) {
      setLink(O().filter((o) => o.manual_giro_id === giroId), null);
      g.dissolved_at = now(); onWrite("manual_giros", ["dissolved_at"]);
      return { ok: true, dissolved: true, changed: true, member_ids: [] };
    }
    if (g.anchor_order_id != null && !members.includes(g.anchor_order_id)) { g.anchor_order_id = null; onWrite("manual_giros", ["anchor_order_id"]); changed = true; }
    const rows = O().filter((o) => o.manual_giro_id === giroId);
    const off = Math.min(...rows.map((o) => Number(o.ui_offset_min) || 0));
    if (align) {
      const drift = rows.filter((o) => (Number(o.ui_offset_min) || 0) !== off);
      for (const o of drift) o.ui_offset_min = off;
      if (drift.length) { onWrite("ordenes", ["ui_offset_min"]); changed = true; }
    }
    return { ok: true, dissolved: false, changed, member_ids: members, offset_min: off };
  }

  function create(orderIds, by = "pin_dashboard", day = null, requireFree = false, blockDeparted = false) {
    if (!Array.isArray(orderIds) || orderIds.length < 2) return err(400, "need_at_least_2_orders");
    const ids = Array.from(new Set(orderIds.map(String))).sort(cmp);
    if (ids.length < 2) return err(400, "need_at_least_2_distinct_orders");
    const rows = O().filter((o) => ids.includes(o.id));
    if (rows.length !== ids.length) return err(400, "some_orders_not_found", { expected: ids.length, got: rows.length });
    const bad = rows.filter((o) => !eligible(o)).map((o) => o.id).sort(cmp);
    if (bad.length) return err(400, "invalid_orders", { details: bad });

    const gids = new Set(rows.map((o) => o.manual_giro_id || ""));
    if (gids.size === 1 && rows[0].manual_giro_id) {          // IDEMPOTENCY: same selection already ONE alive giro
      const g = G().find((x) => x.id === rows[0].manual_giro_id);
      if (g && !g.dissolved_at) {
        const act = O().filter((o) => o.manual_giro_id === g.id && eligible(o)).map((o) => o.id).sort(cmp);
        if (act.length === ids.length && act.every((x, i) => x === ids[i])) return { ok: true, idempotent: true, moved_from: [], giro: giroOut(g, ids) };
      }
    }
    if (requireFree) {
      const inGiro = rows.filter((o) => o.manual_giro_id && G().some((g) => g.id === o.manual_giro_id && !g.dissolved_at)).map((o) => o.id).sort(cmp);
      if (inGiro.length) return err(409, "members_already_in_giro", { details: inGiro });
    }
    if (blockDeparted && rows.some((o) => o.estado === "EN_ENTREGA")) return err(409, "members_departed");
    const d = day || madridToday();
    const seq = Math.max(0, ...G().filter((g) => g.giro_day === d).map((g) => Number(g.seq))) + 1;
    const id = "mg_" + String(d).slice(2, 10).replace(/-/g, "") + "_" + seq;
    const g = { id, seq, giro_day: d, created_at: now(), created_by: by, dissolved_at: null, hora_ref: null, anchor_order_id: null, entrega_ref: null };
    G().push(g); onInsert("manual_giros", { ...g });
    const prev = Array.from(new Set(rows.map((o) => o.manual_giro_id).filter(Boolean))).sort(cmp);
    setLink(rows, id);
    for (const p of prev) settle(p);
    settle(id);
    const held = O().filter((o) => o.manual_giro_id === id && eligible(o)).length;
    if (held !== ids.length || g.dissolved_at) throw Object.assign(new Error(`FDV1_GIRO_ATOMIC post-condition failed: create ${id}`), { pgcode: "P0001" });
    return { ok: true, moved_from: prev, giro: giroOut(g, ids) };
  }

  function add(giroId, orderId, maxMembers = null, blockDeparted = false) {
    if (giroId == null || orderId == null) return err(400, "missing_args");
    const g = G().find((x) => x.id === giroId);
    if (!g || g.dissolved_at) return err(404, "giro_not_found_or_dissolved");
    const o = O().find((x) => x.id === orderId);
    if (!o) return err(404, "order_not_found");
    if (!eligible(o)) return err(400, "order_not_eligible");
    if (o.manual_giro_id === giroId) { settle(giroId); return { ok: true, no_op: true, moved_from: null }; }
    const members = O().filter((m) => m.manual_giro_id === giroId && eligible(m));
    if (blockDeparted && members.some((m) => m.estado === "EN_ENTREGA")) return err(409, "giro_departed");
    if (members.length < 1) return err(409, "giro_changed_during_add");
    if (maxMembers != null && members.length + 1 > maxMembers) return err(409, "giro_full", { max: maxMembers });
    const prev = o.manual_giro_id == null ? null : o.manual_giro_id;
    setLink([o], giroId);
    const pr = prev ? settle(prev) : null;
    settle(giroId);
    const gg = G().find((x) => x.id === giroId);
    if (!(o.manual_giro_id === giroId && gg && !gg.dissolved_at && eligible(o))) throw Object.assign(new Error(`FDV1_GIRO_ATOMIC post-condition failed: add ${orderId} -> ${giroId}`), { pgcode: "P0001" });
    return { ok: true, moved_from: prev, auto_dissolved_prev: !!(pr && pr.dissolved && !pr.no_op) };
  }

  function remove(orderId) {
    if (orderId == null) return err(400, "missing_order_id");
    const o = O().find((x) => x.id === orderId);
    if (!o) return err(404, "order_not_found");
    if (o.manual_giro_id == null) return { ok: true, no_op: true, auto_dissolved: false };
    const prev = o.manual_giro_id;
    setLink([o], null);
    const r = settle(prev);
    if (o.manual_giro_id != null) throw Object.assign(new Error(`FDV1_GIRO_ATOMIC post-condition failed: remove ${orderId}`), { pgcode: "P0001" });
    return { ok: true, giro_id: prev, auto_dissolved: !!(r && r.dissolved && !r.no_op) };
  }

  function dissolve(giroId) {
    if (giroId == null) return err(400, "missing_giro_id");
    setLink(O().filter((o) => o.manual_giro_id === giroId), null);
    const g = G().find((x) => x.id === giroId);
    if (g && !g.dissolved_at) { g.dissolved_at = now(); onWrite("manual_giros", ["dissolved_at"]); }
    return { ok: true };
  }

  function reconcile(align = true) {
    const orphans = O().filter((o) => o.manual_giro_id != null && !G().some((g) => g.id === o.manual_giro_id && !g.dissolved_at));
    setLink(orphans, null);
    const recomputed = [];
    for (const g of G().filter((x) => !x.dissolved_at).sort((a, b) => cmp(a.id, b.id))) { const r = settle(g.id, align); if (r && r.changed) recomputed.push(g.id); }
    return { ok: true, detached_orphans: orphans.length, recomputed };
  }

  // Transaction wrapper: a thrown post-condition rolls EVERYTHING back (as RAISE EXCEPTION does in the database).
  // Only the columns a transaction can change are snapshotted (never a whole row: rows may carry read-trap accessors).
  function apply(fn, a = {}) {
    const snapO = new Map(O().map((r) => [r.id, { manual_giro_id: r.manual_giro_id, ui_offset_min: r.ui_offset_min }]));
    const snapG = new Map(G().map((r) => [r.id, { dissolved_at: r.dissolved_at, anchor_order_id: r.anchor_order_id }]));
    try {
      switch (fn) {
        case "giro_create_v1": return create(a.p_order_ids, a.p_created_by, a.p_giro_day, !!a.p_require_free, !!a.p_block_departed);
        case "giro_add_member_v1": return add(a.p_giro_id, a.p_order_id, a.p_max_members == null ? null : a.p_max_members, !!a.p_block_departed);
        case "giro_remove_member_v1": return remove(a.p_order_id);
        case "giro_dissolve_v1": return dissolve(a.p_giro_id);
        case "giro_settle_v1": return settle(a.p_giro_id, a.p_align_offsets !== false);
        case "giro_reconcile_v1": return reconcile(a.p_align_offsets !== false);
        default: return { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` };
      }
    } catch (e) {
      for (const r of O()) { const s0 = snapO.get(r.id); if (s0) { r.manual_giro_id = s0.manual_giro_id; r.ui_offset_min = s0.ui_offset_min; } }
      const arr = G(); for (let i = arr.length - 1; i >= 0; i--) if (!snapG.has(arr[i].id)) arr.splice(i, 1);
      for (const r of arr) { const s0 = snapG.get(r.id); if (s0) { r.dissolved_at = s0.dissolved_at; r.anchor_order_id = s0.anchor_order_id; } }
      return { code: e.pgcode || "P0001", message: String(e.message) };   // PostgREST error body
    }
  }

  return { apply, settle, create, add, remove, dissolve, reconcile, eligible };
}

module.exports = { createGiroRpcModel, ELIGIBLE_STATES, eligible };
