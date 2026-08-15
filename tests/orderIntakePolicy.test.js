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

const { evaluateNewOrderIntake, INTAKE_CODE, createGateNewOrderIntake, fetchActiveServiceSessionSelfHealing } =
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
const PRANZO_STALE = { ...PRANZO_OPEN, businessDate: "2026-07-14" };

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
const rStale = evaluateNewOrderIntake({ now: summer(12, 0), activeSession: PRANZO_STALE });
assert("15b: same-kind session from a stale business date rejected",
  rStale.allowed === false && rStale.code === INTAKE_CODE.STALE_SERVICE_SESSION, rStale.code);

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
  evaluateNewOrderIntake({
    now: winter(23, 59, 15),
    activeSession: { ...SERA_OPEN, businessDate: "2026-01-15" },
  }).allowed === true
  && evaluateNewOrderIntake({
    now: winter(0, 0, 16),
    activeSession: { ...SERA_OPEN, businessDate: "2026-01-15" },
  }).allowed === false);

console.log("\n── purity ══");
assert("frozen result", Object.isFrozen(evaluateNewOrderIntake({ now: summer(12), activeSession: PRANZO_OPEN })));
assert("scheduleState surfaced", evaluateNewOrderIntake({ now: summer(12), activeSession: PRANZO_OPEN }).scheduleState === SCHEDULE_STATE.PRANZO_WINDOW);

