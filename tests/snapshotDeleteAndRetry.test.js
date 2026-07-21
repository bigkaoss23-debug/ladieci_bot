// tests/snapshotDeleteAndRetry.test.js — S2-1G.
// Covers: transactional hard-delete guard (active member -> 409), close cardinality mapping
// (MISSING_TRIP_MEMBER -> 409), SERVICE_CLOSING -> 409, eliminaOrdine routing, and the
// bounded deferred-close retry decision. Offline: sbRpc stubbed; index.js required with env.
const fs = require("fs");
const path = require("path");

// env for index.js require (guard stays off; no listen under require.main).
process.env.AUTH_JWT_SECRET_B64URL = Buffer.from("s2_1g_test_secret_key_at_least_32_bytes!!").toString("base64url");
process.env.SUPABASE_URL = "http://localhost.invalid"; process.env.SUPABASE_KEY = "t";

const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let lastRpc = null, RPC = { httpStatus: 200, ok: true, body: { ok: true, code: "OK", deleted: 1 } };
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbRpc: async (fn, args) => { lastRpc = { fn, args }; return RPC; },
});
const riderTrip = require("../src/agents/riderTrip");
const idx = require("../index.js");
const roles = require("../src/auth/legacyActionRoles");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

(async () => {
  // Delete guard wrapper: active member -> 409; non-member -> 200.
  RPC = { httpStatus: 200, ok: true, body: { ok: false, code: "ACTIVE_TRIP_MEMBER_CONFLICT" } };
  let r = await riderTrip.deleteOrder("A");
  check("deleteOrder active member -> 409", r.status === 409 && r.payload.error === "ACTIVE_TRIP_MEMBER_CONFLICT");
  check("deleteOrder calls delete_order_if_not_active(order)", lastRpc.fn === "delete_order_if_not_active" && lastRpc.args.p_order_id === "A");
  RPC = { httpStatus: 200, ok: true, body: { ok: true, code: "OK", deleted: 1 } };
  r = await riderTrip.deleteOrder("Z");
  check("deleteOrder non-member -> 200", r.status === 200 && r.payload.deleted === 1);
  RPC = { httpStatus: 200, ok: true, body: { ok: false, code: "ACTIVE_TRIP_MEMBER_CONFLICT" } };
  r = await riderTrip.deleteConversation("wa-a");
  check("deleteConversation active member -> 409", r.status === 409 && r.payload.error === "ACTIVE_TRIP_MEMBER_CONFLICT");
  check("deleteConversation calls delete_conversation_if_not_active(wa_id)", lastRpc.fn === "delete_conversation_if_not_active" && lastRpc.args.p_wa_id === "wa-a");
  RPC = { httpStatus: 200, ok: true, body: { ok: true, code: "OK", deleted: { conv: 1, wa_msgs: 2, ordenes: 3 } } };
  r = await riderTrip.deleteConversation("wa-z");
  check("deleteConversation non-active preserves success payload", r.status === 200 && r.payload.deleted.ordenes === 3);

  // Cardinality + service-closing mapping.
  check("MISSING_TRIP_MEMBER -> 409", riderTrip.mapResult({ httpStatus: 200, ok: true, body: { ok: false, code: "MISSING_TRIP_MEMBER" } }).status === 409);
  check("INVALID_TRIP_SNAPSHOT -> 409", riderTrip.mapResult({ httpStatus: 200, ok: true, body: { ok: false, code: "INVALID_TRIP_SNAPSHOT" } }).status === 409);
  check("SERVICE_CLOSING -> 409", riderTrip.mapResult({ httpStatus: 200, ok: true, body: { ok: false, code: "SERVICE_CLOSING" } }).status === 409);

  // eliminaOrdine routes through the guard (no raw sbDelete ordenes-by-id).
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  check("eliminaOrdine routes through riderTrip.deleteOrder", /action === "eliminaOrdine"[\s\S]{0,220}riderTrip\.deleteOrder\(req\.body\.id\)/.test(src));
  check("eliminaOrdine no longer raw-deletes ordenes by id", !/action === "eliminaOrdine"[\s\S]{0,160}sbDelete\("ordenes", `id=eq/.test(src));
  check("eliminaConversazione routes through riderTrip.deleteConversation", /action === "eliminaConversazione"[\s\S]{0,260}riderTrip\.deleteConversation\(req\.body\.wa_id\)/.test(src));
  check("eliminaConversazione no raw JS deletes", !/action === "eliminaConversazione"[\s\S]{0,260}sbDelete\("(conv|wa_msgs|ordenes)"/.test(src));
  check("rider denied eliminaConversazione by role map", !roles.isAllowed("rider", "eliminaConversazione"));

  // Bounded deferred-close retry decision (pure).
  const deferred = { deferred: true, reason: "active_rider_trip" };
  const p0 = idx.deferredCloseRetryPlan(deferred, 0);
  check("deferred -> retry with delay + next attempt", p0.retry === true && p0.delayMs === idx.CLOSE_RETRY_INTERVAL_MS && p0.attempt === 1);
  check("non-deferred success -> no retry", idx.deferredCloseRetryPlan({ success: true }, 0).retry === false);
  check("skipped(already closed) -> no retry", idx.deferredCloseRetryPlan({ skipped: true, reason: "already_closed_today" }, 0).retry === false);
  check("at max attempts -> no retry (bounded, no tight loop)", idx.deferredCloseRetryPlan(deferred, idx.CLOSE_RETRY_MAX_ATTEMPTS).retry === false);
  check("retry attempts are monotonic (attempt increments)", idx.deferredCloseRetryPlan(deferred, 3).attempt === 4);

  // §9 manual conflict is surfaced as a stable 409.
  check("manual close deferred -> 409 ACTIVE_RIDER_TRIP", /deferred && result\.reason === "active_rider_trip"[\s\S]{0,140}status\(409\)[\s\S]{0,80}ACTIVE_RIDER_TRIP/.test(src));

  console.log(`\nsnapshotDeleteAndRetry: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
