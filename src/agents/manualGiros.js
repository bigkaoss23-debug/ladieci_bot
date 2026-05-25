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

const { sbSelect, sbInsert, sbUpdate, sbDelete } = require("../utils/supabase");
const { madridDateStr } = require("../utils/servizio");

// ─── Constants ───────────────────────────────────────────────────

// Orders are selectable for manual giro membership only while their
// estado is in this set. Anything outside means "leaving the giro"
// for the auto-dissolve hook in cambiaStato.
const SELECTABLE_STATES = new Set(["EN_COCINA", "LISTO", "EN_ENTREGA"]);

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

// ─── Pure helpers (unit-testable without DB) ─────────────────────

// Format the public id: mg_<yymmdd>_<seq>. Example: mg_260525_3.
// Readable in logs, naturally scoped by service day.
function generateManualGiroId(giroDayIso, seq) {
  const yymmdd = String(giroDayIso || "").slice(2, 10).replace(/-/g, "");
  return `mg_${yymmdd}_${seq}`;
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
    `manual_giro_id=eq.${encodeEqValue(giroId)}&estado=in.(EN_COCINA,LISTO,EN_ENTREGA)&select=id`
  );
  return Array.isArray(rows) ? rows.length : 0;
}

// Auto-dissolves the giro if fewer than 2 active members remain.
// Returns true if dissolved by this call, false otherwise (including
// no-op when the giro was already dissolved or still has >= 2 active).
//
// Idempotent: safe to call multiple times.
async function autoDissolveIfBelowThreshold(giroId) {
  if (!giroId) return false;
  const count = await countActiveMembers(giroId);
  if (count >= 2) return false;

  // Detach any leftover orders pointing to this giro (covers orders
  // that are in non-selectable states but still reference the giro).
  await sbUpdate(
    "ordenes",
    `manual_giro_id=eq.${encodeEqValue(giroId)}`,
    { manual_giro_id: null }
  );
  // Soft-dissolve. Conditional on dissolved_at IS NULL keeps this
  // idempotent across concurrent callers.
  await sbUpdate(
    "manual_giros",
    `id=eq.${encodeEqValue(giroId)}&dissolved_at=is.null`,
    { dissolved_at: new Date().toISOString() }
  );
  return true;
}

// Create a manual giro from 2+ existing orders. Implements the
// approved "move silent" rule: orders already belonging to another
// giro are moved into the new one, and each previous giro is checked
// for auto-dissolve after the move so we never leave orphans.
async function createManualGiro(orderIds) {
  const valid = await validateManualGiroOrders(orderIds);
  if (!valid.ok) return valid;

  // Collect distinct prev giro ids for post-move cleanup.
  const prevGiroIds = Array.from(new Set(
    valid.orders.map(o => o.manual_giro_id).filter(Boolean)
  ));

  // Generate id with retry on UNIQUE (giro_day, seq) violation.
  const giroDay = madridDateStr();
  let inserted = null;
  let lastErr = null;
  for (let attempt = 0; attempt < SEQ_RETRY_MAX; attempt++) {
    const seq = await nextSeqForDay(giroDay);
    const id = generateManualGiroId(giroDay, seq);
    const res = await sbInsert("manual_giros", {
      id,
      seq,
      giro_day: giroDay,
      created_by: DEFAULT_CREATED_BY
    });
    if (Array.isArray(res) && res.length > 0) {
      inserted = res[0];
      break;
    }
    lastErr = res;
    const code = res?.code || (Array.isArray(res) && res[0]?.code) || null;
    if (code !== "23505") break; // not a unique-violation: give up
  }
  if (!inserted) {
    return { ok: false, status: 500, error: "create_failed", details: lastErr };
  }

  // Attach all orders (overwriting any existing manual_giro_id).
  const attachRes = await sbUpdate(
    "ordenes",
    `id=in.(${encodeIdList(valid.uniqIds)})`,
    { manual_giro_id: inserted.id }
  );
  const attached = Array.isArray(attachRes)
    ? attachRes.length === valid.uniqIds.length
    : await verifyOrdersAttachedToGiro(valid.uniqIds, inserted.id);
  if (!attached) {
    // Rollback: detach anything that may have been partially updated,
    // then hard-delete the just-inserted giro.
    await sbUpdate("ordenes", `manual_giro_id=eq.${encodeEqValue(inserted.id)}`, { manual_giro_id: null }).catch(() => {});
    await sbDelete("manual_giros", `id=eq.${encodeEqValue(inserted.id)}`).catch(() => {});
    return { ok: false, status: 500, error: "attach_failed", details: attachRes };
  }

  // Best-effort auto-dissolve on every prev giro that may now be
  // orphaned. Distinct from new giro id (defensive, prev should never
  // equal inserted.id but the check is cheap).
  for (const prev of prevGiroIds) {
    if (prev !== inserted.id) {
      try {
        await autoDissolveIfBelowThreshold(prev);
      } catch (e) {
        console.warn(`[manualGiros] autoDissolve prev ${prev} after createManualGiro failed:`, e?.message || e);
      }
    }
  }

  return {
    ok: true,
    giro: {
      id: inserted.id,
      seq: inserted.seq,
      giro_day: inserted.giro_day,
      created_at: inserted.created_at,
      created_by: inserted.created_by,
      order_ids: valid.uniqIds
    },
    moved_from: prevGiroIds.filter(p => p !== inserted.id)
  };
}

