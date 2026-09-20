// ===============================================================
// manualGiros.js — P1C.1 of DELIVERY-MANUAL-GIRO-01
// ===============================================================
// Backend helpers for the persistent manual giro feature.
// Successor of the volatile UI-only prototype (frontend commit
// a8f97da). Data model approved 2026-05-25 (Option C: dedicated
// table public.manual_giros + denormalized FK ordenes.manual_giro_id).
//
// This module owns:
//   - id generation (mg_<yymmdd>_<seq>)
//   - per-day seq computation (Madrid TZ)
//   - eligibility / leaving-set checks
//   - create / add / remove / dissolve operations
//   - auto-dissolve when active member count drops below 2
//   - soft-dissolve hook for chiudiServizio
//   - read helper used by GET getManualGiros
//
// Scope discipline:
//   - This module MUST NOT touch ordenes.forno_out (Q4 BLOCKED,
//     P1C.2 only — see LaDieciBotV2_DELIVERY_MANUAL_GIRO_01BC_SPEC.md
//     §13). A simple grep `forno_out` inside this file must return
//     zero matches.
//   - This module MUST NOT write to public.storico or any analytics
//     table. Manual giros are operator overrides, kept out of training
//     by design (SPEC §14).
//   - This module exposes pure helpers at the top for easy unit
//     testing via require.cache supabase mock (see existing pattern
//     in tests/closingTimeGuard.test.js).
// ===============================================================

const sup = require("../utils/supabase");
const { madridDateStr } = require("../utils/servizio");
// [CONTRACT PROTOTYPE] deadline reader (pure, no DB)
const { getOrderDeadlineMs, formatMadridHHMM, minuteFloor } = require("../core/delivery/deadline");

// ─── Constants ───────────────────────────────────────────────────

// Orders are selectable for manual giro membership only while their
// estado is in this set. Anything outside means "leaving the giro"
// for the auto-dissolve hook in cambiaStato.
// [CONTRACT PROTOTYPE] POR_CONFIRMAR added: Nuevo Pedido can aggregate at creation.
const SELECTABLE_STATES = new Set(["POR_CONFIRMAR", "EN_COCINA", "LISTO", "EN_ENTREGA"]);
// Single source for the SQL list used by countActiveMembers (was hard-coded → trap).
const SELECTABLE_STATES_CSV = Array.from(SELECTABLE_STATES).join(",");
// Columns read for derived giro metadata. NO rider columns on purpose.
const MEMBER_COLS = "id,manual_giro_id,estado,tipo_consegna,zona,delivery_deadline_at,hora,ts,ui_offset_min";
const numId = (id) => parseInt(String(id).replace(/\D/g, ""), 10) || 0;

// Placeholder operator identifier. The schema stores created_by as
// text NULL without a DB default, so the placeholder lives here in
// the backend only. When per-operator login lands, this constant
// gets replaced by the real identifier with no DB change required
// (see SPEC §20 Q3).
const DEFAULT_CREATED_BY = "pin_dashboard";

// Race protection: number of retries when INSERT manual_giros hits
// the UNIQUE (giro_day, seq) constraint because a concurrent
// createManualGiro got the same MAX(seq)+1.
const SEQ_RETRY_MAX = 3;

// ─── [CONTRACT PROTOTYPE] single-process serialization of giro mutations ─────────────────────
// Why: the DB layer is PostgREST — every helper call is its own HTTP request/statement, there is no
// multi-statement transaction, so check-then-act sequences interleave. ALL giro mutations run inside
// this one backend process (dashboard routes, cambiaStato hook, service close), so a process-local
// async mutex serializes them at zero infrastructure cost.
//   • re-entrant (AsyncLocalStorage): compound ops (applyGiroIntent, delete+recompute…) hold it once;
//   • fail-open watchdog: sbFetch has NO timeout, so a hung request must never freeze giro edits
//     forever → after __lock.waitMaxMs (default 8000 ms, env GIRO_LOCK_WAIT_MAX_MS) a waiter proceeds unserialized (the recompute is
//     convergent, verify-after-write + reconcile below cover that degraded mode);
//   • does NOT cover a 2nd backend instance (deploy overlap / replicas>1): reconcile + derived-at-read do.
const { AsyncLocalStorage } = require("async_hooks");
const _lockCtx = new AsyncLocalStorage();
let _lockTail = Promise.resolve();
const __lock = { // [PROTOTYPE test hook] enabled=false simulates "no lock" (multi-instance); waitMaxMs lets the harness shrink the watchdog
  enabled: process.env.GIRO_LOCK !== "off",
  waitMaxMs: Number(process.env.GIRO_LOCK_WAIT_MAX_MS) || 8000,
  fetchTimeoutMs: null,   // [FDV1 test hook] shrinks the giro-path fetch timeout
};

