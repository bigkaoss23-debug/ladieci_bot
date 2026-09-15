// ===============================================================
// manualGiros.js — P1C.1 of DELIVERY-MANUAL-GIRO-01
// ===============================================================
// Backend helpers for the persistent manual giro feature.
// Successor of the volatile UI-only prototype (frontend commit
// a8f97da). Data model approved 2026-05-25 (Option C: dedicated
// table public.manual_giros + denormalized FK ordenes.manual_giro_id).
//
// W5 Packet 01 — SINGLE-WRITER CUTOVER. The four public mutation actions
// (create/add/remove/dissolve) below no longer write ordenes.manual_giro_id or
// manual_giros membership/state directly: each is now a thin mapper onto the
// SECURITY DEFINER Giro Authority commands (migration 131), which are the sole
// writer of canonical Giro facts (membership, giro_state, hora_ref, dissolved).
// Two composite commands (giro_authority_create_or_move_v1,
// giro_authority_attach_or_move_v1) exist specifically so each logical mutation
// here is exactly ONE atomic RPC -- never a JS-orchestrated
// detach-then-create/attach-then-inspect-then-move sequence. Legacy
// non-canonical metadata the Authority does not model (entrega_ref, the
// display-format anchor_order_id) stays a narrow, best-effort raw write on
// manual_giros -- it can never override a canonical fact (see
// manualGiroReads.js's own narrow enrichment on the read side).
//
// isStatusLeavingGiro/autoDissolveIfBelowThreshold/countActiveMembers stay
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
// byte-identical and exported: the writer dispatcher's status-change handler
// (forbidden file, untouched) still imports and calls autoDissolveIfBelowThreshold
// directly. Post-cutover this call is a self-neutralizing vestige -- see
// tests/manualGirosW5Packet01.test.js's AGENTORDINI_POST_CUTOVER_SELF_NEUTRALIZATION
// proof: nothing populates ordenes.manual_giro_id anymore, so it only ever
// touches pre-cutover legacy rows the Authority was already blind to.
//
// This module still owns:
//   - id generation (mg_<yymmdd>_<seq>) — pure helper, kept for format tests
//   - eligibility / leaving-set checks
//   - the four writer mappers (create / add / remove / dissolve)
// language-guard: allow-legacy agentOrdini.js/chiudiServizio are the existing file/function names being cited, not new vocabulary
//   - the legacy auto-dissolve/countActiveMembers pair (agentOrdini.js dependency only)
//   - soft-dissolve hook for the legacy nightly-close writer (already unreachable — see below)
//   - read helper used by GET getManualGiros (Packet 02B, unchanged)
//
// Scope discipline:
//   - This module MUST NOT touch ordenes.forno_out (Q4 BLOCKED,
//     P1C.2 only — see LaDieciBotV2_DELIVERY_MANUAL_GIRO_01BC_SPEC.md
//     §13). A simple grep `forno_out` inside this file must return
//     zero matches.
//   - This module MUST NOT write to public.storico or any analytics
//     table. Manual giros are operator overrides, kept out of training
//     by design (SPEC §14).
// ===============================================================

const { sbSelect, sbUpdate, sbRpc } = require("../utils/supabase");
const { getOperationalSessionIds } = require("../serviceSessions/currentOperationalSession");
// W4 Packet 02B — getManualGiros() below is a thin delegate onto
// manualGiroReads.js's canonical-current/historical-explicit split.
const { getManualGirosRead } = require("./manualGiroReads");

// ─── Constants ───────────────────────────────────────────────────

// Orders are selectable for manual giro membership only while their
// estado is in this set. Anything outside means "leaving the giro"
// for the auto-dissolve hook in cambiaStato.
const SELECTABLE_STATES = new Set(["EN_COCINA", "LISTO", "EN_ENTREGA"]);

// Placeholder operator identifier, also used as the Authority p_actor. The
// schema stores created_by as text NULL without a DB default, so the
// placeholder lives here in the backend only. When per-operator login lands,
// this constant gets replaced by the real identifier with no DB change
// required (see SPEC §20 Q3).
const DEFAULT_CREATED_BY = "pin_dashboard";

// ─── Pure helpers (unit-testable without DB) ─────────────────────

// Format the public id: mg_<yymmdd>_<seq>. Example: mg_260525_3.
// Readable in logs, naturally scoped by service day. The Authority's own
// insert_giro_v1 generates ids in this exact format server-side now; kept
// here as a pure, independently-testable format reference.
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

// Eligibility check. The order must be a DOMICILIO and currently in a state
// the operator can act on. Still used by isStatusLeavingGiro's sibling
// checks and by legacy-support code; the Authority does its own, independent
// eligibility validation server-side for every command now.
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

// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
// ─── Legacy support (agentOrdini.js dependency — DO NOT REMOVE) ──

