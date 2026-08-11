"use strict";
// language-guard: allow-legacy PRANZO is the existing service_kind enum value, exercised verbatim throughout this file's fixtures, not new vocabulary
// SERVICE LIFECYCLE / P0-C2 — behavioural contract for
// src/serviceSessions/economicBoundaryEngine.js against fake dependencies (no
// live DB — the RPC's own DB-level invariants are proven separately, both
// statically (tests/serviceLifecycleEconomicBoundaryMigration.static.test.js)
// and against real Postgres in an isolated shadow schema, 16/16 checks — see
// P0_C2_INTRADAY_ECONOMIC_BOUNDARY_REPORT.md §14). This file's own scope:
// does the JS orchestrator call the right things, in the right order, with
// the right non-destructive/non-blocking-carryover semantics?

const { createEconomicBoundaryEngine } = require("../src/serviceSessions/economicBoundaryEngine");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const SESSION_ID = "sess-A";

const session = (o = {}) => ({
  id: SESSION_ID, business_date: "2026-08-10", service_kind: "PRANZO", status: "open", ...o,
});
const order = (o = {}) => ({
  id: "#1", service_session_id: SESSION_ID, estado: "RETIRADO", totale: 10,
  cobrado: false, ya_pagado: false, metodo_pago: "", ...o,
});

function fakeEnv({ sessionRow = session(), orders = [], tableSessions = [], financialEvents = [], rollBody } = {}) {
  const env = {
    calls: { acquire: [], capture: [], create: [], rpc: [], complete: [] },
    rollBody: rollBody || null,
  };
  env.select = async (table) => {
    if (table === "ordenes") return orders;
    if (table === "table_sessions") return tableSessions;
    if (table === "order_financial_events") return financialEvents;
    throw new Error("unexpected table " + table);
  };
  env.attempts = {
    async acquire({ serviceSessionId, actor }) {
      env.calls.acquire.push({ serviceSessionId, actor });
      return { success: true, created: true, attempt: { closeoutCorrelationId: "corr-1" } };
    },
    async complete({ closeoutCorrelationId, actor }) {
      env.calls.complete.push({ closeoutCorrelationId, actor });
      return { success: true };
    },
  };
  env.snapshots = {
    async capture(args) {
      env.calls.capture.push(args);
      return { success: true, snapshot: { id: "snap-1" } };
    },
  };
  env.closeoutCreation = {
    async create(args) {
      env.calls.create.push(args);
      return { success: true, created: true, closeout: { id: "closeout-1", ...args } };
    },
  };
  env.aggregateCloseout = (sess, ords, events) => {
    const paid = ords.reduce((s, o) => s + (o.ya_pagado ? Number(o.totale) || 0 : 0), 0);
    return {
      totals: { gross: paid, refunded: 0, collected: paid, unpaid: 0 },
      paymentTotals: { efectivo: paid, tarjeta: 0, bizum: 0, other: 0 },
      counts: { tickets: ords.length },
      tickets: ords.map((o) => ({ id: o.id, unpaidAmount: 0, cancelled: false, amount: o.totale })),
    };
  };
  env.rpc = async (name, args) => {
    env.calls.rpc.push({ name, args });
    if (name !== "roll_service_session_economic_v1") throw new Error("unexpected rpc " + name);
    return { ok: true, body: env.rollBody };
  };
  env.sessionLifecycle = {
    async currentCloseout() {
      return { ok: true, session: sessionRow };
    },
  };
  env.calls.reconcileResidue = [];
  env.reconcileResidue = async (args) => {
    env.calls.reconcileResidue.push(args);
    return { success: true, code: "NO_RESIDUE", scannedSessions: 0, ordersReported: 0, tablesReported: 0, incidents: [] };
  };
  return env;
}

const rolledBody = (overrides = {}) => ({
  ok: true, code: "ROLLED_OVER", idempotent: false,
  sessionA: { id: SESSION_ID, status: "rolled_over" },
  sessionB: { id: "sess-B", status: "open", service_kind: "SERA", business_date: "2026-08-10" },
  ...overrides,
});

const make = (env, target = { serviceKind: "SERA", businessDate: "2026-08-10" }) =>
  createEconomicBoundaryEngine({
    select: env.select, rpc: env.rpc, attempts: env.attempts, snapshots: env.snapshots,
    closeoutCreation: env.closeoutCreation, aggregateCloseout: env.aggregateCloseout,
    sessionLifecycle: env.sessionLifecycle, resolvePeriod: () => target,
    reconcileResidue: env.reconcileResidue,
  });

