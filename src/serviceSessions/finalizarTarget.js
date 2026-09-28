"use strict";
// ===============================================================
// finalizarTarget.js — R4B: the service a Finalizar request is bound to.
//
// WHY. Finalizar used to close "the current service, else the most recently
// closed one", resolved at request time. A retry of Finalizar(A) after a lost
// response could therefore land on B if B had opened meanwhile, and close B.
// The pointer alone is not an identity.
//
// THE CONTRACT. The client sends the service it is finalizing
// (`serviceSessionId`, taken from the pre-close scan it showed the operator)
// and keeps sending that same id on every retry of the same flow. The server
// never re-targets it:
//   - it is the service the server resolves as current/recent-closed -> that
//     service (the only case in which an OPEN service can be closed);
//   - it is any other service -> only if that service is already 'closed'
//     (the engine can then only confirm its close, CASE C, or complete its
//     own attempt from its own close facts, CASE D — it never closes
//     anything, and never touches the current service);
//   - anything else (unknown id, open but not current, another era) -> a
//     typed refusal, no engine call.
// No correlation / attempt id is ever accepted from the client: the engine
// derives the attempt from the service's own closeout lineage.
//
// Pure decision: the caller (index.js) supplies the resolved identity and a
// read of one service_sessions row. No write happens here.
// ===============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_IDENTITY_FIELDS_NOT_ACCEPTED = ["closeoutCorrelationId", "closeout_correlation_id", "closeoutAttemptId", "attemptId"];

async function resolveFinalizarTarget({ requested, clientFields = {}, identity, readSession } = {}) {
  const forged = CLIENT_IDENTITY_FIELDS_NOT_ACCEPTED.filter((k) => clientFields[k] !== undefined);
  if (forged.length > 0) {
    return { ok: false, code: "FINALIZAR_CLIENT_IDENTITY_FIELD_NOT_ACCEPTED", fields: forged };
  }
  const id = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (!id) return { ok: false, code: "FINALIZAR_SERVICE_IDENTITY_REQUIRED" };
  if (!UUID_RE.test(id)) return { ok: false, code: "FINALIZAR_SERVICE_IDENTITY_INVALID" };

  if (!identity || identity.ok !== true) {
    return { ok: false, code: (identity && identity.code) || "FINALIZAR_SERVICE_IDENTITY_UNRESOLVED" };
  }
  const resolved = identity.session || null;
  if (resolved && resolved.id === id) {
    if (resolved.lifecycle_semantics !== "operational_service_v1") {
      return { ok: false, code: "legacy_session_kind_unsupported" };
    }
    return { ok: true, serviceSessionId: id, binding: "resolved" };
  }

  let session;
  try {
    session = await readSession(id);
  } catch (e) {
    return { ok: false, code: "FINALIZAR_SERVICE_READ_FAILED" };
  }
  if (!session || session.id !== id) return { ok: false, code: "FINALIZAR_SERVICE_NOT_FOUND" };
  if (session.lifecycle_semantics !== "operational_service_v1") {
    return { ok: false, code: "legacy_session_kind_unsupported" };
  }
  if (session.status !== "closed") {
    // A service that is not the one the server considers current is never
    // closed on the client's word, whatever its status.
    return { ok: false, code: "FINALIZAR_SERVICE_IDENTITY_MISMATCH" };
  }
  return { ok: true, serviceSessionId: id, binding: "closed_retry" };
}

module.exports = { resolveFinalizarTarget, CLIENT_IDENTITY_FIELDS_NOT_ACCEPTED };