// Counts active members of a giro (members still in a selectable state).
// Only reachable now via autoDissolveIfBelowThreshold, which only fires on
// language-guard: allow-legacy agentOrdini.js/cambiaStato are the existing file/function names being cited, not new vocabulary
// legacy manual_giro_id values agentOrdini.js's cambiaStato() still reads —
// see the file header for why this is a proven no-op on Authority-created data.
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
// Idempotent: safe to call multiple times.
//
// language-guard: allow-legacy agentOrdini.js/cambiaStato are the existing file/function names being cited, not new vocabulary
// KEPT BYTE-IDENTICAL: agentOrdini.js (forbidden file) imports and calls this
// directly from cambiaStato(). It is no longer reachable from any of the four
// mutation mappers below.
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

// ─── Authority RPC plumbing ───────────────────────────────────────

// Resolves legacy display order ids (e.g. "#001") to the Authority's
// identity space (ordenes.order_uid). Returns a Map keyed by the ORIGINAL
// string id, plus the subset of requested ids that could not be resolved
// (nonexistent orders) — the caller maps that to the existing
// "order not found" response shape without ever calling the Authority.
async function resolveOrderUids(orderIds) {
  const uniqIds = Array.from(new Set((orderIds || []).map(String)));
  const uidByOrderId = new Map();
  if (uniqIds.length === 0) return { uidByOrderId, missing: [] };
  const rows = await sbSelect("ordenes", `id=in.(${encodeIdList(uniqIds)})&select=id,order_uid`);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.id != null && r.order_uid) uidByOrderId.set(String(r.id), r.order_uid);
  }
  const missing = uniqIds.filter((id) => !uidByOrderId.has(id));
  return { uidByOrderId, missing };
}

// Resolves the DB-authoritative operational scope (never a computed/guessed
// one — same source every W3/W4 reader already uses). Returns null on any
// failure or empty scope, letting the caller fail closed with a typed 503
// rather than sending an unscoped/empty array into the Authority.
async function resolveScope() {
  let sessionIds;
  try {
    sessionIds = await getOperationalSessionIds();
  } catch (_) {
    return null;
  }
  return Array.isArray(sessionIds) && sessionIds.length > 0 ? sessionIds : null;
}

// Calls one Authority command and unwraps the PostgREST/RPC transport layer.
// Returns the parsed jsonb body ({ok, code, ...}) on a normal call, or null
// on any transport failure (network, non-2xx, non-JSON) — never throws.
async function callAuthority(fn, args) {
  let r;
  try {
    r = await sbRpc(fn, args);
  } catch (_) {
    return null;
  }
  if (!r || !r.ok || !r.body || typeof r.body !== "object") return null;
  return r.body;
}

// Maps a non-OK Authority command result to this module's existing
// {ok:false, status, error} response shape. Refusal codes the legacy raw-DB
// writers could never produce (GIRO_DEPARTED, GIRO_NOT_PLANNED,
// CONCURRENT_CHANGE, ORDER_ALREADY_IN_GIRO from the strict, unused-by-JS
// create_v1/attach_v1) are disclosed, safety-motivated additions — mapped to
// 409, never softened into a false success.
function mapAuthorityRefusal(body) {
  const code = body && body.code;
  switch (code) {
    case "ORDER_NOT_FOUND":
      return { ok: false, status: 404, error: "order_not_found" };
    case "GIRO_NOT_FOUND":
      return { ok: false, status: 404, error: "giro_not_found_or_dissolved" };
    case "ORDER_NOT_ELIGIBLE":
      return { ok: false, status: 400, error: "invalid_orders", details: body.reason || null };
    case "INSUFFICIENT_MEMBERS":
      return { ok: false, status: 400, error: "need_at_least_2_distinct_orders" };
    case "INVALID_INPUT":
      return { ok: false, status: 400, error: "invalid_input", details: body.field || null };
    case "SCOPE_MISMATCH":
      return { ok: false, status: 400, error: "scope_mismatch" };
    case "SCOPE_UNAVAILABLE":
    case "UNVERIFIABLE":
      return { ok: false, status: 503, error: "authority_scope_unavailable" };
    case "GIRO_DEPARTED":
      return { ok: false, status: 409, error: "giro_departed", details: body.giro_state || null };
    case "GIRO_NOT_PLANNED":
      return { ok: false, status: 409, error: "giro_not_planned", details: body.state_reason || null };
    case "CONCURRENT_CHANGE":
      return { ok: false, status: 409, error: "concurrent_change" };
    case "ORDER_ALREADY_IN_GIRO":
      return { ok: false, status: 409, error: "order_already_in_giro", details: body.giro_id || null };
    case "ORDER_NOT_IN_GIRO":
      return { ok: false, status: 400, error: "order_not_in_giro" };
    default:
      return { ok: false, status: 500, error: "authority_refused", details: code || null };
  }
}