function withGiroLock(fn) {
  if (!__lock.enabled || _lockCtx.getStore()) return fn(); // disabled, or re-entrant call from the holder
  const prev = _lockTail;
  let release;
  _lockTail = new Promise((r) => { release = r; });
  return (async () => {
    let timer;
    await Promise.race([prev, new Promise((r) => { timer = setTimeout(r, __lock.waitMaxMs); if (timer.unref) timer.unref(); })]);
    clearTimeout(timer);
    try { return await _lockCtx.run(true, fn); } finally { release(); }
  })();
}
const locked = (fn) => (...args) => withGiroLock(() => fn(...args));

// [CONTRACT PROTOTYPE] A failed PostgREST write does NOT throw: sbFetch returns the parsed error BODY (object) or a
// gateway string. A successful PATCH/DELETE (no return=representation) answers "" ; INSERT/return=representation an array.
// Every mutation below checks this BEFORE it (a) reports success or (b) issues a dependent mutation (fail-closed).
const wrote = (res) => res === "" || Array.isArray(res);
const wfail = (step, res) => ({ ok: false, status: 502, error: "db_write_failed", step, details: res });

// ─── [FDV1 ATOMIC] giro-path DB access ───────────────────────────────────────────────────────────────────────
// Timeout — LOCAL to this module. src/utils/supabase.js is shared with the WhatsApp bot and is NOT modified.
// A hung request rejects after GIRO_FETCH_TIMEOUT_MS (default 5000 ms, deliberately shorter than the lock watchdog) so
// the lock holder is released BEFORE waiters proceed unserialized. The underlying HTTP call may still complete
// server-side (a "lost response"); that is safe because every giro mutation is an idempotent database function:
// the honest answer (ok:false + outcome_unknown) plus a plain retry always converges.
const giroTimeoutMs = () => __lock.fetchTimeoutMs || Number(process.env.GIRO_FETCH_TIMEOUT_MS) || 5000;
function withGiroTimeout(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`giro_timeout:${what}`), { code: "GIRO_TIMEOUT" })), giroTimeoutMs());
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
const sbSelect = (...a) => withGiroTimeout(sup.sbSelect(...a), "select");
const sbInsert = (...a) => withGiroTimeout(sup.sbInsert(...a), "insert");
const sbUpdate = (...a) => withGiroTimeout(sup.sbUpdate(...a), "update");
const sbDelete = (...a) => withGiroTimeout(sup.sbDelete(...a), "delete");
const giroDb = { sbSelect, sbInsert, sbUpdate, sbDelete };   // same timeout for dashboardDelivery's giro-path reads/writes

// One PostgREST call to a plpgsql function (migrations/2026-09-19_fdv1_giro_atomic_v1.sql): ONE transaction, ONE advisory lock
// for the whole giro domain, read → validate → mutate → recompute → post-condition → typed answer. sbInsert is only the
// transport (POST /rest/v1/rpc/<fn>, body = named arguments). Never throws:
//   • typed answer            → returned as-is ({ok:true,…} | {ok:false,status,error,…})
//   • function not installed  → 503 giro_atomic_unavailable   (FAIL CLOSED: there is deliberately NO non-atomic fallback)
//   • timeout / network       → 504 giro_rpc_outcome_unknown   (the write may or may not have happened; retry is idempotent)
//   • any other error body    → 502 db_rpc_failed
async function giroRpc(fn, args) {
  let res;
  try { res = await sbInsert(`rpc/${fn}`, args); }
  catch (e) { return { ok: false, status: 504, error: "giro_rpc_outcome_unknown", outcome_unknown: true, message: e && e.message }; }
  if (res && typeof res === "object" && !Array.isArray(res) && typeof res.ok === "boolean") return res;
  if (res && typeof res === "object" && res.code === "PGRST202") return { ok: false, status: 503, error: "giro_atomic_unavailable", details: res };
  return { ok: false, status: 502, error: "db_rpc_failed", details: res };
}