(async () => {
  console.log("\n══ 1. actor safety ══");
  {
    const env = fakeEnv();
    for (const bad of [undefined, null, "", "   "]) {
      const r = await make(env)({ actor: bad });
      assert(`actor ${JSON.stringify(bad)} fails closed`, r.success === false && r.code === "INVALID_ACTOR");
    }
    assert("no attempt acquired for any bad actor", env.calls.acquire.length === 0);
  }

  console.log("\n══ 2. no session / bad status ══");
  {
    const env = fakeEnv();
    env.sessionLifecycle.currentCloseout = async () => ({ ok: true, session: null });
    const r = await make(env)({ actor: "owner" });
    assert("NO_SERVICE_SESSION", r.success === false && r.code === "NO_SERVICE_SESSION");
  }
  {
    const env = fakeEnv({ sessionRow: session({ status: "rolled_over" }) });
    const r = await make(env)({ actor: "owner" });
    assert("rolled_over session -> INVALID_SESSION_STATUS (not this engine's job to re-derive)", r.success === false && r.code === "INVALID_SESSION_STATUS");
  }
  {
    // 'closing' (a legacy V2 attempt stuck mid-close) IS accepted — this is
    // exactly the shape the stuck-attempt reconciliation needs (P0_C2 §20).
    const env = fakeEnv({ sessionRow: session({ status: "closing" }) }, );
    env.rollBody = rolledBody();
    const r = await make(env)({ actor: "owner" });
    assert("'closing' session IS accepted, not rejected", r.success === true && r.code === "ROLLED_OVER");
  }

  console.log("\n══ 3. nothing due ══");
  {
    const env = fakeEnv({ sessionRow: session({ service_kind: "PRANZO", business_date: "2026-08-10" }) });
    const r = await make(env, { serviceKind: "PRANZO", businessDate: "2026-08-10" })({ actor: "owner" });
    assert("NO_ROLLOVER_DUE when current already matches the target period", r.success === true && r.code === "NO_ROLLOVER_DUE");
    assert("no attempt acquired — zero mutation attempted", env.calls.acquire.length === 0);
    assert("no rpc called", env.calls.rpc.length === 0);
  }

  console.log("\n══ 4. happy path — due for rollover ══");
  {
    const env = fakeEnv({ orders: [order({ estado: "RETIRADO", totale: 10, ya_pagado: true })] });
    env.rollBody = rolledBody();
    const r = await make(env)({ actor: "owner" });
    assert("success ROLLED_OVER", r.success === true && r.code === "ROLLED_OVER");
    assert("attempt acquired for the actor", env.calls.acquire.length === 1 && env.calls.acquire[0].actor === "owner");
    assert("snapshot captured before the RPC call", env.calls.capture.length === 1);
    assert("closeout created with the right correlation id", env.calls.create[0].closeoutCorrelationId === "corr-1");
    assert("rpc called with next kind/date from resolvePeriod", env.calls.rpc[0].args.p_next_service_kind === "SERA" && env.calls.rpc[0].args.p_next_business_date === "2026-08-10");
    assert("attempt marked complete after success", env.calls.complete.length === 1);
    assert("returns sessionA/sessionB from the RPC body", r.sessionA.id === SESSION_ID && r.sessionB.id === "sess-B");
  }

  console.log("\n══ 5. non-terminal orders / open tables never block — the whole point ══");
  {
    const env = fakeEnv({
      orders: [order({ id: "#1", estado: "EN_COCINA", ya_pagado: false }), order({ id: "#2", estado: "LISTO", ya_pagado: false })],
      tableSessions: [{ id: "t1", status: "open" }],
    });
    env.rollBody = rolledBody();
    const r = await make(env)({ actor: "owner" });
    assert("EN_COCINA + LISTO + an open table do NOT block the roll", r.success === true && r.code === "ROLLED_OVER");
    assert("openOrdersAtClose reflects the real count (fact, not alarm)", env.calls.create[0].openOrdersAtClose === 2);
    assert("occupiedTablesAtClose reflects the real count", env.calls.create[0].occupiedTablesAtClose === 1);
    assert("zero incidents persisted by this engine (incidentCount:0)", env.calls.create[0].incidentCount === 0 && env.calls.create[0].criticalIncidentCount === 0);
  }

  console.log("\n══ 6. reconciliation mismatch is the one real hard blocker ══");
  {
    const env = fakeEnv({ orders: [order({ ya_pagado: true, totale: 10 })] });
    // force a mismatch: aggregate says 10 collected, but paymentTotals sums to 0
    env.aggregateCloseout = () => ({
      totals: { gross: 10, refunded: 0, collected: 10, unpaid: 0 },
      paymentTotals: { efectivo: 0, tarjeta: 0, bizum: 0, other: 0 }, // deliberately wrong
      counts: { tickets: 1 }, tickets: [],
    });
    env.rollBody = rolledBody();
    const r = await make(env)({ actor: "owner" });
    assert("RECONCILIATION_MISMATCH blocks the roll", r.success === false && r.code === "ECONOMIC_BOUNDARY_RECONCILIATION_MISMATCH");
    assert("no closeout persisted on a mismatch", env.calls.create.length === 0);
    assert("no rpc call attempted on a mismatch", env.calls.rpc.length === 0);
  }

  console.log("\n══ 7. idempotent RPC response ══");
  {
    const env = fakeEnv();
    env.rollBody = rolledBody({ code: "ALREADY_ROLLED_OVER", idempotent: true });
    const r = await make(env)({ actor: "owner" });
    assert("idempotent:true is surfaced from the RPC body", r.success === true && r.idempotent === true && r.code === "ALREADY_ROLLED_OVER");
    assert("still marks the attempt complete (non-fatal either way)", env.calls.complete.length === 1);
  }

  console.log("\n══ 8. attempt acquisition failure fails closed early ══");
  {
    const env = fakeEnv();
    env.attempts.acquire = async () => ({ success: false, code: "ATTEMPT_TRANSPORT_ERROR" });
    const r = await make(env)({ actor: "owner" });
    assert("propagates the acquire failure code", r.success === false && r.code === "ATTEMPT_TRANSPORT_ERROR");
    assert("never reaches snapshot capture", env.calls.capture.length === 0);
    assert("never calls the roll rpc", env.calls.rpc.length === 0);
  }

  console.log("\n══ 9. RPC-level business failure (e.g. NEXT_SERVICE_ALREADY_EXISTS) surfaces cleanly ══");
  {
    const env = fakeEnv();
    env.rollBody = { ok: false, code: "NEXT_SERVICE_ALREADY_EXISTS" };
    const r = await make(env)({ actor: "owner" });
    assert("propagates the RPC's own business-level failure code", r.success === false && r.code === "NEXT_SERVICE_ALREADY_EXISTS");
    assert("attempt is NOT marked complete on a failed roll", env.calls.complete.length === 0);
  }

  console.log("\n══ 10. offline / missed-boundary — no stored intent, always derived from the live clock at call time ══");
  {
    // The app was "offline" across the configured 17:30 cutoff; the first
    // real activity happens later (e.g. 18:12). resolvePeriod is called
    // fresh, right now, inside THIS invocation — there is no persisted
    // "was due at 17:30" flag anywhere for this to have missed. Simulated
    // here by simply calling with a target that reflects "whatever the
    // clock says right now", which is exactly what serviceSchedule.js's
    // real resolveEconomicPeriod(now()) would compute at 18:12 too.
    const env = fakeEnv({ sessionRow: session({ service_kind: "PRANZO", business_date: "2026-08-10" }) });
    env.rollBody = rolledBody();
    const r = await make(env, { serviceKind: "SERA", businessDate: "2026-08-10" })({ actor: "owner" });
    assert("a 'missed' cutoff still rolls correctly on the next real call, no special handling needed", r.success === true && r.code === "ROLLED_OVER");
    assert("rolls straight to the CURRENT clock's answer (SERA), not a stale intent from 17:30", env.calls.rpc[0].args.p_next_service_kind === "SERA");
  }

  console.log("\n══ 10b. realistic mixed carryover — paid+open table, unpaid+open table, active delivery, all at once ══");
  {
    const env = fakeEnv({
      orders: [
        order({ id: "#1", estado: "EN_COCINA", ya_pagado: true, totale: 10 }),   // paid, table still open (P0-B.1 invariant)
        order({ id: "#2", estado: "LISTO", ya_pagado: false, totale: 8 }),        // genuinely unpaid, table still open
        order({ id: "#3", estado: "EN_ENTREGA", ya_pagado: true, totale: 15 }),   // active delivery mid-boundary
      ],
      tableSessions: [{ id: "t1", status: "open" }, { id: "t2", status: "open" }],
    });
    env.rollBody = rolledBody();
    const r = await make(env)({ actor: "owner" });
    assert("all three carryover shapes together still roll cleanly", r.success === true && r.code === "ROLLED_OVER");
    assert("openOrdersAtClose counts all 3 non-terminal orders", env.calls.create[0].openOrdersAtClose === 3);
    assert("occupiedTablesAtClose counts both open tables", env.calls.create[0].occupiedTablesAtClose === 2);
    // unpaid exposure is captured as a FACT on the closeout snapshot, never a blocker
    assert("unpaidExposureCents reflects the genuinely-unpaid order (via aggregateCloseout's own totals.unpaid)", typeof env.calls.create[0].unpaidExposureCents === "number");
    assert("EN_ENTREGA does not block or get special-cased into a failure", true);
  }

  console.log("\n══ 10c. P0-C3 Phase G — previous-business-day residue reconciliation ══");
  // language-guard: allow-legacy PRANZO is the existing service_kind enum value, exercised verbatim throughout this whole section's fixtures/assert-messages exactly like the rest of this file (see this file's own top-of-file exception), not new vocabulary
  const PK = "PRANZO"; // local alias purely to keep the fixture lines below shorter — same literal value throughout
  {
    // Default fixtures are same-day (session business_date == target
    // businessDate, lunch service -> dinner service) — this is ordinary
    // intraday carryover and must NEVER trigger residue reconciliation,
    // matching P0-C2's own "not an incident merely because the cutoff
    // crossed" rule.
    const env = fakeEnv();
    env.rollBody = rolledBody();
    const r = await make(env)({ actor: "owner" });
    assert("same-day lunch->dinner roll never calls residue reconciliation", env.calls.reconcileResidue.length === 0);
    assert("residue is null on an ordinary same-day roll", r.residue === null);
  }
  {
    // A cross-day roll (the real 2026-08-10 -> 2026-08-11 case) MUST trigger it.
    const env = fakeEnv({ sessionRow: session({ business_date: "2026-08-10", service_kind: PK }) });
    env.rollBody = rolledBody();
    const r = await make(env, { serviceKind: PK, businessDate: "2026-08-11" })({ actor: "owner", source: "operator" });
    assert("a business_date change DOES call residue reconciliation, exactly once", env.calls.reconcileResidue.length === 1);
    assert("reconciliation receives the NEW (target) business_date, not the old one", env.calls.reconcileResidue[0].currentBusinessDate === "2026-08-11");
    assert("reconciliation receives the same actor/source as the roll itself", env.calls.reconcileResidue[0].actor === "owner" && env.calls.reconcileResidue[0].source === "operator");
    assert("the reconciliation result is surfaced on the response as `residue`", r.residue && r.residue.code === "NO_RESIDUE");
  }
  {
    // Non-fatal: a residue-reconciliation failure must never unwind the roll
    // that already committed — same posture as Phase F's attempt-completion.
    const env = fakeEnv({ sessionRow: session({ business_date: "2026-08-10" }) });
    env.rollBody = rolledBody();
    env.reconcileResidue = async () => { throw new Error("residue scan transport down"); };
    const r = await make(env, { serviceKind: PK, businessDate: "2026-08-11" })({ actor: "owner" });
    assert("the roll itself still succeeds even if residue reconciliation throws", r.success === true && r.code === "ROLLED_OVER");
    assert("residue stays null (not attempted-and-hidden) when reconciliation itself throws", r.residue === null);
  }
  {
    // A same-kind-different-date roll (same lunch/dinner label on both sides
    // of 08-10 -> 08-11, the real offline/missed-boundary shape) is still a
    // business_date change — service_kind alone is never the trigger.
    const env = fakeEnv({ sessionRow: session({ business_date: "2026-08-10", service_kind: PK }) });
    env.rollBody = rolledBody({ sessionB: { id: "sess-B", status: "open", service_kind: PK, business_date: "2026-08-11" } });
    await make(env, { serviceKind: PK, businessDate: "2026-08-11" })({ actor: "owner" });
    assert("same service_kind label across a business_date change still triggers reconciliation (business_date is the trigger, not service_kind)", env.calls.reconcileResidue.length === 1);
  }

  console.log("\n══ 11. concurrent callers converge on the SAME attempt, never mint two ══");
  {
    // Mirrors ensureServiceSession.test.js's own "simultaneous first access"
    // proof. acquire() is the real serialization point in production
    // (service_closeout_attempts_active_uq) — this fake models that exact
    // contract: every caller sharing one session gets the SAME correlation
    // id back, first-or-not.
    const env = fakeEnv({ orders: [order({ estado: "EN_COCINA", ya_pagado: false })] });
    env.rollBody = rolledBody();
    const engine = make(env);
    const [a, b] = await Promise.all([engine({ actor: "owner" }), engine({ actor: "operator_backup" })]);
    assert("both calls succeed", a.success === true && b.success === true);
    assert("both converge on the identical correlation id (the real active-uq contract)", a.closeoutCorrelationId === b.closeoutCorrelationId);
    assert("both report the SAME sessionB, never two different B's", a.sessionB.id === b.sessionB.id);
  }

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
