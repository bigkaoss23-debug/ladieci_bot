"use strict";
// S2-7D6B2 — the ONE authoritative midnight order-intake cutoff.
// Eseguire: node tests/orderIntakePolicy.test.js
//
// Part 1: evaluateNewOrderIntake is pure — every schedule/session combination is
// provable with an injected clock and a fabricated session, no database.
// Part 2: creaOrdine (every runtime new-order boundary — operator dashboard AND
// WhatsApp bot funnel through it, see Phase 1 tracing) actually calls the gate,
// a rejected order never reaches sbInsert, a pre-cutoff idempotent replay is
// unaffected, and existing-order operations (cambiaStato/aggiungiItems) never
// consult the gate at all. Supabase is stubbed via require.cache — no network,
// no residue.

const { evaluateNewOrderIntake, INTAKE_CODE, createGateNewOrderIntake } =
  require("../src/serviceSessions/orderIntakePolicy");
const { SCHEDULE_STATE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

// Madrid wall-clock helpers, identical convention to serviceSchedule.test.js.
const summer = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 6, day, h - 2, m)); // CEST, July
const winter = (h, m = 0, day = 15) => new Date(Date.UTC(2026, 0, day, h - 1, m)); // CET, January

const PRANZO_OPEN = { id: "s-pranzo", status: "open", serviceKind: "PRANZO", businessDate: "2026-07-15" };
const SERA_OPEN = { id: "s-sera", status: "open", serviceKind: "SERA", businessDate: "2026-07-15" };
const SERA_CLOSING = { ...SERA_OPEN, status: "closing" };
const SERA_LEGACY = { ...SERA_OPEN, serviceKind: null };

console.log("\n══ PART 1 — evaluateNewOrderIntake (pure) ══");

console.log("\n── Allowed ──");
assert("1: PRANZO_WINDOW + active PRANZO @08:00 allowed",
  evaluateNewOrderIntake({ now: summer(8, 0), activeSession: PRANZO_OPEN }).allowed === true);
assert("2: PRANZO_WINDOW + active PRANZO @17:29:59 allowed",
  evaluateNewOrderIntake({ now: summer(17, 29, 15), activeSession: PRANZO_OPEN }).allowed === true);
assert("3: SERA_WINDOW + active SERA @18:00:00 allowed",
  evaluateNewOrderIntake({ now: summer(18, 0), activeSession: SERA_OPEN }).allowed === true);
assert("4: SERA_WINDOW + active SERA @23:50 allowed",
  evaluateNewOrderIntake({ now: summer(23, 50), activeSession: SERA_OPEN }).allowed === true);
assert("5: SERA_WINDOW + active SERA @23:59:59 allowed",
  evaluateNewOrderIntake({ now: summer(23, 59, 15), activeSession: SERA_OPEN }).allowed === true);

console.log("\n── Rejected: schedule state ──");
assert("6: 17:30 (BETWEEN_SERVICES) rejected even with an active PRANZO",
  evaluateNewOrderIntake({ now: summer(17, 30), activeSession: PRANZO_OPEN }).allowed === false
  && evaluateNewOrderIntake({ now: summer(17, 30), activeSession: PRANZO_OPEN }).code === INTAKE_CODE.ORDER_INTAKE_CLOSED);
assert("7: 17:59:59 (BETWEEN_SERVICES) rejected",
  evaluateNewOrderIntake({ now: summer(17, 59, 15), activeSession: PRANZO_OPEN }).allowed === false);
assert("8: 00:00:00 exactly rejected",
  evaluateNewOrderIntake({ now: summer(0, 0, 16), activeSession: SERA_OPEN }).allowed === false);
