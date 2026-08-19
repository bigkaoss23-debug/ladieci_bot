"use strict";
// ===============================================================
// f10CreaOrdineForgottenRetry.test.js — F-10.1B cases K / L / M / N / O / P
//
// Exercises the REAL creaOrdine against a stubbed Supabase whose ordenes
// INSERT can answer with the resolver's structured forgotten-close rejection,
// exactly as PostgREST surfaces a PostgreSQL exception carrying DETAIL:
//     { code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: "<uuid>" }
//
// Run: node tests/f10CreaOrdineForgottenRetry.test.js
// No network, no DB.
// ===============================================================

const SERVER_STALE_ID = "5d3173b6-e1cb-4ee0-840c-d28310e06401";
const CLIENT_FORGED_ID = "99999999-9999-4999-8999-999999999999";

// ── Stub supabase BEFORE agentOrdini loads ────────────────────────────────
const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let insertAttempts = 0;
let INSERT_PLAN = [];

const structuredForgotten = () => ({
  code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: SERVER_STALE_ID,
});
// Same verdict, but WITHOUT the structured identity — must NOT recover.
const bareForgotten = () => ({ code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED" });
const malformedForgotten = () => ({ code: "P0001", message: "FORGOTTEN_CLOSE_REQUIRED", details: "not-a-uuid" });

supa.sbSelect = async (table) => (table === "config" ? [] : []);
supa.sbInsert = async (table, row) => {
  if (table !== "ordenes") return [row]; // language-guard: allow-legacy ordenes is the existing orders table name used by creaOrdine, not new vocabulary
  const plan = INSERT_PLAN[insertAttempts] || "ok";
  insertAttempts++;
  if (plan === "forgotten") return structuredForgotten();
  if (plan === "forgottenNoDetail") return bareForgotten();
  if (plan === "forgottenBadDetail") return malformedForgotten();
  if (plan === "otherError") return { code: "42501", message: "permission denied" };
  return [{ ...row, service_session_id: "SERVICE-B", service_order_number: 1 }];
};
supa.sbUpdate = async () => ({});
supa.sbUpsert = async () => ({});
supa.sbDelete = async () => ({});

const geoPath = require.resolve("../src/utils/geoResolver");
require(geoPath);
require.cache[geoPath].exports.risolviIndirizzo = async () => ({
  zona: null, lat: null, lon: null, durataAndataMin: null, googleMin: null,
  haversineMin: null, source: null, cached: false, fuoriZona: false, error: null,
});
const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];

const intakePath = require.resolve("../src/serviceSessions/orderIntakePolicy");
require(intakePath);
require.cache[intakePath].exports.gateNewOrderIntake = async () => ({
  allowed: true, code: "ALLOWED", detail: null, scheduleState: null,
  serviceKind: null, businessDate: null, sourceChannel: null,
});

// Recovery stub — records the identity it was handed, so "server-resolved
// only" is measurable.
const fcPath = require.resolve("../src/serviceSessions/forgottenCloseRecovery");
require(fcPath);
let recoveryCalls = [];
let RECOVERY_RESULT = { success: true, code: "FORGOTTEN_CLOSE_RECOVERED", converged: true };
require.cache[fcPath].exports.recoverForgottenService = async (args) => {
  recoveryCalls.push(args);
  return RECOVERY_RESULT;
};

const { creaOrdine } = require("../src/agents/agentOrdini");

let passed = 0, failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};

function reset(plan, recovery) {
  insertAttempts = 0;
  recoveryCalls = [];
  INSERT_PLAN = plan;
  RECOVERY_RESULT = recovery || { success: true, code: "FORGOTTEN_CLOSE_RECOVERED", converged: true };
}

// A client that tries to smuggle its own lifecycle identity into the payload.
const baseOrder = (extra = {}) => ({
  nombre: "T", tel: "600000000", items: [{ nombre: "Pizza", qty: 1, precio: 10 }],
  tipo_consegna: "RECOGIDA", // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, not new vocabulary
  operatorManual: true,
  ...extra,
});

