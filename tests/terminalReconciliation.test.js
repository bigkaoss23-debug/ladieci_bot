// tests/terminalReconciliation.test.js — S2-1F.
// Proves (a) the cambiaStato reconciliation hook fires for EVERY delivery terminal state
// (delivered + cancelled/void), domicilio-only, forwarding the order id; and (b) the
// cancellation-last-member / non-member / incomplete / duplicate scenarios resolve through
// the close RPC alone. Offline: riderTrip + supabase stubbed. Run: node tests/....test.js
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

// ── (a) static hook coverage ──
const ordini = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "agentOrdini.js"), "utf8").replace(/\/\/.*$/gm, "");
check("reconcile set = delivered + cancelled/void (5 states)",
  /RECONCILE_TERMINAL_STATES = new Set\(\["RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO", "ANULADO"\]\)/.test(ordini));
check("hook gated by RECONCILE_TERMINAL_STATES", /RECONCILE_TERMINAL_STATES\.has\(nuovoStato\)/.test(ordini));
check("hook is domicilio-only", /tipo_consegna === "DOMICILIO"[\s\S]{0,120}recordDeliveryAndMaybeReturn\(dOrd\)/.test(ordini));
check("hook never writes DRIVER_STATO / no global count", !/writeDriverStato|countActiveDeliveries|sbUpsert\([^)]*DRIVER_STATO/.test(ordini));

// ── (b) behavioural via recordDeliveryAndMaybeReturn (same path a cancellation triggers) ──
const supaPath = require.resolve("../src/utils/supabase");
const realSupa = require(supaPath);
let writes = 0;
require.cache[supaPath].exports = Object.assign({}, realSupa, {
  sbSelect: async () => [], sbUpsert: async () => { writes++; return {}; },
  sbInsert: async () => { writes++; return {}; }, sbUpdate: async () => { writes++; return {}; },
});
const rtPath = require.resolve("../src/agents/riderTrip");
const realRt = require(rtPath);
let closeCalls = 0, lastTrigger, RESULT;
require.cache[rtPath].exports = Object.assign({}, realRt, {
  closeTrip: async (t) => { closeCalls++; lastTrigger = t; return RESULT; },
});
const tele = require("../src/utils/driverTelemetry");

(async () => {
  // Cancellation of the LAST member (A already terminal, cancel B) -> RPC closes once.
  RESULT = { status: 200, payload: { ok: true, code: "OK", snapshot: { trip_id: "T1" } } };
  writes = 0; closeCalls = 0; lastTrigger = undefined;
  let r = await tele.recordDeliveryAndMaybeReturn({ id: "B", manual_giro_id: "G1" });
  check("cancel last member -> close_rider_trip(B) exactly once", closeCalls === 1 && lastTrigger === "B" && r.success === true && writes === 0);

  // Cancellation of a NON-member -> NON_MEMBER_NOOP, trip untouched.
  RESULT = { status: 200, payload: { ok: true, code: "NON_MEMBER_NOOP" } };
  writes = 0; closeCalls = 0;
  r = await tele.recordDeliveryAndMaybeReturn({ id: "OTHER", manual_giro_id: null });
  check("cancel non-member -> NON_MEMBER_NOOP, no write", r.success === true && r.skipped === "NON_MEMBER_NOOP" && writes === 0);

  // Cancellation while another member remains active -> EARLY_CLOSE, trip stays active.
  RESULT = { status: 409, payload: { ok: false, error: "EARLY_CLOSE" } };
  writes = 0; closeCalls = 0;
  r = await tele.recordDeliveryAndMaybeReturn({ id: "B", manual_giro_id: "G1" });
  check("cancel with member remaining -> EARLY_CLOSE no-op", r.success === true && r.skipped === "EARLY_CLOSE" && writes === 0);

  // Duplicate cancellation reconciliation -> idempotent, no duplicate write/log.
  RESULT = { status: 200, payload: { ok: true, code: "IDEMPOTENT", snapshot: {} } };
  writes = 0; closeCalls = 0;
  await tele.recordDeliveryAndMaybeReturn({ id: "B", manual_giro_id: "G1" });
  check("duplicate cancellation -> idempotent, no duplicate write", writes === 0 && closeCalls === 1);

  console.log(`\nterminalReconciliation: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL " + (e && e.stack || e)); process.exit(1); });
