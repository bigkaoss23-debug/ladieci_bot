// tests/finalizarServiceIdentityBinding.test.js — R4B: a Finalizar request is BOUND to the service it names, and the engine reports success only
// once the attempt completion is confirmed (migration 149). Unit + wiring; the end-to-end proof (real index.js over HTTP on PostgreSQL 17,
// crash windows W0..W7 x retry / B opened / B trading / reload, concurrency, negatives) is in the R4B report.
// Run: node tests/finalizarServiceIdentityBinding.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const { resolveFinalizarTarget, CLIENT_IDENTITY_FIELDS_NOT_ACCEPTED } = require("../src/serviceSessions/finalizarTarget");
const { createServiceLifecycleV3Transition } = require("../src/serviceSessions/serviceLifecycleV3Transition");
const { recover, listStranded } = require("../scripts/r4bHistoricalCloseAttemptRecovery");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); } }

const A = "aaaaaaaa-0000-4000-8000-00000000000a", Bid = "bbbbbbbb-0000-4000-8000-00000000000b", X = "cccccccc-0000-4000-8000-00000000000c";
const op = (id, status = "open") => ({ id, status, lifecycle_semantics: "operational_service_v1" });

(async () => {
  console.log("\n── resolveFinalizarTarget: the request's own id, never the pointer ──");
  const rows = { [A]: op(A, "closed"), [Bid]: op(Bid, "open"), [X]: { id: X, status: "closed", lifecycle_semantics: "economic_period_v1" } };
  let reads = 0;
  const readSession = async (id) => { reads++; return rows[id] || null; };
  const identityB = { ok: true, session: op(Bid, "open") };
  const t = (requested, extra = {}, identity = identityB) => resolveFinalizarTarget({ requested, clientFields: { serviceSessionId: requested, ...extra }, identity, readSession });

  let r = await t(undefined);
  check("no id -> FINALIZAR_SERVICE_IDENTITY_REQUIRED (an old client is refused, never routed to the current service)", r.ok === false && r.code === "FINALIZAR_SERVICE_IDENTITY_REQUIRED");
  r = await t("not-a-uuid");
  check("malformed id -> FINALIZAR_SERVICE_IDENTITY_INVALID", r.ok === false && r.code === "FINALIZAR_SERVICE_IDENTITY_INVALID");
  r = await t(Bid);
  check("the id IS the resolved current service -> bound to it (the only case where an open service can be closed)", r.ok && r.serviceSessionId === Bid && r.binding === "resolved");
  r = await t(Bid.toUpperCase());
  check("ids are compared case-insensitively (a UUID's canonical form)", r.ok && r.serviceSessionId === Bid);
  reads = 0; r = await t(A);
  check("a retry bound to A while B is current -> A (closed): bound to A, NEVER re-targeted to B", r.ok && r.serviceSessionId === A && r.binding === "closed_retry" && reads === 1);
  rows[A].status = "open";
  r = await t(A);
  check("an id that is open but NOT the resolved current service -> FINALIZAR_SERVICE_IDENTITY_MISMATCH (never closed on a client's word)", r.ok === false && r.code === "FINALIZAR_SERVICE_IDENTITY_MISMATCH");
  rows[A].status = "rolled_over"; r = await t(A);
  check("... whatever its status (rolled_over)", r.ok === false && r.code === "FINALIZAR_SERVICE_IDENTITY_MISMATCH");
  rows[A].status = "closed";
  r = await t("dddddddd-0000-4000-8000-00000000000d");
  check("unknown id -> FINALIZAR_SERVICE_NOT_FOUND", r.ok === false && r.code === "FINALIZAR_SERVICE_NOT_FOUND");
  r = await t(X);
  check("another era -> legacy_session_kind_unsupported", r.ok === false && r.code === "legacy_session_kind_unsupported");
  r = await t(Bid, { closeoutCorrelationId: "corr-of-A" });
  check("B + A's correlation supplied by the client -> FINALIZAR_CLIENT_IDENTITY_FIELD_NOT_ACCEPTED (no correlation / attempt id is ever taken from a client)", r.ok === false && r.code === "FINALIZAR_CLIENT_IDENTITY_FIELD_NOT_ACCEPTED" && r.fields.join() === "closeoutCorrelationId");
  r = await t(A, { attemptId: "x", closeout_correlation_id: "y" });
  check("A + attempt / correlation fields -> refused as well", r.ok === false && r.code === "FINALIZAR_CLIENT_IDENTITY_FIELD_NOT_ACCEPTED" && r.fields.length === 2);
  check("the refused field list is exactly the four identity spellings", CLIENT_IDENTITY_FIELDS_NOT_ACCEPTED.join() === "closeoutCorrelationId,closeout_correlation_id,closeoutAttemptId,attemptId");
  r = await resolveFinalizarTarget({ requested: A, clientFields: {}, identity: { ok: false, code: "SERVICE_SESSION_TRANSPORT_ERROR" }, readSession });
  check("an unresolved identity fails closed with its own code", r.ok === false && r.code === "SERVICE_SESSION_TRANSPORT_ERROR");
  r = await resolveFinalizarTarget({ requested: A, clientFields: {}, identity: identityB, readSession: async () => { throw new Error("down"); } });
  check("a failed read of the named service fails closed (FINALIZAR_SERVICE_READ_FAILED)", r.ok === false && r.code === "FINALIZAR_SERVICE_READ_FAILED");
  r = await resolveFinalizarTarget({ requested: A, clientFields: {}, identity: { ok: true, session: op(A, "closed") }, readSession });
  check("no service open: the id equals the resolver's recent-closed A -> bound to A (the engine can only confirm / complete it)", r.ok && r.serviceSessionId === A && r.binding === "resolved");

  console.log("\n── the terminal step wrapper: success only with a confirmed completion of THIS attempt ──");
  const wire = (body) => async () => ({ ok: true, body });
  const T = (rpc) => createServiceLifecycleV3Transition({ rpc });
  const args = { serviceSessionId: A, closeoutCorrelationId: "c-1", actor: "op", source: "operator_finalizar_v3" };
  const att = (o = {}) => ({ closeout_correlation_id: "c-1", service_session_id: A, status: "completed", ...o });
  let seen = null;
  r = await T(async (name, a) => { seen = { name, a }; return { ok: true, body: { ok: true, code: "V3_CLOSED", attemptCompleted: true, attempt: att(), session: { id: A, status: "closed" } } }; }).closeAndCompleteAttempt(args);
  check("calls close_service_session_and_complete_attempt_v1 with the four arguments", seen.name === "close_service_session_and_complete_attempt_v1" && seen.a.p_service_session_id === A && seen.a.p_closeout_correlation_id === "c-1" && seen.a.p_closed_by === "op" && seen.a.p_source === "operator_finalizar_v3");
  check("V3_CLOSED + attemptCompleted + this attempt completed -> success", r.success === true && r.attemptCompleted === true && r.session.status === "closed");
  r = await T(wire({ ok: true, code: "V3_CLOSED", session: {} })).closeAndCompleteAttempt(args);
  check("ok:true WITHOUT a confirmed completion -> failure V3_CLOSE_ATTEMPT_NOT_CONFIRMED (never a silent success)", r.success === false && r.code === "V3_CLOSE_ATTEMPT_NOT_CONFIRMED");
  r = await T(wire({ ok: true, code: "V3_CLOSED", attemptCompleted: true, attempt: att({ closeout_correlation_id: "c-OTHER" }) })).closeAndCompleteAttempt(args);
  check("a completion of ANOTHER correlation is not a confirmation", r.success === false && r.code === "V3_CLOSE_ATTEMPT_NOT_CONFIRMED");
  r = await T(wire({ ok: true, code: "V3_CLOSED", attemptCompleted: true, attempt: att({ service_session_id: Bid }) })).closeAndCompleteAttempt(args);
  check("a completion of ANOTHER service is not a confirmation", r.success === false && r.code === "V3_CLOSE_ATTEMPT_NOT_CONFIRMED");
  r = await T(wire({ ok: false, code: "ATTEMPT_COMPLETION_REFUSED" })).closeAndCompleteAttempt(args);
  check("the database's refusal passes through typed", r.success === false && r.code === "ATTEMPT_COMPLETION_REFUSED");
  r = await T(wire({ ok: false, code: "CLOSE_EVIDENCE_INCOMPLETE", missing: ["reconciliation"] })).closeAndCompleteAttempt(args);
  check("missing evidence passes through with its list", r.success === false && r.code === "CLOSE_EVIDENCE_INCOMPLETE" && r.missing.join() === "reconciliation");
  r = await T(async () => { throw new Error("network"); }).closeAndCompleteAttempt(args);
  check("a transport exception (outcome unknown, may have committed) -> typed failure, never a throw, never a success", r.success === false && r.code === "SERVICE_LIFECYCLE_V3_TRANSITION_TRANSPORT_ERROR");

  console.log("\n── wiring ──");
  const INDEX = read("index.js");
  const block = INDEX.slice(INDEX.indexOf('action === "chiudiServizio"'), INDEX.indexOf('action === "triggerCloseIfNeeded"')); // language-guard: allow-legacy chiudiServizio is the existing action-name string literal being located, not new vocabulary
  check("index.js requires the binding module", /const \{ resolveFinalizarTarget \} = require\("\.\/src\/serviceSessions\/finalizarTarget"\);/.test(INDEX));
  check("the Finalizar branch binds on req.query.serviceSessionId and hands the WHOLE query to the forged-field check", /requested: req\.query\.serviceSessionId,\s*\n\s*clientFields: req\.query,/.test(block));
  check("the engine is called with the BOUND id (target.serviceSessionId), never with the resolver's identity.session.id", /closeServiceSessionV3\(\{\s*\n\s*serviceSessionId: target\.serviceSessionId,/.test(block) && !/serviceSessionId: identity\.session\.id/.test(block));
  check("a refused binding never reaches the engine", /\} else if \(!target\.ok\) \{\s*\n\s*result = \{ success: false, error: target\.code/.test(block) && block.indexOf("!target.ok") < block.indexOf("closeServiceSessionV3("));
  const ENGINE = read("src/serviceSessions/serviceLifecycleEngine.js");
  check("the engine's terminal step is closeWithEvidence (main path + CASE B; the 149 close + completion inside it, migration 150) and it never calls the bare transition.close", (ENGINE.match(/transition\.closeWithEvidence\(/g) || []).length === 2 && !/transition\.closeAndCompleteAttempt\(/.test(ENGINE) && !/transition\.close\(/.test(ENGINE));
  check("attempts.complete is called ONLY in CASE D (the historical closed-with-active-attempt recovery)", (ENGINE.match(/attempts\.complete\(/g) || []).length === 1 && ENGINE.indexOf("attempts.complete(") > ENGINE.indexOf("CASE D (R4)") && ENGINE.indexOf("attempts.complete(") < ENGINE.indexOf("CASE B: service still open/closing"));
  check("no non-fatal completion (the old Phase G) remains: no swallowed completion error", !/marking the attempt completed failed \(non-fatal/.test(ENGINE));
  check("the new RPC is registered in the H1B resource policy", /entry\('rpc\/close_service_session_and_complete_attempt_v1', KIND\.RPC, \['POST'\]/.test(read("src/utils/supabaseResourcePolicy.js")));

  console.log("\n── historical-only ops script ──");
  const S = read("scripts/r4bHistoricalCloseAttemptRecovery.js");
  check("it reaches the engine ONLY through the close authority, by id, and never calls a transition / completion RPC itself", /require\('\.\.\/src\/serviceSessions\/serviceCloseAuthority'\)/.test(S) && !/rpc\(|close_service_session|complete_closeout_attempt/.test(S.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")));
  const sel = async (table, q) => (table === "service_closeout_attempts" ? [{ closeout_correlation_id: "c-A", service_session_id: A }, { closeout_correlation_id: "c-B", service_session_id: Bid }] : [op(A, "closed"), op(Bid, "open")].filter((s) => q.includes(s.id)));
  const listed = await listStranded({ select: sel });
  check("list: only CLOSED services with an ACTIVE attempt (B, open with its own attempt, is not listed)", listed.length === 1 && listed[0].serviceSessionId === A);
  const calls = [];
  const res = await recover([Bid, A], { select: sel, close: async (a) => { calls.push(a.serviceSessionId); return { success: true, code: "V3_CLOSED" }; } });
  check("recover: a service that is not listed (B) is refused without any engine call; a listed one goes through the engine by its own id", res[0].ok === false && res[0].code === "NOT_A_CLOSED_SERVICE_WITH_ACTIVE_ATTEMPT" && res[1].ok === true && calls.join() === A);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
