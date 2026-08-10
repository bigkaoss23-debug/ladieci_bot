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

// P0-C2 — INTRADAY CARRYOVER VISIBILITY. The current session B may have
// rolled over economically from A (rollover_source_session_id) while A's
// real non-terminal orders/open tables are still live and operable — the
// entire point of a non-destructive boundary. Cocina/Listos must keep
// showing A's work, not just B's. Deliberately bounded to ONE hop back, and
// only when that source is ITSELF status='rolled_over' — never 'closed'
// (V2/V3's destructive close already archived/removed everything there is
// nothing left to show) and never further back than one boundary (this is
// "intraday carryover", not "show every non-terminal order ever" — see
// SERVICE_LIFECYCLE_ECONOMIC_BOUNDARY_AUDIT_REPORT.md's own explicit warning
// against exactly that, and P0_C2's brief, same warning verbatim). A session
// only ever has ONE immediate rollover source (service_sessions_rollover_
// source_uq), so this can never grow into an unbounded chain by construction.
async function getOperationalSessionIds({ currentCloseout = lifecycle.currentCloseout, select } = {}) {
  const current = await getCurrentOperationalSession({ currentCloseout });
  if (!current) return [];
  const ids = [current.id];
  if (current.rollover_source_session_id && typeof select === "function") {
    let rows;
    try {
      rows = await select(
        "service_sessions",
        `id=eq.${encodeURIComponent(current.rollover_source_session_id)}&status=eq.rolled_over&select=id`,
      );
    } catch (_) {
      rows = null; // fail closed to just [current.id] — never widen on a read error
    }
    if (Array.isArray(rows) && rows.length > 0) ids.push(current.rollover_source_session_id);
  }
  return ids;
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
};
