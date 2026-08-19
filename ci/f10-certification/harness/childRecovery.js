"use strict";
// F-10.3C CI-ONLY child process (Phases 13/14). Waits for the parent's
// 'GO' barrier message, then calls the REAL, unmodified
// recoverForgottenService({staleServiceSessionId}) from the certified
// backend checkout -- forgottenCloseRecovery -> serviceCloseAuthority ->
// serviceLifecycleEngine -> real supabaseTransport -> PostgREST ->
// PostgreSQL. No mock, no direct close_service_session_v3 substitute.

const backendDir = process.env.F10_BACKEND_DIR;
if (!backendDir) {
  console.error("F10_BACKEND_DIR not set");
  process.exit(1);
}

const label = process.argv[2];
const staleServiceSessionId = process.argv[3];

const { recoverForgottenService } = require(require("path").join(
  backendDir, "src/serviceSessions/forgottenCloseRecovery"
));

process.on("message", async (msg) => {
  if (msg !== "GO") return;
  const sendAt = new Date().toISOString();
  let result;
  try {
    result = await recoverForgottenService({ staleServiceSessionId });
  } catch (e) {
    result = { success: false, code: "CHILD_THREW", detail: String((e && e.message) || e) };
  }
  const recvAt = new Date().toISOString();
  process.send({ label, pid: process.pid, sendAt, recvAt, result });
  process.exit(0);
});
