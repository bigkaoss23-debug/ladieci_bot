"use strict";
// S2-7D6B3 — orchestrator.js (the WhatsApp bot's main flow) funnels every new
// order through the SAME creaOrdine intake gate the operator dashboard uses —
// there is no separate WhatsApp-only cutoff left (closingTime.js's retired
// 23:00 ceiling used to be exactly that; see closingTimeGuard.test.js). This
// drives gestisci() directly (skipping the AI classifier, whose output is
// just the `ia` object) for FLUSSO 1's main confirmed-order branch, proving:
//   - a 23:50 order is accepted when the active SERA session matches;
//   - a genuinely new order at 00:00 is rejected BY THE INTAKE POLICY, and the
//     customer is told creaOrdine's ACTUAL rejection message — never a false
//     "pedido recibido" (the bug this block found and fixed: the 3 creaOrdine
//     call sites in orchestrator.js never checked `.success` before).
// Eseguire: node tests/whatsappIntakePolicy.test.js — no network, no residue.

const supaPath = require.resolve("../src/utils/supabase");
require(supaPath);
const supa = require.cache[supaPath].exports;

let STORE = {};
let INSERTED = [];
supa.sbSelect = async (table, query = "") => {
  if (table === "config") return [];
  if (table === "clientes") return [];
  if (table === "geo_cache") return [];
  if (table === "manual_giros") return [];
  if (table === "conv") return [];
  if (table === "wa_msgs") return [];
  if (table === "ordenes") {
    const mId = query.match(/id=eq\.([^&]+)/);
    if (mId) { const id = decodeURIComponent(mId[1]); return STORE[id] ? [STORE[id]] : []; }
    return [];
  }
  return [];
};
supa.sbInsert = async (table, row) => {
  if (table === "ordenes") { INSERTED.push(row); STORE[row.id] = { ...row }; return [row]; }
  if (table === "clientes") return [{ id: "cli-test" }];
  return [row];
};
supa.sbUpdate = async () => ({});
supa.sbUpsert = async (table, row) => (table === "clientes" ? [{ id: "cli-test", ...row }] : [row]);
supa.sbDelete = async () => ([]);
supa.getConfig = async () => ({});

const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];
require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ ok: true });

const intakePath = require.resolve("../src/serviceSessions/orderIntakePolicy");
const intakeExports = require(intakePath);
const { createGateNewOrderIntake, INTAKE_CODE } = intakeExports;

const { gestisci } = require("../src/agents/orchestrator");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

// R-DAY3: the schedule decision moved server-side (public.get_order_intake_
// context_v1(), reading real clock_timestamp() — see orderIntakePolicy.js's
// own header). This harness can no longer inject a fake JS-side `now`; it
// instead injects the exact intake context the DB resolver would have
// returned for the scenario under test, via fetchContext — the same seam
// createGateNewOrderIntake already exposes for this purpose (see
// tests/orderIntakePolicy.test.js §C for the isolated unit coverage of that
// seam itself). Service Period is no longer a permission signal at all: the
// 00:05 scenario below no longer needs a "session" fixture, because nothing
// in the new gate ever consults one.
function installGate({ ctx }) {
  require.cache[intakePath].exports.gateNewOrderIntake = createGateNewOrderIntake({
    fetchContext: async () => ctx,
  });
}

function baseIa(hora) {
  return { tipo: "ordine", conf: 95, items: [{ n: "Margherita", q: 1, p: 7 }], hora, tipo_consegna: "RITIRO", direccion: "" };
}

(async () => {
  console.log("\n── WhatsApp order at 23:50, DB resolver reports intake open (SERA) ──");
  STORE = {}; INSERTED = [];
  installGate({ ctx: { canCreateNewOrder: true, businessDate: "2026-07-15", serviceKind: "SERA" } });
  let r = await gestisci({
    waId: "699000001", nombre: "Test", testo: "quiero una margherita",
    ia: baseIa("23:50"), config: {}, conv: null,
    statoOrd: { haOrdine: false }, caricoForno: null, isWhitelist: false, waMsgId: null,
  });
  assert("23:50 order accepted (flusso 1, stato NUEVO, ordenId set)", r.flusso === 1 && r.stato === "NUEVO" && !!r.ordenId, JSON.stringify(r));
  assert("the order was actually inserted into ordenes", INSERTED.length === 1 && INSERTED[0].hora === "23:50");

  console.log("\n── WhatsApp order at 00:00 — DB resolver reports intake closed (AFTER_ORDER_CUTOFF) ──");
  STORE = {}; INSERTED = [];
  installGate({ ctx: { canCreateNewOrder: false, businessDate: "2026-07-15", serviceKind: "SERA" } });
  r = await gestisci({
    waId: "699000002", nombre: "Test", testo: "quiero una margherita",
    ia: baseIa("00:05"), config: {}, conv: null,
    statoOrd: { haOrdine: false }, caricoForno: null, isWhitelist: false, waMsgId: null,
  });
  assert("new WhatsApp order at 00:00 is rejected, not silently confirmed", r.stato === "IN_TRATTAMENTO" && !r.ordenId, JSON.stringify(r));
  assert("rejection motivo is the intake policy's own code (ORDER_INTAKE_CLOSED), not a generic error", r.motivo === INTAKE_CODE.ORDER_INTAKE_CLOSED, r.motivo);
  assert("no order was inserted for the rejected attempt", INSERTED.length === 0);

  console.log("\n── WhatsApp order at 00:05 — R-DAY3: Service Period is no longer consulted at all, only the DB-canonical schedule window ──");
  STORE = {}; INSERTED = [];
  installGate({ ctx: { canCreateNewOrder: false, businessDate: "2026-07-15", serviceKind: "SERA" } });
  r = await gestisci({
    waId: "699000003", nombre: "Test", testo: "quiero una margherita",
    ia: baseIa("00:10"), config: {}, conv: null,
    statoOrd: { haOrdine: false }, caricoForno: null, isWhitelist: false, waMsgId: null,
  });
  assert("rejected purely on the DB-canonical schedule window (no session concept involved at all post-R-DAY3)", r.stato === "IN_TRATTAMENTO" && !r.ordenId);
  assert("motivo is ORDER_INTAKE_CLOSED (schedule-level, not a session problem)", r.motivo === INTAKE_CODE.ORDER_INTAKE_CLOSED, r.motivo);
  assert("no order inserted", INSERTED.length === 0);

  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
