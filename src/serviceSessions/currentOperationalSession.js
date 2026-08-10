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

module.exports = { getCurrentOperationalSession, serviceSessionQuery };