// Best-effort raw write of the two non-canonical metadata fields the
// Authority does not model (entrega_ref, the display-format anchor_order_id
// — the Authority's own anchor_order_uid is a separate, audit-only column).
// Never touches membership/state; failure here never fails the mutation
// itself, matching this file's existing best-effort side-effect pattern.
async function writeLegacyGiroMetadata(giroId, { entregaRefNorm, anchorId }) {
  if (entregaRefNorm == null && anchorId == null) return;
  try {
    await sbUpdate("manual_giros", `id=eq.${encodeEqValue(giroId)}`, {
      ...(entregaRefNorm != null ? { entrega_ref: entregaRefNorm } : {}),
      ...(anchorId != null ? { anchor_order_id: anchorId } : {}),
    });
  } catch (e) {
    console.warn(`[manualGiros] legacy metadata write for ${giroId} failed:`, e?.message || e);
  }
}

// ─── Public writer mappers (W5 Packet 01: one Authority RPC each) ─

// Create a manual giro from 2+ existing orders. giro_authority_create_or_move_v1
// preserves the legacy "move silent" rule (orders already in another giro are
// silently moved) as ONE atomic Authority transaction — no JS-side detach.
async function createManualGiro(orderIds, horaRef = null, anchorOrderId = null, entregaRef = null) {
  if (!isValidHoraRef(horaRef)) {
    return { ok: false, status: 400, error: "invalid_hora_ref", details: horaRef };
  }
  // entrega_ref shares the HH:MM format with hora_ref (validated/normalized
  // by the same helpers) but carries a different semantic: the operator-chosen
  // delivery/giro target time, kept separate from the operational forno-exit time.
  if (!isValidHoraRef(entregaRef)) {
    return { ok: false, status: 400, error: "invalid_entrega_ref", details: entregaRef };
  }
  if (!Array.isArray(orderIds) || orderIds.length < 2) {
    return { ok: false, status: 400, error: "need_at_least_2_orders" };
  }
  const uniqIds = Array.from(new Set(orderIds.map(String)));
  if (uniqIds.length < 2) {
    return { ok: false, status: 400, error: "need_at_least_2_distinct_orders" };
  }
  const horaRefNorm = normalizeHoraRef(horaRef);
  const entregaRefNorm = normalizeHoraRef(entregaRef);
  const anchorId = anchorOrderId != null && anchorOrderId !== "" ? String(anchorOrderId) : null;

  const { uidByOrderId, missing } = await resolveOrderUids(uniqIds);
  if (missing.length) {
    return { ok: false, status: 400, error: "some_orders_not_found", expected: uniqIds.length, got: uniqIds.length - missing.length };
  }
  const orderUids = uniqIds.map((id) => uidByOrderId.get(id));
  const anchorUid = anchorId ? uidByOrderId.get(anchorId) || null : null;

  const scope = await resolveScope();
  if (!scope) return { ok: false, status: 503, error: "authority_scope_unavailable" };

  const body = await callAuthority("giro_authority_create_or_move_v1", {
    p_order_uids: orderUids, p_hora_ref: horaRefNorm, p_anchor_order_uid: anchorUid,
    p_actor: DEFAULT_CREATED_BY, p_operational_session_ids: scope,
  });
  if (!body) return { ok: false, status: 502, error: "authority_call_failed" };
  if (body.ok !== true) return mapAuthorityRefusal(body);

  await writeLegacyGiroMetadata(body.giro_id, { entregaRefNorm, anchorId });

  let seq = null, createdAt = null, createdBy = DEFAULT_CREATED_BY;
  try {
    const rows = await sbSelect("manual_giros", `id=eq.${encodeEqValue(body.giro_id)}&select=seq,created_at,created_by`);
    if (Array.isArray(rows) && rows[0]) {
      seq = rows[0].seq; createdAt = rows[0].created_at; createdBy = rows[0].created_by;
    }
  } catch (_) { /* best-effort read-back only; the mutation already succeeded */ }

  return {
    ok: true,
    giro: {
      id: body.giro_id,
      seq,
      giro_day: body.business_date,
      created_at: createdAt,
      created_by: createdBy,
      hora_ref: horaRefNorm,
      anchor_order_id: anchorId,
      entrega_ref: entregaRefNorm,
      order_ids: uniqIds,
    },
    moved_from: Array.isArray(body.moved_from) ? body.moved_from : [],
  };
}