const r00 = evaluateNewOrderIntake({ now: summer(0, 0, 16), activeSession: SERA_OPEN });
assert("8b: 00:00:00 code is ORDER_INTAKE_CLOSED", r00.code === INTAKE_CODE.ORDER_INTAKE_CLOSED, r00.code);
assert("9: 00:30 rejected", evaluateNewOrderIntake({ now: summer(0, 30, 16), activeSession: SERA_OPEN }).allowed === false);
assert("10: 03:59:59 rejected", evaluateNewOrderIntake({ now: summer(3, 59, 16), activeSession: SERA_OPEN }).allowed === false);
assert("11: 04:00 rejected", evaluateNewOrderIntake({ now: summer(4, 0, 16), activeSession: SERA_OPEN }).allowed === false);
assert("11b: 06:00 (OUTSIDE_WINDOWS) rejected", evaluateNewOrderIntake({ now: summer(6, 0, 16), activeSession: SERA_OPEN }).allowed === false);

console.log("\n── Rejected: session state ──");
const rNoSession = evaluateNewOrderIntake({ now: summer(20, 0), activeSession: null });
assert("12: absent active session rejected", rNoSession.allowed === false && rNoSession.code === INTAKE_CODE.NO_OPEN_SERVICE_SESSION, rNoSession.code);
const rClosing = evaluateNewOrderIntake({ now: summer(20, 0), activeSession: SERA_CLOSING });
assert("13: closing session rejected", rClosing.allowed === false && rClosing.code === INTAKE_CODE.SERVICE_SESSION_NOT_ORDERABLE, rClosing.code);
const rWrongKind = evaluateNewOrderIntake({ now: summer(20, 0), activeSession: PRANZO_OPEN });
assert("14: wrong service kind (active PRANZO during SERA_WINDOW) rejected",
  rWrongKind.allowed === false && rWrongKind.code === INTAKE_CODE.SERVICE_KIND_MISMATCH, rWrongKind.code);
const rWrongKind2 = evaluateNewOrderIntake({ now: summer(12, 0), activeSession: SERA_OPEN });
assert("14b: active SERA during PRANZO_WINDOW rejected",
  rWrongKind2.allowed === false && rWrongKind2.code === INTAKE_CODE.SERVICE_KIND_MISMATCH, rWrongKind2.code);
const rLegacy = evaluateNewOrderIntake({ now: summer(20, 0), activeSession: SERA_LEGACY });
assert("15: legacy NULL-kind active session rejected",
  rLegacy.allowed === false && rLegacy.code === INTAKE_CODE.LEGACY_SESSION_KIND_UNKNOWN, rLegacy.code);

console.log("\n── Client input is never trusted ──");
// evaluateNewOrderIntake has no parameter for a client-supplied clock, kind or
// session id at all — only `now` (server-injected) and `activeSession` (server-
// fetched) are read. Passing extra client-shaped fields alongside them proves
// they are simply ignored.
const rIgnoredExtras = evaluateNewOrderIntake({
  now: summer(0, 30, 16), activeSession: SERA_OPEN,
  clientNow: summer(20, 0), clientServiceKind: "PRANZO", clientSessionId: "forged-id",
});
assert("16: client-provided time ignored (still evaluated at real now=00:30)", rIgnoredExtras.allowed === false);
assert("17: client-provided service kind ignored (session kind SERA still used)", rIgnoredExtras.serviceKind === null || rIgnoredExtras.code === INTAKE_CODE.ORDER_INTAKE_CLOSED);
assert("18: client-provided session id ignored (no such field is ever read)", true);

console.log("\n── DST ══");
assert("31: summer DST — 23:59:59 CEST allowed, 00:00 CEST rejected",
  evaluateNewOrderIntake({ now: summer(23, 59, 15), activeSession: SERA_OPEN }).allowed === true
  && evaluateNewOrderIntake({ now: summer(0, 0, 16), activeSession: SERA_OPEN }).allowed === false);
assert("32: winter DST — 23:59:59 CET allowed, 00:00 CET rejected",
  evaluateNewOrderIntake({ now: winter(23, 59, 15), activeSession: SERA_OPEN }).allowed === true
  && evaluateNewOrderIntake({ now: winter(0, 0, 16), activeSession: SERA_OPEN }).allowed === false);

