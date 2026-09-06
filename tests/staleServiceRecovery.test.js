"use strict";
// ===============================================================
// STALE SERVICE PROTECTION V1 — src/serviceSessions/staleServiceRecovery.js
//
// The module is a pure decision layer over injected collaborators. These
// tests prove the AUTO_CLOSE_SAFE predicate, the PREVIOUS_SERVICE_PENDING
// contract, the single call into the ONE V3 close authority, idempotency,
// and fail-closed behaviour — with NO database.
// ===============================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const { createStaleServiceRecovery, RECOVERY_CODE } = require("../src/serviceSessions/staleServiceRecovery");

const TODAY = "2026-09-06";
const OLD = "2026-08-25";
const FUTURE = "2026-09-07";

// ── collaborator fakes ─────────────────────────────────────────────────────
function fakes(overrides = {}) {
  const calls = { close: [], scan: [], intake: 0, currentCloseout: 0 };
  const base = {
    session: {
      id: "svc-stale", status: "open", business_date: OLD,
      opened_at: "2026-08-25T17:02:59.058Z",
    },
    canonicalBusinessDate: TODAY,
    scanBlocking: { orders: 0, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 10, gross: 100, collected: 90 } },
    reconThrows: null,
    closeResult: { success: true, code: "V3_CLOSED", idempotent: false, closeoutCorrelationId: "corr-1" },
  };
  const cfg = { ...base, ...overrides };

  const sessionLifecycle = {
    async currentCloseout() {
      calls.currentCloseout += 1;
      if (cfg.currentCloseoutResult) return cfg.currentCloseoutResult;
      if (cfg.session === null) return { ok: true, code: "NO_SERVICE_SESSION", session: null };
      // after a successful close the pointer clears — model that on the Nth call
      if (cfg.closedAfterFirst && calls.currentCloseout > 1) {
        return { ok: true, code: "NO_SERVICE_SESSION", session: null };
      }
      return { ok: true, code: "OK", session: cfg.session };
    },
  };
  const closeAuthority = async (args) => {
    calls.close.push(args);
    if (typeof cfg.closeResult === "function") return cfg.closeResult(args, calls.close.length);
    if (cfg.closeThrows) throw new Error(cfg.closeThrows);
    return cfg.closeResult;
  };
  const fetchIntakeContext = async () => {
    calls.intake += 1;
    if (cfg.intakeThrows) throw new Error(cfg.intakeThrows);
    return cfg.canonicalBusinessDate == null
      ? { businessDate: null }
      : { businessDate: cfg.canonicalBusinessDate, canCreateNewOrder: true, hasValidCurrentService: false };
  };
  const scan = async (opts) => {
    calls.scan.push(opts);
    if (cfg.scanThrows) throw new Error(cfg.scanThrows);
    return { ok: true, service_session_id: cfg.session ? cfg.session.id : null, blocking: cfg.scanBlocking, attivi: [] };
  };
  const reconciliation = {
    async build({ serviceSessionId }) {
      if (cfg.reconThrows) { const e = new Error(cfg.reconThrows); e.code = cfg.reconThrows; throw e; }
      return { ...cfg.recon, __sessionId: serviceSessionId };
    },
  };

  const recovery = createStaleServiceRecovery({
    sessionLifecycle, closeAuthority, fetchIntakeContext, scan, reconciliation,
  });
  return { recovery, calls, cfg };
}

// ── 0. NO_STALE_SERVICE ────────────────────────────────────────────────────
test("nothing open -> NO_STALE_SERVICE, no close, no scan", async () => {
  const { recovery, calls } = fakes({ session: null });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.NO_STALE_SERVICE);
  assert.equal(r.stale, false);
  assert.equal(calls.close.length, 0);
  assert.equal(calls.scan.length, 0);
});

test("open service on the current Business Day -> NO_STALE_SERVICE (never touched)", async () => {
  const { recovery, calls } = fakes({ session: { id: "svc-today", status: "open", business_date: TODAY } });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.NO_STALE_SERVICE);
  assert.equal(r.stale, false);
  assert.equal(r.serviceSessionId, "svc-today");
  assert.equal(calls.close.length, 0);
});