// Add a single order to an existing giro. If the order was already in
// another giro, move-silent semantics apply and the prev giro is
// checked for auto-dissolve.
async function addOrderToManualGiro(giroId, orderId) {
  if (!giroId || !orderId) {
    return { ok: false, status: 400, error: "missing_args" };
  }
  // Verify giro is alive.
  const giroRows = await sbSelect(
    "manual_giros",
    `id=eq.${encodeEqValue(giroId)}&select=id,dissolved_at`
  );
  const giro = Array.isArray(giroRows) ? giroRows[0] : null;
  if (!giro || giro.dissolved_at) {
    return { ok: false, status: 404, error: "giro_not_found_or_dissolved" };
  }

  // Verify order is eligible.
  const ordRows = await sbSelect(
    "ordenes",
    `id=eq.${encodeEqValue(orderId)}&select=id,tipo_consegna,estado,manual_giro_id`
  );
  const order = Array.isArray(ordRows) ? ordRows[0] : null;
  if (!order) return { ok: false, status: 404, error: "order_not_found" };
  if (!isOrderEligibleForGiro(order)) {
    return { ok: false, status: 400, error: "order_not_eligible" };
  }

  const prevGiroId = order.manual_giro_id || null;
  if (prevGiroId === giroId) {
    return { ok: true, no_op: true, moved_from: null };
  }

  const updRes = await sbUpdate(
    "ordenes",
    `id=eq.${encodeEqValue(orderId)}`,
    { manual_giro_id: giroId }
  );
  const attached = Array.isArray(updRes)
    ? updRes.length > 0
    : await verifyOrdersAttachedToGiro([orderId], giroId);
  if (!attached) {
    return { ok: false, status: 500, error: "attach_failed", details: updRes };
  }

  let auto = false;
  if (prevGiroId && prevGiroId !== giroId) {
    try {
      auto = await autoDissolveIfBelowThreshold(prevGiroId);
    } catch (e) {
      console.warn(`[manualGiros] autoDissolve prev ${prevGiroId} after addOrder failed:`, e?.message || e);
    }
  }

  return { ok: true, moved_from: prevGiroId, auto_dissolved_prev: auto };
}

// Detach a single order from its giro and run the auto-dissolve check.
// Idempotent: no-op if the order has no manual_giro_id.
async function removeOrderFromManualGiro(orderId) {
  if (!orderId) return { ok: false, status: 400, error: "missing_order_id" };

  const ordRows = await sbSelect(
    "ordenes",
    `id=eq.${encodeEqValue(orderId)}&select=id,manual_giro_id`
  );
  const order = Array.isArray(ordRows) ? ordRows[0] : null;
  if (!order) return { ok: false, status: 404, error: "order_not_found" };
  if (!order.manual_giro_id) return { ok: true, no_op: true, auto_dissolved: false };

  const prevGiroId = order.manual_giro_id;
  await sbUpdate(
    "ordenes",
    `id=eq.${encodeEqValue(orderId)}`,
    { manual_giro_id: null }
  );

  let auto = false;
  try {
    auto = await autoDissolveIfBelowThreshold(prevGiroId);
  } catch (e) {
    console.warn(`[manualGiros] autoDissolve prev ${prevGiroId} after removeOrder failed:`, e?.message || e);
  }
  return { ok: true, auto_dissolved: auto };
}

// Explicit dissolve. Detaches all member orders and soft-deletes the
// giro. Idempotent.
async function dissolveManualGiro(giroId) {
  if (!giroId) return { ok: false, status: 400, error: "missing_giro_id" };

  await sbUpdate(
    "ordenes",
    `manual_giro_id=eq.${encodeEqValue(giroId)}`,
    { manual_giro_id: null }
  );
  await sbUpdate(
    "manual_giros",
    `id=eq.${encodeEqValue(giroId)}&dissolved_at=is.null`,
    { dissolved_at: new Date().toISOString() }
  );
  return { ok: true };
}

// Returns active (non-dissolved) giros for a given service day plus
// the order_ids belonging to each. Used by GET getManualGiros.
async function getManualGiros({ day, onlyActive = true } = {}) {
  const giroDay = day || madridDateStr();
  const filter = onlyActive ? "dissolved_at=is.null&" : "";
  const giros = await sbSelect(
    "manual_giros",
    `${filter}giro_day=eq.${encodeURIComponent(giroDay)}&select=id,seq,giro_day,created_at,created_by,dissolved_at&order=seq.asc`
  );
  if (!Array.isArray(giros) || giros.length === 0) return [];

  const ids = giros.map(g => g.id);
  const orders = await sbSelect(
    "ordenes",
    `manual_giro_id=in.(${encodeIdList(ids)})&select=id,manual_giro_id`
  );
  const byGiro = {};
  if (Array.isArray(orders)) {
    for (const o of orders) {
      (byGiro[o.manual_giro_id] = byGiro[o.manual_giro_id] || []).push(o.id);
    }
  }
  return giros.map(g => ({ ...g, order_ids: byGiro[g.id] || [] }));
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
  // pure helpers
  generateManualGiroId,
  isOrderEligibleForGiro,
  isStatusLeavingGiro,
  encodeIdList,
  encodeEqValue,
  SELECTABLE_STATES,
  DEFAULT_CREATED_BY,
  // db helpers
  nextSeqForDay,
  validateManualGiroOrders,
  countActiveMembers,
  autoDissolveIfBelowThreshold,
  // public operations
  createManualGiro,
  addOrderToManualGiro,
  removeOrderFromManualGiro,
  dissolveManualGiro,
  getManualGiros,
  softDissolveActiveManualGirosForClose,
};