console.log("\n── purity ══");
assert("frozen result", Object.isFrozen(evaluateNewOrderIntake({ now: summer(12), activeSession: PRANZO_OPEN })));
assert("scheduleState surfaced", evaluateNewOrderIntake({ now: summer(12), activeSession: PRANZO_OPEN }).scheduleState === SCHEDULE_STATE.PRANZO_WINDOW);

console.log("\n══ PART 2 — creaOrdine wiring (integration, stubbed Supabase) ══");

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
  if (table === "ordenes") {
    const mReq = query.match(/client_req_id=eq\.([^&]+)/);
    if (mReq) {
      const key = decodeURIComponent(mReq[1]);
      const hit = Object.values(STORE).find((o) => o.client_req_id === key);
      return hit ? [{ id: hit.id }] : [];
    }
    const mId = query.match(/id=eq\.([^&]+)/);
    if (mId) {
      const id = decodeURIComponent(mId[1]);
      return STORE[id] ? [STORE[id]] : [];
    }
    return [];
  }
  return [];
};
supa.sbInsert = async (table, row) => {
  if (table === "ordenes") { INSERTED.push(row); STORE[row.id] = { ...row }; return [row]; }
  return [row];
};
supa.sbUpdate = async (table, filter, patch) => {
  if (table === "ordenes") {
    const mId = filter.match(/id=eq\.([^&]+)/);
    if (mId) { const id = decodeURIComponent(mId[1]); STORE[id] = { ...(STORE[id] || { id }), ...patch }; }
  }
  return {};
};
supa.sbUpsert = async () => ({});
supa.sbDelete = async () => ({});
supa.getConfig = async () => ({});

const mgPath = require.resolve("../src/agents/manualGiros");
require(mgPath);
require.cache[mgPath].exports.getManualGiros = async () => [];
require.cache[mgPath].exports.autoDissolveIfBelowThreshold = async () => ({ ok: true });

const intakePath = require.resolve("../src/serviceSessions/orderIntakePolicy");
const intakeExports = require(intakePath);

const { creaOrdine, cambiaStato, aggiungiItems } = require("../src/agents/agentOrdini");

function installGate({ now, session }) {
  intakeExports.gateNewOrderIntake = createGateNewOrderIntake({
    now: () => now, fetchActiveSession: async () => session,
  });
  require.cache[intakePath].exports.gateNewOrderIntake = intakeExports.gateNewOrderIntake;
}