// ── REVIEW FIX — FUTURE-dated open service -> fail closed, never a "previous" ─
test("FUTURE-dated open service -> ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH, fail closed, no scan, no close", async () => {
  const { recovery, calls } = fakes({
    session: { id: "svc-future", status: "open", business_date: FUTURE },
    canonicalBusinessDate: TODAY,
  });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.ok, false, "fail closed — not a definitive proceed");
  assert.equal(r.stale, false, "a future service is NOT stale / NOT a previous service");
  assert.equal(r.code, RECOVERY_CODE.ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH);
  assert.notEqual(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.serviceSessionId, "svc-future");
  assert.equal(r.serviceBusinessDate, FUTURE);
  assert.equal(r.currentBusinessDate, TODAY);
  assert.equal(calls.scan.length, 0, "no pre-close scan — there is nothing to recover");
  assert.equal(calls.close.length, 0, "a future-dated service is NEVER auto-finalized");
});

// ── §17 FUTURE-DATED SYNTHETIC FIXTURE (deterministic) ─────────────────────
test("§17 future-dated fixture: canonical BD 2026-09-06, service business_date 2026-09-07 -> fail closed, no order/table may inherit it", async () => {
  const { recovery, calls } = fakes({
    session: { id: "5e5777c5-future-fixture", status: "open", business_date: "2026-09-07" },
    canonicalBusinessDate: "2026-09-06",
    // even a CLEAN economy must not open a recovery path for a future service
    scanBlocking: { orders: 0, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
  });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.ok, false);
  assert.equal(r.code, RECOVERY_CODE.ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH);
  assert.equal(r.stale, false);
  assert.equal(r.recovered, undefined, "not recovered — no close path exists");
  assert.equal(calls.close.length, 0);
  assert.equal(calls.scan.length, 0);
});

// ── 1. CLEAN STALE -> AUTO-FINALIZE via V3 authority, exactly once ─────────
test("CLEAN stale service -> auto-finalize through the one V3 authority, exactly once", async () => {
  const { recovery, calls } = fakes({
    scanBlocking: { orders: 0, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
  });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.equal(r.recovered, true);
  assert.equal(r.recoveredServiceSessionId, "svc-stale");
  assert.equal(r.staleBusinessDate, OLD);
  assert.equal(r.currentBusinessDate, TODAY);
  assert.equal(calls.close.length, 1, "V3 close authority called exactly once");
  assert.equal(calls.close[0].serviceSessionId, "svc-stale");
  assert.equal(calls.close[0].source, "stale_service_auto_recovery");
  assert.equal(calls.close[0].actor, "system");
});

// ── 2-5. DIRTY STALE -> PREVIOUS_SERVICE_PENDING, no close ────────────────
test("DIRTY stale: blocking.orders > 0 -> PREVIOUS_SERVICE_PENDING, no V3 close", async () => {
  const { recovery, calls } = fakes({
    scanBlocking: { orders: 2, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
  });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.recovered, false);
  assert.equal(r.blockers.orders, 2);
  assert.equal(calls.close.length, 0);
});

test("DIRTY stale: an open table -> PREVIOUS_SERVICE_PENDING", async () => {
  const { recovery, calls } = fakes({ scanBlocking: { orders: 0, tables: 1 }, recon: { ok: true, service: { unpaid: 0, overCollected: 0 } } });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.blockers.tables, 1);
  assert.equal(calls.close.length, 0);
});

test("DIRTY stale: unpaid > 0 -> PREVIOUS_SERVICE_PENDING", async () => {
  const { recovery, calls } = fakes({ scanBlocking: { orders: 0, tables: 0 }, recon: { ok: true, service: { unpaid: 32, overCollected: 0 } } });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.blockers.unpaid, 32);
  assert.equal(calls.close.length, 0);
});

test("DIRTY stale: overCollected > 0 -> PREVIOUS_SERVICE_PENDING", async () => {
  const { recovery, calls } = fakes({ scanBlocking: { orders: 0, tables: 0 }, recon: { ok: true, service: { unpaid: 0, overCollected: 10 } } });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.blockers.overCollected, 10);
  assert.equal(calls.close.length, 0);
});

