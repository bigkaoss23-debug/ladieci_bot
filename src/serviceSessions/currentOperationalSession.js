"use strict";

// Operational reads must never infer "current" from recency, the wall clock, or
// a broad ordenes query. The lifecycle pointer is the single authority that
// decides which service owns the live board.
const { lifecycle } = require("./serviceSessionLifecycle");

async function getCurrentOperationalSession({ currentCloseout = lifecycle.currentCloseout } = {}) {
  const identity = await currentCloseout();
  if (!identity || identity.ok !== true) {
    const error = new Error("SERVICE_SESSION_READ_FAILED");
    error.code = identity?.code || "SERVICE_SESSION_READ_FAILED";
    throw error;
  }

  const session = identity.session;
  if (!session || session.status !== "open" || !session.id) return null;
  return session;
}

function serviceSessionQuery(sessionId, query = "") {
  if (!sessionId) throw new Error("SERVICE_SESSION_ID_REQUIRED");
  const prefix = `service_session_id=eq.${encodeURIComponent(sessionId)}`;
  return query ? `${prefix}&${query}` : prefix;
}

module.exports = { getCurrentOperationalSession, serviceSessionQuery };