// ─── Pure helpers (unit-testable without DB) ─────────────────────

// Format the public id: mg_<yymmdd>_<seq>. Example: mg_260525_3.
// Readable in logs, naturally scoped by service day.
function generateManualGiroId(giroDayIso, seq) {
  const yymmdd = String(giroDayIso || "").slice(2, 10).replace(/-/g, "");
  return `mg_${yymmdd}_${seq}`;
}

// Validates the operator-chosen operational time of a giro.
// Accepts "H:MM" / "HH:MM" 24h (00:00–23:59). null/undefined/"" are
// treated as "no operational time" and are valid (returns true) so the
// field stays optional and retro-compatible.
function isValidHoraRef(s) {
  if (s == null || s === "") return true;
  if (typeof s !== "string") return false;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

// Normalizes a valid hora_ref to canonical "HH:MM" (zero-padded). Pass
// only values that already passed isValidHoraRef. Empty → null.
function normalizeHoraRef(s) {
  if (s == null || s === "") return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

// Eligibility check used by validate + create + add. The order must
// be a DOMICILIO and currently in a state that the operator can act on.
function isOrderEligibleForGiro(o) {
  if (!o) return false;
  if (o.tipo_consegna !== "DOMICILIO") return false;
  return SELECTABLE_STATES.has(o.estado);
}

// "Is this status change moving the order out of any manual giro?"
// Used by the cambiaStato hook to decide whether to detach + auto-dissolve.
function isStatusLeavingGiro(nuovoStato) {
  if (!nuovoStato) return true;
  return !SELECTABLE_STATES.has(nuovoStato);
}

// PostgREST in.(…) literal builder for text ids that may contain
// special characters (e.g. "#001"). Each value is CSV-quoted for
// PostgREST and URL-encoded inside the quotes so "#" cannot become
// a URL fragment before the request reaches Supabase.
function encodeIdList(ids) {
  return (ids || [])
    .map(id => `"${encodeURIComponent(String(id).replace(/"/g, '""'))}"`)
    .join(",");
}

// PostgREST eq.<value> literal builder (URL-encoded).
function encodeEqValue(v) {
  return encodeURIComponent(String(v));
}

// ─── DB-touching helpers ─────────────────────────────────────────

// Returns the next seq for the given service day. Race-protected by
// the UNIQUE (giro_day, seq) constraint at INSERT time; this read is
// best-effort and may be stale, retry happens in createManualGiro.
async function nextSeqForDay(giroDayIso) {
  const rows = await sbSelect(
    "manual_giros",
    `giro_day=eq.${encodeURIComponent(giroDayIso)}&select=seq&order=seq.desc&limit=1`
  );
  const top = Array.isArray(rows) && rows[0] ? Number(rows[0].seq) : 0;
  return (Number.isFinite(top) ? top : 0) + 1;
}

// Validates that all requested order ids exist, are DOMICILIO and are
// in a selectable estado. Returns the eligible orders for further use
// and (importantly) collects prev_giro_ids for cleanup after the move.
//
// Note: orders that already have manual_giro_id set are still ELIGIBLE.
// P1A rule "move silent" is preserved — moving an order to a new giro
// is allowed. The caller is responsible for triggering auto-dissolve
// on any prev_giro_id afterwards.
async function validateManualGiroOrders(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length < 2) {
    return { ok: false, status: 400, error: "need_at_least_2_orders" };
  }
  const uniqIds = Array.from(new Set(orderIds.map(String)));
  if (uniqIds.length < 2) {
    return { ok: false, status: 400, error: "need_at_least_2_distinct_orders" };
  }

  const rows = await sbSelect(
    "ordenes",
    `id=in.(${encodeIdList(uniqIds)})&select=id,tipo_consegna,estado,manual_giro_id`
  );
  if (!Array.isArray(rows) || rows.length !== uniqIds.length) {
    return { ok: false, status: 400, error: "some_orders_not_found", expected: uniqIds.length, got: Array.isArray(rows) ? rows.length : 0 };
  }
  const invalid = rows.filter(o => !isOrderEligibleForGiro(o));
  if (invalid.length) {
    return { ok: false, status: 400, error: "invalid_orders", details: invalid.map(o => o.id) };
  }
  return { ok: true, orders: rows, uniqIds };
}

async function verifyOrdersAttachedToGiro(orderIds, giroId) {
  const rows = await sbSelect(
    "ordenes",
    `id=in.(${encodeIdList(orderIds)})&manual_giro_id=eq.${encodeEqValue(giroId)}&select=id,manual_giro_id`
  );
  return Array.isArray(rows) && rows.length === orderIds.length;
}

// Counts active members of a giro (members still in a selectable state).
async function countActiveMembers(giroId) {
  const rows = await sbSelect(
    "ordenes",
    `manual_giro_id=eq.${encodeEqValue(giroId)}&estado=in.(${SELECTABLE_STATES_CSV})&select=id`
  );
  return Array.isArray(rows) ? rows.length : 0;
}

// ─── [CONTRACT PROTOTYPE] canonical derived metadata + recompute ─────
// Pure: derives everything from the members' own rows. Never writes a deadline.
function deriveGiroMeta(rows) {
  const active = (rows || []).filter(isOrderEligibleForGiro);
  const notDeparted = active.filter(o => o.estado !== "EN_ENTREGA");
  const pool = notDeparted.length ? notDeparted : active;
  const withDl = pool.map(o => ({ o, dl: getOrderDeadlineMs(o) })).filter(x => x.dl != null);
  let anchor = null, minDl = null;
  if (withDl.length) {
    withDl.sort((a, b) =>
      (minuteFloor(a.dl) - minuteFloor(b.dl)) || (numId(a.o.id) - numId(b.o.id)) ||
      String(a.o.id).localeCompare(String(b.o.id)));
    anchor = withDl[0].o.id;
    minDl = withDl[0].dl;
  }
  return {
    active,
    member_ids: active.map(o => o.id),
    anchor_order_id: anchor,
    deadline_min_at: minDl == null ? null : new Date(minDl).toISOString(),
    entrega_ref: minDl == null ? null : formatMadridHHMM(minDl),     // compat copy, ALWAYS = min member deadline
    offset_min: active.length ? Math.min(...active.map(o => Number(o.ui_offset_min) || 0)) : 0, // most urgent
  };
}

// [FDV1 ATOMIC] The persisted compat copies (manual_giros.anchor_order_id / entrega_ref / hora_ref) are DERIVED from the members'
// deadlines; the truth is derived-at-read (getManualGiros). Refreshing them is convergent and NON-critical: a stale or failed copy is
// hidden by the read path and healed by reconcile. Guarded by dissolved_at=is.null, so it can never touch a dissolved giro.
// Never mutates after a failed read.
function copyPatch(giro, meta) {
  const patch = {};
  if ((giro.anchor_order_id || null) !== meta.anchor_order_id) patch.anchor_order_id = meta.anchor_order_id;
  if ((giro.entrega_ref || null) !== meta.entrega_ref) patch.entrega_ref = meta.entrega_ref;
  if (giro.hora_ref != null) patch.hora_ref = null; // retired: legacy operator-chosen time
  return patch;
}
async function refreshGiroCopies(giroId) {
  const gRows = await sbSelect("manual_giros", `id=eq.${encodeEqValue(giroId)}&select=id,dissolved_at,anchor_order_id,entrega_ref,hora_ref`);
  if (!Array.isArray(gRows)) return { ok: false, status: 502, error: "giro_read_failed" };
  const giro = gRows[0] || null;
  if (!giro) return { ok: false, status: 404, error: "giro_not_found" };
  if (giro.dissolved_at) return { ok: true, dissolved: true, no_op: true };
  const memberRows = await sbSelect("ordenes", `manual_giro_id=eq.${encodeEqValue(giroId)}&select=${MEMBER_COLS}`);
  if (!Array.isArray(memberRows)) return { ok: false, status: 502, error: "members_read_failed" };   // unreadable ≠ "zero members"
  const meta = deriveGiroMeta(memberRows);
  const patch = copyPatch(giro, meta);
  if (Object.keys(patch).length) {
    const r = await sbUpdate("manual_giros", `id=eq.${encodeEqValue(giroId)}&dissolved_at=is.null`, patch);
    if (!wrote(r)) return wfail("patch_giro_meta", r);
  }
  return { ok: true, dissolved: false, member_ids: meta.member_ids, anchor_order_id: meta.anchor_order_id,
    deadline_min_at: meta.deadline_min_at, entrega_ref: meta.entrega_ref, offset_min: meta.offset_min };
}

// [FDV1 ATOMIC] Canonical recompute — call after EVERY membership mutation. Idempotent.
// Membership/lifecycle is settled INSIDE the database (giro_settle_v1: heal links of a dissolved giro / detach ineligible members /
// <2 members ⇒ dissolve / null a stale anchor copy / align the shared block offset — one transaction, one lock), then the compat
// copies are refreshed. Never touches a deadline.
async function recomputeManualGiro(giroId) {
  if (!giroId) return { ok: false, status: 400, error: "missing_giro_id" };
  const s = await giroRpc("giro_settle_v1", { p_giro_id: String(giroId) });
  if (!s.ok) return s.status === 404 ? { ok: false, status: 404, error: "giro_not_found" } : s;
  if (s.dissolved) return s.no_op ? { ok: true, dissolved: true, no_op: true } : { ok: true, dissolved: true, member_ids: [] };
  let c;
  try { c = await refreshGiroCopies(giroId); } catch (e) { c = { ok: false, status: 502, error: "giro_copy_refresh_failed", message: e && e.message }; }
  if (!c.ok) return { ...c, membership_settled: true };
  if (c.dissolved) return { ok: true, dissolved: true, no_op: true };
  return { ok: true, dissolved: false, member_ids: s.member_ids, anchor_order_id: c.anchor_order_id,
    deadline_min_at: c.deadline_min_at, entrega_ref: c.entrega_ref, offset_min: s.offset_min };
}

// Auto-dissolves the giro if fewer than 2 active members remain.
// [CONTRACT PROTOTYPE] Same name + boolean contract as LIVE (agentOrdini's cambiaStato hook
// and servizio keep working untouched) but now delegates to the canonical recompute.
async function autoDissolveIfBelowThreshold(giroId) {
  if (!giroId) return false;
  const r = await recomputeManualGiro(giroId);
  return !!(r && r.ok && r.dissolved && !r.no_op);
}

// [FDV1 ATOMIC] Structural self-heal of the whole giro domain: links to dissolved/missing giros, giros with <2 members (incl. 0),
// ineligible members, stale anchor copy, block offset. It is ONE database transaction (giro_reconcile_v1): no stale-read window,
// so it can never detach a member that a concurrent request has just added. Afterwards the persisted compat copies are refreshed
// where they drifted (guarded PATCH). Idempotent and repeatable; writes only where a defect exists; never mutates after a failed read.
// opts.alignOffsets=false → structural repair only, no offset is rewritten (used at boot).
async function reconcileManualGiros({ alignOffsets = true } = {}) {
  const r = await giroRpc("giro_reconcile_v1", { p_align_offsets: !!alignOffsets });
  if (!r.ok) return r;
  const recomputed = new Set(r.recomputed || []);
  const failed = [];
  const alive = await sbSelect("manual_giros", "dissolved_at=is.null&select=id,anchor_order_id,entrega_ref,hora_ref");
  const links = await sbSelect("ordenes", `manual_giro_id=not.is.null&select=${MEMBER_COLS}`);
  if (!Array.isArray(alive) || !Array.isArray(links)) {
    return { ok: false, status: 502, error: "reconcile_read_failed", membership_reconciled: true, detached_orphans: r.detached_orphans, recomputed: [...recomputed].sort() };
  }
  const byGiro = new Map();
  for (const o of links) { if (!byGiro.has(o.manual_giro_id)) byGiro.set(o.manual_giro_id, []); byGiro.get(o.manual_giro_id).push(o); }
  for (const g of alive) {
    const patch = copyPatch(g, deriveGiroMeta(byGiro.get(g.id) || []));
    if (!Object.keys(patch).length) continue;
    const w = await sbUpdate("manual_giros", `id=eq.${encodeEqValue(g.id)}&dissolved_at=is.null`, patch);
    if (wrote(w)) recomputed.add(g.id); else failed.push(g.id);
  }
  return { ok: failed.length === 0, ...(failed.length ? { status: 502, error: "reconcile_incomplete", failed } : {}),
    detached_orphans: r.detached_orphans, recomputed: [...recomputed].sort() };
}

// [FDV1 ATOMIC] Create a manual giro from 2+ existing orders — ONE database call (giro_create_v1). "Move silent" is preserved:
// members of another giro move, and each previous giro that drops below 2 is dissolved in the SAME transaction. IDEMPOTENT: the same
// selection already forming one alive giro returns that giro (double click / replay / lost response never mint a second giro).
// Operator hora_ref / anchor / entrega_ref are RETIRED (accepted + validated, ignored); the compat copies are derived from the members.
async function createManualGiro(orderIds, horaRef = null, anchorOrderId = null, entregaRef = null, opts = {}) {
  if (!isValidHoraRef(horaRef)) {
    return { ok: false, status: 400, error: "invalid_hora_ref", details: horaRef };
  }
  if (!isValidHoraRef(entregaRef)) {
    return { ok: false, status: 400, error: "invalid_entrega_ref", details: entregaRef };
  }
  void anchorOrderId;
  const ids = Array.isArray(orderIds) ? orderIds.map(String) : [];
  const r = await giroRpc("giro_create_v1", {
    p_order_ids: ids, p_created_by: DEFAULT_CREATED_BY, p_giro_day: madridDateStr(),
    p_require_free: !!(opts && opts.requireFree), p_block_departed: !!(opts && opts.blockDeparted),   // atomic guards of the CREA GIRO intent
  });
  if (!r.ok) return r;
  let c = null;
  try { c = await refreshGiroCopies(r.giro.id); } catch (_) { c = null; }
  const derived = c && c.ok && !c.dissolved;
  return {
    ok: true,
    ...(r.idempotent ? { idempotent: true } : {}),
    giro: {
      id: r.giro.id, seq: r.giro.seq, giro_day: r.giro.giro_day, created_at: r.giro.created_at, created_by: r.giro.created_by,
      hora_ref: null,
      anchor_order_id: derived ? c.anchor_order_id : null,
      entrega_ref: derived ? c.entrega_ref : null,
      order_ids: Array.from(new Set(ids)),
    },
    moved_from: r.moved_from || [],
    // membership is committed (verified in the transaction); the compat copies could not be written now → derived-at-read + reconcile
    ...(derived ? {} : { giro_recompute_pending: true }),
  };
}

// [FDV1 ATOMIC] Add a single order to an existing giro (or MOVE it: "move silent") — ONE database call (giro_add_member_v1).
// Idempotent (already a member ⇒ no-op). opts.maxMembers / opts.blockDeparted make the capacity and "giro already left" guards atomic
// with the write (AGGREGA from Nuevo Pedido). The previous giro is settled in the same transaction.
async function addOrderToManualGiro(giroId, orderId, opts = {}) {
  if (!giroId || !orderId) {
    return { ok: false, status: 400, error: "missing_args" };
  }
  const r = await giroRpc("giro_add_member_v1", {
    p_giro_id: String(giroId), p_order_id: String(orderId),
    p_max_members: opts && opts.maxMembers != null ? Number(opts.maxMembers) : null,
    p_block_departed: !!(opts && opts.blockDeparted),
  });
  if (!r.ok) return r;
  let pending = false;
  const touched = [giroId, r.moved_from && r.moved_from !== giroId ? r.moved_from : null].filter(Boolean);
  for (const gid of touched) {
    try { const c = await refreshGiroCopies(gid); if (!c.ok) pending = true; } catch (_) { pending = true; }
  }
  if (r.no_op) return { ok: true, no_op: true, moved_from: null, ...(pending ? { giro_recompute_pending: true } : {}) };
  return { ok: true, moved_from: r.moved_from == null ? null : r.moved_from, auto_dissolved_prev: !!r.auto_dissolved_prev, ...(pending ? { giro_recompute_pending: true } : {}) };
}

// [FDV1 ATOMIC] Detach a single order from its giro and settle it — ONE database call (giro_remove_member_v1): the detach is
// conditional on the membership it read, and the giro is dissolved in the same transaction when it drops below 2 members.
// Idempotent: no-op if the order has no manual_giro_id.
async function removeOrderFromManualGiro(orderId) {
  if (!orderId) return { ok: false, status: 400, error: "missing_order_id" };
  const r = await giroRpc("giro_remove_member_v1", { p_order_id: String(orderId) });
  if (!r.ok) return r;
  if (r.no_op) return { ok: true, no_op: true, auto_dissolved: false };
  let pending = false;
  if (!r.auto_dissolved && r.giro_id) {
    try { const c = await refreshGiroCopies(r.giro_id); if (!c.ok) pending = true; } catch (_) { pending = true; }
  }
  // giro_recompute_pending: the order IS detached and the giro IS consistent; only the persisted compat copies are stale
  // (derived-at-read hides that; healed by reconcile / the next mutation).
  return { ok: true, auto_dissolved: !!r.auto_dissolved, ...(pending ? { giro_recompute_pending: true } : {}) };
}

// [FDV1 ATOMIC] Explicit dissolve — ONE database call (giro_dissolve_v1): detaches all members and soft-deletes the giro in one
// transaction. Idempotent.
async function dissolveManualGiro(giroId) {
  if (!giroId) return { ok: false, status: 400, error: "missing_giro_id" };
  const r = await giroRpc("giro_dissolve_v1", { p_giro_id: String(giroId) });
  return r.ok ? { ok: true } : r;
}

// Returns active (non-dissolved) giros for a given service day plus
// the order_ids belonging to each. Used by GET getManualGiros.
async function getManualGiros({ day, onlyActive = true } = {}) {
  // [CONTRACT PROTOTYPE] an ACTIVE giro is listed regardless of giro_day: crossing midnight
  // must not hide it. (Closing still soft-dissolves everything — untouched.)
  // The day filter is kept only for the historical listing (onlyActive=false) or when asked.
  let filter;
  if (onlyActive) filter = day ? `dissolved_at=is.null&giro_day=eq.${encodeURIComponent(day)}&` : "dissolved_at=is.null&";
  else filter = `giro_day=eq.${encodeURIComponent(day || madridDateStr())}&`;
  const giros = await sbSelect(
    "manual_giros",
    `${filter}select=id,seq,giro_day,created_at,created_by,dissolved_at,hora_ref,anchor_order_id,entrega_ref&order=seq.asc`
  );
  if (!Array.isArray(giros) || giros.length === 0) return [];

  const ids = giros.map(g => g.id);
  const orders = await sbSelect(
    "ordenes",
    `manual_giro_id=in.(${encodeIdList(ids)})&select=${MEMBER_COLS}`
  );
  const byGiro = {};
  if (Array.isArray(orders)) {
    for (const o of orders) {
      (byGiro[o.manual_giro_id] = byGiro[o.manual_giro_id] || []).push(o);
    }
  }
  // labels: G<seq>; if two ACTIVE giros share a seq (created on different calendar days) add the day
  const seqCount = {};
  for (const g of giros) seqCount[g.seq] = (seqCount[g.seq] || 0) + 1;
  const out = [];
  for (const g of giros) {
    const rows = byGiro[g.id] || [];
    const meta = deriveGiroMeta(rows);
    // safety net for the ACTIVE listing: a giro with <2 active members ("giro monco", a failed
    // dissolve, or a giro caught between INSERT and attach) is never shown as a giro
    if (onlyActive && meta.active.length < 2) continue;
    out.push({
      ...g,
      // derived-at-read: correct even if a persisted copy is stale (write races, old FE)
      anchor_order_id: meta.anchor_order_id !== null ? meta.anchor_order_id : g.anchor_order_id,
      entrega_ref: meta.entrega_ref !== null ? meta.entrega_ref : g.entrega_ref,
      order_ids: rows.map(o => o.id),
      member_ids: meta.member_ids,
      deadline_min_at: meta.deadline_min_at,
      offset_min: meta.offset_min,
      label: seqCount[g.seq] > 1 ? `G${g.seq}·${String(g.giro_day).slice(8, 10)}` : `G${g.seq}`,
    });
  }
  return out;
}

// Closure-time hook: soft-dissolve every still-active giro and detach
// every still-attached order. Called from chiudiServizio BEFORE the
// delete on ordenes. Best-effort: errors are surfaced in the return
// value but do not throw, so they don't break the closure flow.
async function softDissolveActiveManualGirosForClose() {
  const result = { detached_count: 0, dissolved_count: 0, errors: [] };
  try {
    const attachedRows = await sbSelect(
      "ordenes",
      "manual_giro_id=not.is.null&select=id"
    );
    result.detached_count = Array.isArray(attachedRows) ? attachedRows.length : 0;
    await sbUpdate(
      "ordenes",
      "manual_giro_id=not.is.null",
      { manual_giro_id: null }
    );
  } catch (e) {
    result.errors.push({ step: "detach_orders", message: e?.message || String(e) });
  }
  try {
    const activeGiros = await sbSelect(
      "manual_giros",
      "dissolved_at=is.null&select=id"
    );
    result.dissolved_count = Array.isArray(activeGiros) ? activeGiros.length : 0;
    await sbUpdate(
      "manual_giros",
      "dissolved_at=is.null",
      { dissolved_at: new Date().toISOString() }
    );
  } catch (e) {
    result.errors.push({ step: "soft_dissolve_giros", message: e?.message || String(e) });
  }
  return result;
}

module.exports = {
  // [CONTRACT PROTOTYPE] serialization + repair
  withGiroLock,
  wrote,
  __lock,
  // [FDV1 ATOMIC]
  giroDb,
  giroRpc,
  refreshGiroCopies,
  // pure helpers
  generateManualGiroId,
  isValidHoraRef,
  normalizeHoraRef,
  isOrderEligibleForGiro,
  isStatusLeavingGiro,
  encodeIdList,
  encodeEqValue,
  SELECTABLE_STATES,
  SELECTABLE_STATES_CSV,
  DEFAULT_CREATED_BY,
  // [CONTRACT PROTOTYPE]
  deriveGiroMeta,
  recomputeManualGiro: locked(recomputeManualGiro),
  reconcileManualGiros: locked(reconcileManualGiros),
  // db helpers
  nextSeqForDay,
  validateManualGiroOrders,
  countActiveMembers,
  autoDissolveIfBelowThreshold: locked(autoDissolveIfBelowThreshold),
  // public operations
  createManualGiro: locked(createManualGiro),
  addOrderToManualGiro: locked(addOrderToManualGiro),
  removeOrderFromManualGiro: locked(removeOrderFromManualGiro),
  dissolveManualGiro: locked(dissolveManualGiro),
  getManualGiros,
  softDissolveActiveManualGirosForClose, // closure hook: deliberately UNCHANGED and NOT under the giro lock (service-close is out of scope of Frozen Delivery V1)
};

// [FDV1] Boot self-heal, scheduled from THIS module so that index.js (the WhatsApp webhook host) stays untouched.
// One structural reconcile a few seconds after the server starts: giro_reconcile_v1 is ONE database transaction, idempotent, and only
// touches links to dissolved giros, giros with <2 members, ineligible members and stale anchor copies — never a healthy giro — and
// rewrites NO offset (alignOffsets:false). It runs ONLY when the process entry point is index.js (never under tests / scripts) and can be
// switched off with GIRO_BOOT_RECONCILE=off. Fail-safe: any error (e.g. the FDV1 migration is not applied yet → 503
// giro_atomic_unavailable) is logged and ignored — it can never block or crash the boot.
if (require.main && /(^|[\\/])index\.js$/.test(require.main.filename || "") && process.env.GIRO_BOOT_RECONCILE !== "off") {
  const _giroBoot = setTimeout(() => {
    locked(reconcileManualGiros)({ alignOffsets: false })
      .then((r) => console.log("[manualGiros] boot reconcile:", JSON.stringify({ ok: !!(r && r.ok), error: r && r.error, detached_orphans: r && r.detached_orphans, recomputed: r && r.recomputed })))
      .catch((e) => console.warn("[manualGiros] boot reconcile failed:", e && e.message ? e.message : e));
  }, Number(process.env.GIRO_BOOT_RECONCILE_DELAY_MS) || 5000);
  if (_giroBoot.unref) _giroBoot.unref();
}
