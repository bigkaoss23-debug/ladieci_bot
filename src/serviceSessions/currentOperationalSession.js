"use strict";

// Operational reads must never infer "current" from recency, the wall clock, or
// a broad ordenes query. The lifecycle pointer is the single authority that
// decides which service owns the live board.
const { lifecycle } = require("./serviceSessionLifecycle");

// P0-C1 — AVAILABILITY CONTAINMENT. A session mid-close ('closing') still owns
// real, unresolved, real-money operational facts (orders, tables) until it
// actually reaches 'closed' — see SERVICE_LIFECYCLE_ECONOMIC_BOUNDARY_AUDIT_
// REPORT.md §2/§4. Before P0-C1 this required status==='open' EXACTLY, so the
// instant a session left 'open' (even mid-transition, even stuck), every
// caller of this function (getOrdenes, getOrdenesArchivadosSesion,
// agentCucina.js's kitchen-load/delivery-cascade reads, scanServizio,
// backupSerata — confirmed by grep to be its only real callers, none of which
// creates/attributes a new order: that stays governed entirely by the
// ordenes_assign_service_session DB trigger reading service_session_state.
// current_session_id directly, untouched here) went dark, indistinguishable
// from "genuinely nothing pending." Widening to also accept 'closing' fixes
// that without loosening scope in any other way: every read remains pinned to
// this ONE session's real id (still resolved by the SAME lifecycle-
// authoritative currentCloseout() as before), so a session that has actually
// reached 'closed' (today's or any prior day's) is still correctly excluded —
// this cannot resurrect a stale multi-day-old ticket.
const OPERATIONAL_STATUSES = new Set(["open", "closing"]);

async function getCurrentOperationalSession({ currentCloseout = lifecycle.currentCloseout } = {}) {
  const identity = await currentCloseout();
  if (!identity || identity.ok !== true) {
    const error = new Error("SERVICE_SESSION_READ_FAILED");
    error.code = identity?.code || "SERVICE_SESSION_READ_FAILED";
    throw error;
  }

  const session = identity.session;
  if (!session || !OPERATIONAL_STATUSES.has(session.status) || !session.id) return null;
  return session;
}

function serviceSessionQuery(sessionId, query = "") {
  if (!sessionId) throw new Error("SERVICE_SESSION_ID_REQUIRED");
  const prefix = `service_session_id=eq.${encodeURIComponent(sessionId)}`;
  return query ? `${prefix}&${query}` : prefix;
}

// P0-C2 → P0-C3 — INTRADAY CARRYOVER VISIBILITY, now BUSINESS-DATE-SCOPED.
//
// P0-C2's original version bounded this to "one rollover-chain hop back" —
// language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
// correct for the same-day PRANZO->SERA case it was built to prove, but
// WRONG the instant a rollover crosses a business_date: a session rolled
// over from yesterday into today is still `status='rolled_over'` (nothing
// language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
// distinguishes "yesterday's PRANZO" from "this morning's PRANZO" in that
// status alone), so the old one-hop rule would keep showing YESTERDAY's
// residue as if it were today's ordinary carryover forever — proven live,
// read-only, before this fix (P0_C3 report §2): the real deployed code
// returned all 6 non-terminal orders, 5 of them from business_date
// 2026-08-10 while the current business_date was already 2026-08-11.
//
// The correct dimension was always business_date, not rollover-chain depth
// (see P0_C3_END_OF_DAY_OPERATIONAL_VISIBILITY_REPORT.md §4/§5): "actionable
// work of the CURRENT BUSINESS DATE", not "one hop of session history" and
// definitely not "all non-terminal work for all history". A business_date
// language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
// has at most 2 service_sessions (service_sessions_date_kind_uq: one PRANZO,
// one SERA) — this can never grow into an unbounded scan by construction,
// same bound as before, correct dimension now. 'closed' sessions (V2/V3's
// destructive close already archived/removed everything) stay excluded
// same-day exactly as before — this cannot resurrect what a real close
// already terminated.
async function getOperationalSessionIds({ currentCloseout = lifecycle.currentCloseout, select } = {}) {
  const current = await getCurrentOperationalSession({ currentCloseout });
  if (!current) return [];
  if (typeof select !== "function") return [current.id];
  let rows;
  try {
    rows = await select(
      "service_sessions",
      `business_date=eq.${encodeURIComponent(current.business_date)}&status=in.(open,closing,rolled_over)&select=id`,
    );
  } catch (_) {
    rows = null; // fail closed to just [current.id] — never widen on a read error
  }
  if (!Array.isArray(rows) || rows.length === 0) return [current.id];
  const ids = rows.map((r) => r.id);
  if (!ids.includes(current.id)) ids.push(current.id); // current is always included, regardless of read timing
  return ids;
}

// P0-C3 — the ONE authoritative answer to "what business date is currently
// operational", for every caller that needs it (residue reconciliation,
// future admin surfaces) instead of five independent derivations. Reuses
// getCurrentOperationalSession() — same open/closing resolution, same
// fail-safe null on a genuine integrity gap. Deliberately NEVER falls back
// to the wall clock/calendar date: if there is no resolvable current
// session, the answer is "unknown", not "assume today" (see report §4 for
// the full audit of open/closing/rolled_over/missed-boundary/integrity-gap
// cases).
async function getCurrentOperationalBusinessDate({ currentCloseout = lifecycle.currentCloseout } = {}) {
  const current = await getCurrentOperationalSession({ currentCloseout });
  return current ? current.business_date : null;
}

// Plural sibling of serviceSessionQuery — a single id still produces the
// exact same `eq.` filter (byte-identical query strings for the common
// case), only a genuine 2-id carryover switches to `in.(...)`.
function serviceSessionsQuery(sessionIds, query = "") {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error("SERVICE_SESSION_IDS_REQUIRED");
  }
  const prefix = sessionIds.length === 1
    ? `service_session_id=eq.${encodeURIComponent(sessionIds[0])}`
    : `service_session_id=in.(${sessionIds.map((id) => encodeURIComponent(id)).join(",")})`;
  return query ? `${prefix}&${query}` : prefix;
}

module.exports = {
  getCurrentOperationalSession, serviceSessionQuery,
  getOperationalSessionIds, serviceSessionsQuery,
  getCurrentOperationalBusinessDate,
};