// ── 6. reconciliation build failure -> fail closed ───────────────────────
test("reconciliation build throws -> PREVIOUS_SERVICE_PENDING (fail closed), no close", async () => {
  const { recovery, calls } = fakes({ scanBlocking: { orders: 0, tables: 0 }, reconThrows: "RECONCILIATION_BUSINESS_DATE_MISSING" });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.blockers.reconciliationError, "RECONCILIATION_BUSINESS_DATE_MISSING");
  assert.equal(calls.close.length, 0);
});

test("the pre-close scan throws -> cannot prove safe -> PREVIOUS_SERVICE_PENDING, no close", async () => {
  const { recovery, calls } = fakes({ scanThrows: "SCAN_BOOM", recon: { ok: true, service: { unpaid: 0, overCollected: 0 } } });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(calls.close.length, 0);
});

// ── 7. multiple / corrupt lifecycle -> fail closed ──────────────────────
test("MULTIPLE_ACTIVE_SERVICE_SESSIONS -> fail closed, stale:false, no close", async () => {
  const { recovery, calls } = fakes({ currentCloseoutResult: { ok: false, code: "MULTIPLE_ACTIVE_SERVICE_SESSIONS" } });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.ok, false);
  assert.equal(r.stale, false);
  assert.equal(r.code, "MULTIPLE_ACTIVE_SERVICE_SESSIONS");
  assert.equal(calls.close.length, 0);
});

test("SERVICE_SESSION_STATE_CORRUPT -> fail closed", async () => {
  const { recovery } = fakes({ currentCloseoutResult: { ok: false, code: "SERVICE_SESSION_STATE_CORRUPT" } });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "SERVICE_SESSION_STATE_CORRUPT");
});

test("canonical Business Day unavailable -> fail closed, no staleness decision", async () => {
  const { recovery, calls } = fakes({ canonicalBusinessDate: null });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.ok, false);
  assert.equal(r.stale, false);
  assert.equal(r.code, RECOVERY_CODE.CANONICAL_BUSINESS_DATE_UNAVAILABLE);
  assert.equal(calls.close.length, 0);
});