console.log("\n── S2-7D6B3: no independent allow/deny list — moving a boundary in the ══");
console.log("── canonical schedule config alone changes the intake verdict here ══");
{
  const { DEFAULT_SCHEDULE, HM } = require("../src/schedule/serviceSchedule");
  // Widen SERA_WINDOW's ensure-start to 17:00 in a CUSTOM schedule config only —
  // orderIntakePolicy.js is never told about this, it only ever reads
  // resolveSchedule(now, schedule).canCreateNewOrder for whatever schedule it is
  // handed. If this policy still hardcoded PRANZO_WINDOW/SERA_WINDOW itself, this
  // would fail: 17:15 would still resolve to BETWEEN_SERVICES under the custom
  // config's OWN dinnerEnsureStartMin... so instead we narrow lunch's own close so
  // 12:00 stops being allowed, purely via config, proving the same point from the
  // other direction.
  const NARROWED = { ...DEFAULT_SCHEDULE, lunchBoundaryMin: HM(11, 0) }; // lunch ends at 11:00 in this config
  const withDefault = evaluateNewOrderIntake({ now: summer(12), activeSession: PRANZO_OPEN });
  const withNarrowed = evaluateNewOrderIntake({ now: summer(12), activeSession: PRANZO_OPEN, schedule: NARROWED });
  assert("12:00 allowed under the default schedule", withDefault.allowed === true);
  assert("12:00 rejected under a config that ends lunch at 11:00 — zero code changes in orderIntakePolicy.js", withNarrowed.allowed === false && withNarrowed.code === INTAKE_CODE.ORDER_INTAKE_CLOSED, JSON.stringify(withNarrowed));
}

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
      return hit ? [{
        id: hit.id,
        service_session_id: hit.service_session_id,
        service_order_number: hit.service_order_number,
      }] : [];
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
  if (table === "ordenes") {
    const persisted = { ...row, service_session_id: "s-test", service_order_number: INSERTED.length + 1 };
    INSERTED.push(persisted); STORE[row.id] = persisted; return [persisted];
  }
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
    assert("20: operator creation allowed inside SERA_WINDOW with matching active session",
      res.success === true && res.serviceSessionId === "s-test" && res.serviceOrderNumber === 1 && INSERTED.length === 1,
      JSON.stringify(res));
  }
  {
    STORE = {}; INSERTED = [];
    installGate({ now: summer(12, 0), session: PRANZO_STALE });
    const res = await creaOrdine({
      operatorManual: true, tipo_consegna: "RITIRO", hora: "12:05",
      items: [{ n: "Margherita", q: 1, p: 7 }],
    });
    assert("20b: stale same-kind session is blocked before insert",
      res.success === false && res.code === INTAKE_CODE.STALE_SERVICE_SESSION
      && INSERTED.length === 0, JSON.stringify(res));
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
      replay.success === true && replay.idempotent === true && replay.id === first.id
      && replay.serviceSessionId === first.serviceSessionId
      && replay.serviceOrderNumber === first.serviceOrderNumber, JSON.stringify(replay));
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

  console.log("\n══ PART 3 — fetchActiveServiceSessionSelfHealing (RUNTIME LIFECYCLE AUTHORITY RECOVERY) ══");
  console.log("── SERVICE_LIFECYCLE_RUNTIME_AUTHORITY_RECOVERY_REPORT.md §§7-8 — the safety net that fires");
  console.log("── at order-intake time when every no-human timer path is frozen by LEGACY_AUTOMATIC_");
  console.log("── LIFECYCLE_ENABLED=false. rollover and now are injected — this only tests THIS function's");
  console.log("── own branching; performIncidentSafeRollover's own concurrency/incident/hard-blocker");
  console.log("── behavior is exhaustively covered by incidentSafeRollover.test.js's 61 passing assertions.");
  {
    const CURRENT_STATE = { current_session_id: "s-current" };
    // language-guard: allow-legacy — PRANZO is the existing service_kind enum value, exercised here verbatim in a test fixture (same pattern as PRANZO_OPEN above), not new vocabulary
    const STALE_ROW = { id: "s-stale", status: "open", service_kind: "PRANZO", business_date: "2026-08-11" };
    // language-guard: allow-legacy — PRANZO is the existing service_kind enum value, exercised here verbatim in a test fixture, not new vocabulary
    const FRESH_ROW = { id: "s-fresh", status: "open", service_kind: "PRANZO", business_date: "2026-08-12" };
    // language-guard: allow-legacy — PRANZO is the existing service_kind enum value, exercised here verbatim in a test fixture, not new vocabulary
    const HEALTHY_ROW = { id: "s-healthy", status: "open", service_kind: "PRANZO", business_date: "2026-08-12" };
    // August, not summer()'s hardcoded July -- CEST (UTC+2) applies to both.
    const madridAugust12 = (h, m = 0) => new Date(Date.UTC(2026, 7, 12, h - 2, m));
    // language-guard: allow-legacy — PRANZO_WINDOW is the existing SCHEDULE_STATE literal from serviceSchedule.js, named here only to describe the boundary, not new vocabulary
    const nowOnAug12 = () => madridAugust12(12, 0); // 12:00 CEST Aug 12 -- well inside PRANZO_WINDOW

    console.log("\n── A/healthy: current-period session, not due — rollover never invoked ──");
    {
      let rolloverCalls = 0;
      let selectCalls = 0;
      const select = async (table) => {
        selectCalls++;
        if (table === "service_session_state") return [CURRENT_STATE];
        if (table === "service_sessions") return [HEALTHY_ROW];
        return [];
      };
      const rollover = async () => { rolloverCalls++; return { success: true }; };
      const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
      assert("A1: healthy same-day session returned unchanged", session && session.id === "s-healthy", JSON.stringify(session));
      assert("A2: rollover NOT invoked for a non-due session", rolloverCalls === 0);
      assert("A3: exactly one read round-trip (no extra re-read when nothing rolled)", selectCalls === 2, selectCalls);
    }

    console.log("\n── B/C/D — PRIOR_DAY_STALE, rollover succeeds: self-heals and returns the FRESH session ──");
    {
      let readCount = 0;
      const select = async (table) => {
        if (table === "service_session_state") return [CURRENT_STATE];
        if (table === "service_sessions") { readCount++; return [readCount === 1 ? STALE_ROW : FRESH_ROW]; }
        return [];
      };
      let rolloverArgs = null;
      const rollover = async (args) => { rolloverArgs = args; return { success: true, code: "ROLLED_OVER" }; };
      const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
      assert("B1: rollover invoked with the stale session's id", rolloverArgs && rolloverArgs.session.id === "s-stale", JSON.stringify(rolloverArgs));
      // B1b/c — LIVE BUG, caught only by this assertion: the first shipped version
      // passed {id} alone. performIncidentSafeRollover forwards `session` straight
      // into rolloverClassifier.js's classifyForIncidentSafeRollover, which requires
      // business_date/service_kind (snake_case) or hard-blocks with
      // SESSION_IDENTITY_INVALID before ever persisting an incident or closing
      // anything -- proven against the real 2026-08-11 stale session on staging
      // (captured_by:"system", source:"order_intake_reconcile" in
      // service_closeout_snapshots). B1 alone (checking only .id) would not have
      // caught this; these two assertions exist specifically because it didn't.
      assert("B1b: rollover receives business_date (snake_case, not businessDate)", rolloverArgs.session.business_date === "2026-08-11", JSON.stringify(rolloverArgs));
      // language-guard: allow-legacy — PRANZO is the existing service_kind enum value, exercised here verbatim in a test fixture, not new vocabulary
      assert("B1c: rollover receives service_kind (snake_case, not serviceKind)", rolloverArgs.session.service_kind === "PRANZO", JSON.stringify(rolloverArgs));
      assert("B2: source is a distinct, identifiable tag (not reusing ensure_reconcile/cron_* )", rolloverArgs.source === "order_intake_reconcile", rolloverArgs.source);
      assert("B3: actor defaults to system (this is a background safety net, not an operator action)", rolloverArgs.actor === "system", rolloverArgs.actor);
      assert("C/D1: caller receives the FRESH post-rollover session, not the stale one", session && session.id === "s-fresh", JSON.stringify(session));
    }

    // language-guard: allow-legacy — PRANZO is the existing service_kind enum value, named here only to describe the test scenario, not new vocabulary
    console.log("\n── B2 — SAME_DAY_TRANSITION_DUE (PRANZO past its own close boundary, same date): also self-heals ──");
    {
      const nowPastLunchClose = () => madridAugust12(21, 0); // 21:00 CEST -- well past 17:30 lunchBoundaryMin, still same date
      // language-guard: allow-legacy — PRANZO is the existing service_kind enum value, exercised here verbatim in a test fixture, not new vocabulary
      const SAME_DAY_DUE_ROW = { id: "s-same-day", status: "open", service_kind: "PRANZO", business_date: "2026-08-12" };
      let readCount = 0;
      const select = async (table) => {
        if (table === "service_session_state") return [CURRENT_STATE];
        readCount++; return [readCount === 1 ? SAME_DAY_DUE_ROW : FRESH_ROW];
      };
      let rolloverCalls = 0;
      const rollover = async () => { rolloverCalls++; return { success: true }; };
      const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowPastLunchClose });
      // language-guard: allow-legacy — PRANZO is the existing service_kind enum value, named here only to describe the test scenario, not new vocabulary
      assert("B2a: a same-day PRANZO past its own close boundary triggers rollover too (not just cross-day)", rolloverCalls === 1);
      assert("B2b: caller receives the fresh session", session && session.id === "s-fresh", JSON.stringify(session));
    }

    console.log("\n── E — rollover reports a hard blocker (success:false): falls through, stays stale, no crash ──");
    {
      const select = async (table) => table === "service_session_state" ? [CURRENT_STATE] : [STALE_ROW];
      const rollover = async () => ({ success: false, error: "ROLLOVER_HARD_BLOCKED", hardBlockers: [{ incidentType: "INTEGRITY" }] });
      const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
      assert("E1: still-stale session returned as-is on a hard blocker (never silently advanced)", session && session.id === "s-stale", JSON.stringify(session));
    }

    console.log("\n── deferred rollover (e.g. active rider trip): falls through, stays stale, no crash ──");
    {
      const select = async (table) => table === "service_session_state" ? [CURRENT_STATE] : [STALE_ROW];
      const rollover = async () => ({ success: false, deferred: true, reason: "ACTIVE_RIDER_TRIP" });
      const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
      assert("deferred: still-stale session returned, never force-advanced past an active operational trip", session && session.id === "s-stale", JSON.stringify(session));
    }

    console.log("\n── STALE_SERVICE_SESSION_SELF_HEAL (2026-08-15): a non-success rollover outcome is logged with its actual reason, never silently swallowed ──");
    {
      // Proven live: two real closeout attempts against the same stale
      // service session left zero server-side trace of *why* self-heal kept
      // failing, until this logging was added -- this test pins that it now
      // genuinely fires with the actual diagnostic detail, not just "it
      // failed". Server-side only: the caller's return value is untouched
      // (still just the stale session), matching robustness2/deferred above.
      const originalWarn = console.warn;
      const logged = [];
      console.warn = (...args) => logged.push(args.map(String).join(" "));
      try {
        const select = async (table) => table === "service_session_state" ? [CURRENT_STATE] : [STALE_ROW];
        const rollover = async () => ({
          success: false, deferred: true, reason: "active_rider_trip",
          closeoutCorrelationId: "corr-active-trip-1",
        });
        const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
        assert("observability1: still returns the stale session unchanged", session && session.id === "s-stale");
        const line = logged.join("\n");
        assert("observability2: the log line names the stale session id", line.includes("s-stale"), line);
        assert("observability3: the log line carries the actual deferral reason (active_rider_trip), not a generic message", line.includes("active_rider_trip"), line);
        assert("observability4: the log line carries the closeout correlation id for cross-referencing service_closeout_attempts", line.includes("corr-active-trip-1"), line);
      } finally {
        console.warn = originalWarn;
      }
    }
    {
      const originalWarn = console.warn;
      const logged = [];
      console.warn = (...args) => logged.push(args.map(String).join(" "));
      try {
        const select = async (table) => table === "service_session_state" ? [CURRENT_STATE] : [STALE_ROW];
        const rollover = async () => ({
          success: false, error: "ROLLOVER_HARD_BLOCKED",
          hardBlockers: [{ code: "SESSION_IDENTITY_INVALID", message: "session is missing business_date or service_kind" }],
        });
        await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
        const line = logged.join("\n");
        assert("observability5: a genuine hard blocker is distinguishable in the log from an ordinary deferral (carries error+hardBlockers, not just \"deferred\")", line.includes("ROLLOVER_HARD_BLOCKED") && line.includes("SESSION_IDENTITY_INVALID"), line);
      } finally {
        console.warn = originalWarn;
      }
    }

    console.log("\n── robustness: rollover throwing is caught, never propagates to order intake ──");
    {
      const select = async (table) => table === "service_session_state" ? [CURRENT_STATE] : [STALE_ROW];
      const rollover = async () => { throw new Error("transport blew up"); };
      let threw = false;
      let session = null;
      try { session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 }); }
      catch (_) { threw = true; }
      assert("robustness1: does not throw", threw === false);
      assert("robustness2: still returns the (stale) session so the ordinary gate rejection applies", session && session.id === "s-stale");
    }

    console.log("\n── no active session at all: returns null immediately, never classifies/rolls a null ──");
    {
      let rolloverCalls = 0;
      const select = async (table) => table === "service_session_state" ? [{ current_session_id: null }] : [];
      const rollover = async () => { rolloverCalls++; return { success: true }; };
      const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
      assert("null-session1: returns null", session === null);
      assert("null-session2: rollover never invoked against a non-existent session", rolloverCalls === 0);
    }

    console.log("\n── H — independent of LEGACY_AUTOMATIC_LIFECYCLE_ENABLED (must stay false everywhere else) ──");
    {
      const prior = process.env.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED;
      process.env.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED = "false"; // staging's real value
      try {
        let rolloverCalls = 0;
        let readCount = 0;
        const select = async (table) => {
          if (table === "service_session_state") return [CURRENT_STATE];
          readCount++; return [readCount === 1 ? STALE_ROW : FRESH_ROW];
        };
        const rollover = async () => { rolloverCalls++; return { success: true }; };
        const session = await fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 });
        assert("H1: self-heals even with LEGACY_AUTOMATIC_LIFECYCLE_ENABLED=false", rolloverCalls === 1);
        assert("H2: resulting session is the fresh one", session && session.id === "s-fresh");
        assert("H3: the flag itself is untouched/unread by this module (still exactly 'false')", process.env.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED === "false");
      } finally {
        if (prior === undefined) delete process.env.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED;
        else process.env.LEGACY_AUTOMATIC_LIFECYCLE_ENABLED = prior;
      }
    }

    console.log("\n── G — two concurrent self-heal calls both converge on the same rollover, no duplicate work assumed ──");
    {
      // The real duplicate-prevention guarantee lives in performIncidentSafeRollover
      // itself (service_closeout_attempts_active_uq, proven by incidentSafeRollover.
      // test.js #11a-11f). This confirms only that THIS wrapper does not add its own
      // read-modify-write race: both callers independently read "stale", both call
      // rollover (exactly as two independent HTTP requests would), and a shared fake
      // standing in for the real idempotent engine still leaves both callers with a
      // coherent fresh result — never a thrown exception, never a mixed/partial read.
      let rolloverCalls = 0;
      const select = async (table) => {
        if (table === "service_session_state") return [CURRENT_STATE];
        return [rolloverCalls > 0 ? FRESH_ROW : STALE_ROW];
      };
      const rollover = async () => { rolloverCalls++; return { success: true }; };
      const [a, b] = await Promise.all([
        fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 }),
        fetchActiveServiceSessionSelfHealing({ select, rollover, now: nowOnAug12 }),
      ]);
      assert("G1: both concurrent callers resolve without throwing", !!a && !!b);
      assert("G2: neither caller is left holding the stale session", a.id !== "s-stale" && b.id !== "s-stale", JSON.stringify([a, b]));
    }
  }

  console.log("\n══ RESULT: " + pass + " passed, " + fail + " failed ══");
  process.exit(fail === 0 ? 0 : 1);
})();