(async () => {
  // ── L. structured verdict ⇒ one recovery + exactly one retry ────────────
  reset(["forgotten", "ok"]);
  let r = await creaOrdine(baseOrder());
  check("L — structured verdict triggers exactly one recovery", recoveryCalls.length === 1, JSON.stringify(recoveryCalls));
  check("L — recovery receives the SERVER-supplied stale uuid",
    recoveryCalls[0] && recoveryCalls[0].staleServiceSessionId === SERVER_STALE_ID, JSON.stringify(recoveryCalls[0]));
  check("L — the original order is retried exactly once (2 inserts)", insertAttempts === 2, `inserts=${insertAttempts}`);
  check("L — the retried order succeeds", r && r.success === true, JSON.stringify(r));
  check("L — the order is attributed to the NEW service", r && r.serviceSessionId === "SERVICE-B", JSON.stringify(r));

  // ── K. client-supplied stale uuid is ignored ───────────────────────────
  reset(["forgotten", "ok"]);
  r = await creaOrdine(baseOrder({
    staleServiceSessionId: CLIENT_FORGED_ID,
    service_session_id: CLIENT_FORGED_ID,
    close_source: "operator_finalizar_v3",
    actor: "owner",
  }));
  check("K — a client-supplied uuid never reaches recovery",
    recoveryCalls.length === 1 && recoveryCalls[0].staleServiceSessionId === SERVER_STALE_ID,
    JSON.stringify(recoveryCalls[0]));
  check("K — client payload cannot add extra recovery authority",
    recoveryCalls[0] && Object.keys(recoveryCalls[0]).length === 1, JSON.stringify(recoveryCalls[0]));

  // ── F/G at the wiring level: partial contract ⇒ no recovery ─────────────
  reset(["forgottenNoDetail", "ok"]);
  r = await creaOrdine(baseOrder());
  check("F(wiring) — verdict without DETAIL does NOT recover", recoveryCalls.length === 0, JSON.stringify(recoveryCalls));
  check("F(wiring) — and is not retried", insertAttempts === 1, `inserts=${insertAttempts}`);
  check("F(wiring) — falls through to the ordinary DB-error path", r && r.success === false && r.error === "errore DB", JSON.stringify(r));

  reset(["forgottenBadDetail", "ok"]);
  r = await creaOrdine(baseOrder());
  check("G(wiring) — malformed DETAIL uuid does NOT recover", recoveryCalls.length === 0, JSON.stringify(recoveryCalls));
  check("G(wiring) — and is not retried", insertAttempts === 1, `inserts=${insertAttempts}`);

  // ── O. a second structured verdict ⇒ typed failure, no third attempt ────
  reset(["forgotten", "forgotten", "ok"]);
  r = await creaOrdine(baseOrder());
  check("O — no third insert attempt", insertAttempts === 2, `inserts=${insertAttempts}`);
  check("O — recovery still invoked only once", recoveryCalls.length === 1, `calls=${recoveryCalls.length}`);
  check("O — typed failure returned", r && r.success === false && r.code === "FORGOTTEN_CLOSE_UNRESOLVED", JSON.stringify(r));

  // ── N/C (F-10.4) — recovery reports failure, but the retry still runs:
  // this is the race-loser proxy for W1/W2 (the OTHER contender already
  // closed stale A between this process's failed recovery observation and
  // its retry). The retry must be given the chance to self-resolve instead
  // of failing closed on a stale, possibly-wrong "recovery failed" verdict.
  reset(["forgotten", "ok"], { success: false, code: "V3_CLOSE_FAILED" });
  r = await creaOrdine(baseOrder());
  check("N/C — a failed recovery still consumes the budgeted retry (2 inserts)", insertAttempts === 2, `inserts=${insertAttempts}`);
  check("N/C — recovery is still invoked only once", recoveryCalls.length === 1, `calls=${recoveryCalls.length}`);
  check("N/C — the race-loser retry succeeds overall", r && r.success === true, JSON.stringify(r));
  check("N/C — the order is attributed to the NEW service", r && r.serviceSessionId === "SERVICE-B", JSON.stringify(r));

  // ── D (F-10.4) — genuinely unresolved: recovery fails AND the stale
  // service is still open on retry ⇒ typed failure, no third insert, no
  // second recovery.
  reset(["forgotten", "forgotten", "ok"], { success: false, code: "V3_CLOSE_FAILED" });
  r = await creaOrdine(baseOrder());
  check("D — exactly 2 insert attempts (no third)", insertAttempts === 2, `inserts=${insertAttempts}`);
  check("D — recovery invoked only once even though still unresolved", recoveryCalls.length === 1, `calls=${recoveryCalls.length}`);
  check("D — typed FORGOTTEN_CLOSE_UNRESOLVED returned", r && r.success === false && r.code === "FORGOTTEN_CLOSE_UNRESOLVED", JSON.stringify(r));

  // ── E (F-10.4) — recovery fails, retry hits an unrelated DB error ⇒
  // existing generic error behaviour, unchanged, no third attempt.
  reset(["forgotten", "otherError"], { success: false, code: "V3_CLOSE_FAILED" });
  r = await creaOrdine(baseOrder());
  check("E — exactly 2 insert attempts (no third)", insertAttempts === 2, `inserts=${insertAttempts}`);
  check("E — recovery invoked only once", recoveryCalls.length === 1, `calls=${recoveryCalls.length}`);
  check("E — unrelated error keeps its existing generic shape", r && r.success === false && r.error === "errore DB", JSON.stringify(r));

  // ── M. idempotent recovery ⇒ one retry ─────────────────────────────────
  reset(["forgotten", "ok"], { success: true, code: "FORGOTTEN_CLOSE_RECOVERED", idempotent: true });
  r = await creaOrdine(baseOrder());
  check("M — idempotent recovery still yields exactly one retry", insertAttempts === 2 && recoveryCalls.length === 1, `inserts=${insertAttempts}`);
  check("M — order succeeds", r && r.success === true, JSON.stringify(r));

  // ── P. unrelated DB error behaviour unchanged ──────────────────────────
  reset(["otherError", "ok"]);
  r = await creaOrdine(baseOrder());
  check("P — unrelated DB error does not invoke recovery", recoveryCalls.length === 0, `calls=${recoveryCalls.length}`);
  check("P — unrelated DB error is not retried", insertAttempts === 1, `inserts=${insertAttempts}`);
  check("P — unrelated DB error keeps its existing shape", r && r.success === false && r.error === "errore DB", JSON.stringify(r));

  // ── baseline ───────────────────────────────────────────────────────────
  reset(["ok"]);
  r = await creaOrdine(baseOrder());
  check("baseline — a normal order never invokes recovery", recoveryCalls.length === 0 && insertAttempts === 1, `inserts=${insertAttempts}`);
  check("baseline — normal order succeeds", r && r.success === true, JSON.stringify(r));

  console.log(`\nf10CreaOrdineForgottenRetry: ${passed}/${passed + failed} passed`);
  if (failed) process.exit(1);
})();