// ── 8. concurrent recovery -> no duplicate close ────────────────────────
test("concurrent recovery: two callers, the V3 close authority is idempotent -> no duplicate finalization", async () => {
  let n = 0;
  const { recovery, calls } = fakes({
    scanBlocking: { orders: 0, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
    closeResult: () => {
      n += 1;
      // first caller closes; the second sees the V3 engine's idempotent path
      return n === 1
        ? { success: true, code: "V3_CLOSED", idempotent: false, closeoutCorrelationId: "corr-x" }
        : { success: true, code: "V3_CLOSED", idempotent: true, closeoutCorrelationId: "corr-x" };
    },
  });
  const [a, b] = await Promise.all([
    recovery.recoverStaleService({ actor: "system" }),
    recovery.recoverStaleService({ actor: "system" }),
  ]);
  assert.equal(a.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.equal(b.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.equal(calls.close.filter((c) => c.serviceSessionId === "svc-stale").length, 2, "each caller invokes the authority");
  assert.ok(a.idempotent || b.idempotent, "at least one resolves via the engine's idempotent path — never two real finalizations");
});

test("close failed but the service is already gone (raced) -> idempotent AUTO_RECOVERY_PERFORMED", async () => {
  const { recovery } = fakes({
    scanBlocking: { orders: 0, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
    closeResult: { success: false, code: "V3_CLOSE_SESSION_ALREADY_CLOSED_NOT_RECOVERABLE" },
    closedAfterFirst: true, // currentCloseout on the re-read returns NO_SERVICE_SESSION
  });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  assert.equal(r.recovered, true);
  assert.equal(r.idempotent, true);
});

test("close failed and the service is still open -> PREVIOUS_SERVICE_PENDING with autoCloseError", async () => {
  const { recovery } = fakes({
    scanBlocking: { orders: 0, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
    closeResult: { success: false, code: "V3_CLOSE_RECONCILIATION_MISMATCH" },
    // closedAfterFirst NOT set -> re-read still shows the same open service
  });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.blockers.autoCloseError, "V3_CLOSE_RECONCILIATION_MISMATCH");
});

// ── 9. repeated request after auto-close -> idempotent current-state ─────
test("second call after auto-recovery -> NO_STALE_SERVICE (the pointer cleared)", async () => {
  const { recovery, calls } = fakes({
    scanBlocking: { orders: 0, tables: 0 },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
    closedAfterFirst: true,
  });
  const first = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(first.code, RECOVERY_CODE.AUTO_RECOVERY_PERFORMED);
  const second = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(second.code, RECOVERY_CODE.NO_STALE_SERVICE);
  assert.equal(calls.close.length, 1, "no second finalization");
});

// ── §26 LIVE FIXTURE REGRESSION (deterministic synthetic equivalent) ─────
test("§26 live-fixture equivalent: 42af1de9 shape -> PREVIOUS_SERVICE_PENDING, both blockers kept", async () => {
  // business_date 25/08, currentBusinessDate later; #999032 EN_ENTREGA +
  // #999033 LISTO (blocking.orders = 2), unpaid 32, overCollected 10.
  const { recovery, calls } = fakes({
    session: { id: "42af1de9-8981-4d01-b331-554566bec60a", status: "open", business_date: OLD, opened_at: "2026-08-25T17:02:59.058Z" },
    canonicalBusinessDate: TODAY,
    scanBlocking: { orders: 2, tables: 0 },
    recon: { ok: true, service: { unpaid: 32, overCollected: 10, gross: 161, collected: 139 } },
  });
  const r = await recovery.recoverStaleService({ actor: "system" });
  assert.equal(r.code, RECOVERY_CODE.PREVIOUS_SERVICE_PENDING);
  assert.equal(r.recovered, false);
  assert.equal(r.staleServiceSessionId, "42af1de9-8981-4d01-b331-554566bec60a");
  assert.equal(r.staleBusinessDate, "2026-08-25");
  assert.equal(r.currentBusinessDate, "2026-09-06");
  assert.deepEqual(r.blockers, { orders: 2, tables: 0, unpaid: 32, overCollected: 10, reconciliationError: null });
  assert.equal(calls.close.length, 0, "a dirty stale service is NEVER auto-finalized");
});

// ── the predicate itself, isolated ─────────────────────────────────────────
test("evaluateAutoCloseSafe: only the all-clear combination is safe", async () => {
  const { recovery } = fakes();
  const S = { status: "open" };
  const clean = recovery.evaluateAutoCloseSafe({
    session: S, scan: { blocking: { orders: 0, tables: 0 } },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
  });
  assert.equal(clean.safe, true);
  for (const bad of [
    { scan: { blocking: { orders: 1, tables: 0 } }, recon: { ok: true, service: { unpaid: 0, overCollected: 0 } } },
    { scan: { blocking: { orders: 0, tables: 2 } }, recon: { ok: true, service: { unpaid: 0, overCollected: 0 } } },
    { scan: { blocking: { orders: 0, tables: 0 } }, recon: { ok: true, service: { unpaid: 0.01, overCollected: 0 } } },
    { scan: { blocking: { orders: 0, tables: 0 } }, recon: { ok: true, service: { unpaid: 0, overCollected: 5 } } },
    { scan: { blocking: { orders: 0, tables: 0 } }, recon: { __error: "RECONCILIATION_BUILD_FAILED" } },
    { scan: null, recon: { ok: true, service: { unpaid: 0, overCollected: 0 } } },
  ]) {
    assert.equal(recovery.evaluateAutoCloseSafe({ session: S, ...bad }).safe, false);
  }
  assert.equal(recovery.evaluateAutoCloseSafe({
    session: { status: "closing" }, scan: { blocking: { orders: 0, tables: 0 } },
    recon: { ok: true, service: { unpaid: 0, overCollected: 0 } },
  }).safe, false, "status must be exactly 'open'");
});