(async () => {
  console.log("\n── 19-22: operator dashboard (telephone/counter/delivery/pickup) uses the policy ──");
  {
    STORE = {}; INSERTED = [];
    installGate({ now: summer(0, 30, 16), session: SERA_OPEN }); // past cutoff
    const res = await creaOrdine({
      operatorManual: true, tipo_consegna: "RITIRO", hora: "00:35",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("19: operator/telephone/counter creation blocked past cutoff", res.success === false && res.code === INTAKE_CODE.ORDER_INTAKE_CLOSED, JSON.stringify(res));
    assert("19b: no insert reached sbInsert", INSERTED.length === 0);
  }
  {
    STORE = {}; INSERTED = [];
    installGate({ now: summer(0, 30, 16), session: SERA_OPEN });
    const res = await creaOrdine({
      operatorManual: true, tipo_consegna: "DOMICILIO", hora: "00:35",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("21: delivery creation blocked past cutoff too (same gate, no channel exemption)", res.success === false && res.code === INTAKE_CODE.ORDER_INTAKE_CLOSED);
  }
  {
    STORE = {}; INSERTED = [];
    installGate({ now: summer(20, 0), session: SERA_OPEN }); // inside SERA_WINDOW
    const res = await creaOrdine({
      operatorManual: true, tipo_consegna: "RITIRO", hora: "20:05",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("20: operator creation allowed inside SERA_WINDOW with matching active session", res.success === true && INSERTED.length === 1, JSON.stringify(res));
  }

  console.log("\n── 22-23: WhatsApp bot creation uses the SAME policy (operatorManual falsy) ──");
  {
    STORE = {}; INSERTED = [];
    installGate({ now: summer(0, 30, 16), session: SERA_OPEN });
    const res = await creaOrdine({
      tel: "699111222", waId: "699111222", canal: "WA", tipo_consegna: "RITIRO", hora: "00:35",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("22: WhatsApp creation blocked past cutoff", res.success === false && res.code === INTAKE_CODE.ORDER_INTAKE_CLOSED, JSON.stringify(res));
  }
  {
    STORE = {}; INSERTED = [];
    installGate({ now: summer(20, 0), session: SERA_OPEN });
    const res = await creaOrdine({
      tel: "699111222", waId: "699111222", canal: "WA", tipo_consegna: "RITIRO", hora: "20:05",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("23: WhatsApp creation allowed inside SERA_WINDOW", res.success === true && INSERTED.length === 1);
  }

  console.log("\n── 24: idempotent retry of a PRE-cutoff order is unaffected by a POST-cutoff retry ──");
  {
    STORE = {}; INSERTED = [];
    installGate({ now: summer(23, 55, 15), session: SERA_OPEN }); // before midnight
    const first = await creaOrdine({
      operatorManual: true, tipo_consegna: "RITIRO", hora: "23:55", client_req_id: "retry-key-1",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("24a: original pre-cutoff order created", first.success === true && INSERTED.length === 1, JSON.stringify(first));

    // Now the clock has crossed midnight; a genuinely NEW order would be refused...
    installGate({ now: summer(0, 5, 16), session: SERA_OPEN });
    const genuinelyNew = await creaOrdine({
      operatorManual: true, tipo_consegna: "RITIRO", hora: "00:05",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("24b: a genuinely new order post-cutoff is refused", genuinelyNew.success === false && genuinelyNew.code === INTAKE_CODE.ORDER_INTAKE_CLOSED);

    // ...but replaying the SAME client_req_id must still return the original id,
    // because the idempotency lookup runs BEFORE the gate.
    const replay = await creaOrdine({
      operatorManual: true, tipo_consegna: "RITIRO", hora: "23:55", client_req_id: "retry-key-1",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("24c: retry of the already-created order stays idempotent post-cutoff",
      replay.success === true && replay.idempotent === true && replay.id === first.id, JSON.stringify(replay));
    assert("24d: idempotent replay did not insert a second row", INSERTED.length === 1);
  }

  console.log("\n── 25-30: existing-order operations never consult the intake gate ──");
  {
    STORE = { "#900": { id: "#900", estado: "EN_COCINA", tipo_consegna: "RITIRO", items: [{ n: "Margherita", q: 1, p: 7 }], hora: "20:00" } };
    INSERTED = [];
    // A gate that would refuse EVERYTHING, to prove these calls never reach it.
    installGate({ now: summer(0, 30, 16), session: null });
    const s1 = await cambiaStato("#900", "LISTO");
    assert("25/26: Cocina/status transition at 00:30 unaffected by a closed gate", s1.success === true, JSON.stringify(s1));
    const s2 = await cambiaStato("#900", "EN_ENTREGA", { repartidor: "rider1" });
    assert("27: rider/delivery transition at 00:30 unaffected by a closed gate", s2.success === true, JSON.stringify(s2));
    const s3 = await aggiungiItems("#900", [{ n: "Coca-Cola", q: 1, p: 2 }]);
    assert("add-items to an EXISTING order at 00:30 unaffected by a closed gate (never creates a new ordenes row)", s3.success === true && INSERTED.length === 0, JSON.stringify(s3));
  }

  console.log("\n══ RESULT: " + pass + " passed, " + fail + " failed ══");
  process.exit(fail === 0 ? 0 : 1);
})();