// Add a single order to an existing giro. giro_authority_attach_or_move_v1
// decides unattached/same-target/other-giro entirely under DB lock — no JS
// branching on previously-read membership.
async function addOrderToManualGiro(giroId, orderId) {
  if (!giroId || !orderId) {
    return { ok: false, status: 400, error: "missing_args" };
  }
  const { uidByOrderId, missing } = await resolveOrderUids([orderId]);
  if (missing.length) return { ok: false, status: 404, error: "order_not_found" };
  const orderUid = uidByOrderId.get(String(orderId));

  const scope = await resolveScope();
  if (!scope) return { ok: false, status: 503, error: "authority_scope_unavailable" };

  const body = await callAuthority("giro_authority_attach_or_move_v1", {
    p_giro_id: giroId, p_order_uid: orderUid, p_actor: DEFAULT_CREATED_BY, p_operational_session_ids: scope,
  });
  if (!body) return { ok: false, status: 502, error: "authority_call_failed" };
  if (body.ok !== true) return mapAuthorityRefusal(body);
  if (body.code === "IDEMPOTENT") return { ok: true, no_op: true, moved_from: null };

  // auto_dissolved_prev: below-threshold dissolution is now DERIVED (no
  // explicit write, no separate fact this command could observe) — null
  // rather than a possibly-false boolean, honest about the architecture change.
  return { ok: true, moved_from: body.moved_from || null, auto_dissolved_prev: null };
}

// Detach a single order from its giro. giro_authority_detach_v1 is already
// idempotent and self-contained — direct 1:1 mapping, one RPC.
async function removeOrderFromManualGiro(orderId) {
  if (!orderId) return { ok: false, status: 400, error: "missing_order_id" };
  const { uidByOrderId, missing } = await resolveOrderUids([orderId]);
  if (missing.length) return { ok: false, status: 404, error: "order_not_found" };
  const orderUid = uidByOrderId.get(String(orderId));

  const scope = await resolveScope();
  if (!scope) return { ok: false, status: 503, error: "authority_scope_unavailable" };

  const body = await callAuthority("giro_authority_detach_v1", {
    p_order_uid: orderUid, p_actor: DEFAULT_CREATED_BY, p_operational_session_ids: scope,
  });
  if (!body) return { ok: false, status: 502, error: "authority_call_failed" };
  if (body.ok !== true) return mapAuthorityRefusal(body);
  if (body.code === "IDEMPOTENT") return { ok: true, no_op: true, auto_dissolved: false };

  // giro_state_after === 'DISSOLVED' means this detach itself dropped the
  // source giro below threshold — the same fact legacy's auto_dissolved
  // boolean reported, now read directly off the Authority's own response.
  return { ok: true, auto_dissolved: body.giro_state_after === "DISSOLVED" };
}

// Explicit dissolve. giro_authority_dissolve_v1 is already idempotent and
// self-contained — direct 1:1 mapping, one RPC.
async function dissolveManualGiro(giroId) {
  if (!giroId) return { ok: false, status: 400, error: "missing_giro_id" };

  const scope = await resolveScope();
  if (!scope) return { ok: false, status: 503, error: "authority_scope_unavailable" };

  const body = await callAuthority("giro_authority_dissolve_v1", {
    p_giro_id: giroId, p_actor: DEFAULT_CREATED_BY, p_operational_session_ids: scope,
  });
  if (!body) return { ok: false, status: 502, error: "authority_call_failed" };
  if (body.ok !== true) return mapAuthorityRefusal(body);
  return { ok: true };
}

// Returns active (non-dissolved) giros for a given service day plus
// the order_ids belonging to each. Used by GET getManualGiros.
//
// W4 Packet 02B: delegates entirely to manualGiroReads.getManualGirosRead(),
// which sources the CURRENT operational business day from the canonical Giro
// Authority projection and any HISTORICAL business day from the exact
// pre-cutover reader.
async function getManualGiros(args) {
  return getManualGirosRead(args);
}

// Closure-time hook: soft-dissolve every still-active giro and detach every
// language-guard: allow-legacy chiudiServizio is the existing retired function name being cited, not new vocabulary
// still-attached order. Called from chiudiServizio BEFORE the delete on
// language-guard: allow-legacy chiudiServizio is the existing retired function name being cited, not new vocabulary
// ordenes. UNREACHABLE today: chiudiServizio was retired by Service Lifecycle
// V3's close engine, which never adopted an equivalent hook — a pre-existing
// gap unrelated to W5, not fixed here (confirmed zero live callers anywhere
// in src/ or index.js). Kept, byte-identical, in case a future close-engine
// wiring needs the exact same detach+soft-dissolve contract.
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
  isValidHoraRef,
  normalizeHoraRef,
  isOrderEligibleForGiro,
  isStatusLeavingGiro,
  encodeIdList,
  encodeEqValue,
  SELECTABLE_STATES,
  DEFAULT_CREATED_BY,
  // language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
  // legacy support (agentOrdini.js dependency)
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
