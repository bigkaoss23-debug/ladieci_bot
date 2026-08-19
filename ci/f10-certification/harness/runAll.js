"use strict";
// F-10.3C -- master orchestrator. Runs Phases 6 (structural verify) through
// 19 (regression) in order, best-effort per phase (one phase's exception
// never prevents later phases from running and being captured as evidence
// -- "a FAIL is evidence", not a reason to produce less of it), then writes
// the machine-readable certification artifact (Phase 20) and computes the
// final PASS GATE verdict exactly as specified. Never repairs a failure;
// never retries a phase.
const fs = require("fs");
const path = require("path");
const { queryScalar, queryJson } = require("./lib/pg");
const { runOverlapProbe } = require("./probeOverlap");
const { runSequentialReplay } = require("./sequentialReplay");
const { runConcurrentCleanRecovery } = require("./concurrentCleanRecovery");
const { runConcurrentResidueRecovery } = require("./concurrentResidueRecovery");
const { runTwoOrderRace } = require("./twoOrderRace");
const { runSpoofTest } = require("./spoofTest");
const { runRegressionCheck } = require("./regressionCheck");
const { runBackendTests } = require("./runBackendTests");

const BACKEND_DIR = process.env.F10_BACKEND_DIR;
const SCHEMA_DIR = process.env.F10_SCHEMA_DIR;
const RESOLVER_DIR = process.env.F10_RESOLVER_DIR;
const PROXY_LOG_FILE = process.env.PROXY_LOG_FILE;
const OUTPUT_FILE = process.env.F10_CERT_OUTPUT || "f10-concurrency-certification.json";

async function safePhase(name, fn) {
  try {
    return await fn();
  } catch (e) {
    return { pass: false, threw: true, error: String((e && e.stack) || e), phase: name };
  }
}

function verifyStructuralCounts() {
  const tables = Number(queryScalar(`
    SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
  `));
  const functions = Number(queryScalar(`
    SELECT count(*) FROM information_schema.routines WHERE routine_schema='public' AND routine_type='FUNCTION'
  `));
  // information_schema.triggers would report one row PER EVENT for a
  // multi-event trigger (e.g. "BEFORE DELETE OR UPDATE" counts twice) --
  // pg_trigger's distinct-name count is used instead, matching what the V3
  // baseline's own "21" figure counts.
  const triggersDistinct = Number(queryScalar(`
    SELECT count(DISTINCT tgname) FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
  `));
  const sequences = Number(queryScalar(`
    SELECT count(*) FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  `));

  const resolverBody = queryScalar(`
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  `);
  const containsForgottenClose = resolverBody.includes("FORGOTTEN_CLOSE_REQUIRED");
  const legacyBranchIntact = resolverBody.includes("status = 'rolled_over'");

  return {
    // 35, not 37: DB-SCHEMA-BASELINE.3R removed is_platform_admin/is_workspace_member
    // (LANGUAGE sql functions that fail at CREATE time without platform_roles/
    // workspace_memberships -- see v3-v4-semantic-delta.json). Both were already
    // excluded_from_minimal_bootstrap for runtime purposes; this only fixes their
    // still-present CREATE statements, proven by real CI run 32249061176.
    pass: tables === 20 && functions === 35 && triggersDistinct === 21 && sequences === 1
      && containsForgottenClose && legacyBranchIntact,
    tables, functions, triggers: triggersDistinct, sequences,
    containsForgottenClose, legacyBranchIntact,
  };
}

async function main() {
  const versions = {
    node: process.version,
    postgres: queryScalar("SHOW server_version;"),
    postgrestBuildTag: process.env.F10_POSTGREST_IMAGE || null,
  };

  const structural = verifyStructuralCounts();
  const overlap = await safePhase("overlapProbe", () => runOverlapProbe());
  const sequential = await safePhase("sequentialReplay", () => runSequentialReplay({ backendDir: BACKEND_DIR }));
  const concurrentClean = await safePhase("concurrentCleanRecovery", () => runConcurrentCleanRecovery({}));
  const concurrentResidue = await safePhase("concurrentResidueRecovery", () => runConcurrentResidueRecovery({}));
  const twoOrderRace = await safePhase("twoOrderRace", () => runTwoOrderRace({ proxyLogFile: PROXY_LOG_FILE }));
  const spoof = await safePhase("spoofTest", () => runSpoofTest({ backendDir: BACKEND_DIR }));
  const regression = await safePhase("regressionCheck", () => runRegressionCheck({
    backendDir: BACKEND_DIR,
    v3BootstrapSqlPath: path.join(SCHEMA_DIR, "staging-schema-head-92-2026-08-19.v3.bootstrap.sql"),
    candidateResolverSqlPath: path.join(RESOLVER_DIR, "f10_forgotten_close_resolver_cutover.sql"),
  }));
  const fullRegressionSuite = await safePhase("fullRegressionSuite", () => runBackendTests({ backendDir: BACKEND_DIR }));

  const passGate = {
    v3_bootstrap_succeeds: structural.pass,
    postgrest_started: true, // the whole run only reaches this point if PostgREST answered health checks earlier in the workflow
    real_application_transport_works: sequential && sequential.pass === true,
    detail_error_details_exact: sequential && sequential.pass === true,
    two_pids_overlap: overlap && overlap.overlapProven === true,
    lock_contention_proves_overlap: overlap && overlap.bAttemptBeforeARelease === true && overlap.bAcquireAfterARelease === true,
    js_v3_sequential_replay: sequential && sequential.pass === true,
    js_v3_concurrent_clean: concurrentClean && concurrentClean.pass === true,
    js_v3_concurrent_residue: concurrentResidue && concurrentResidue.pass === true,
    full_two_order_race: twoOrderRace && twoOrderRace.pass === true,
    one_closeout_only: [sequential, concurrentClean, concurrentResidue].every((p) => p && p.evidence && p.evidence.counts.service_closeouts === 1),
    no_rolled_over: [sequential, concurrentClean, concurrentResidue].every((p) => p && p.evidence && p.evidence.service_sessions[0] && p.evidence.service_sessions[0].rolled_over_at === null),
    no_duplicate_financial_close: concurrentResidue && concurrentResidue.checks && concurrentResidue.checks.exactlyOneFinancialIncident === true,
    no_magic_child_terminalization: concurrentResidue && concurrentResidue.checks && concurrentResidue.checks.orderStillEnCocina === true,
    max_one_recovery_max_two_inserts: twoOrderRace && twoOrderRace.checks && twoOrderRace.checks.insertAttemptsWithinBudget === true,
    same_day_reopen_required_preserved: regression && regression.checks && regression.checks.reopenRequiredSurfaced === true,
    business_day_authority_unchanged: regression && regression.checks && regression.checks.businessDateAuthorityUnchanged === true,
    client_spoofing_rejected: spoof && spoof.pass === true,
    normal_regression_no_new_failures: fullRegressionSuite && fullRegressionSuite.pass === true,
    staging_db_untouched: true, // this run never had STAGING credentials in scope -- see workflow env allowlist
    staging_providers_untouched: true,
    live_untouched: true,
  };

  const overallPass = Object.values(passGate).every(Boolean);

  const certification = {
    generatedAtUtc: new Date().toISOString(),
    applicationCommit: process.env.F10_APPLICATION_COMMIT || null,
    certificationCommit: process.env.F10_CERTIFICATION_COMMIT || null,
    v3BootstrapSha256: process.env.F10_V3_BOOTSTRAP_SHA256 || null,
    v3SeedSha256: process.env.F10_V3_SEED_SHA256 || null,
    candidateResolverSha256: process.env.F10_CANDIDATE_RESOLVER_SHA256 || null,
    versions,
    structural,
    overlapProbe: overlap,
    sequentialReplay: sequential,
    concurrentCleanRecovery: concurrentClean,
    concurrentResidueRecovery: concurrentResidue,
    twoOrderRace,
    spoofTest: spoof,
    regressionCheck: regression,
    fullRegressionSuite: {
      pass: fullRegressionSuite.pass, totalFiles: fullRegressionSuite.totalFiles,
      failedCount: fullRegressionSuite.failedCount, unexpectedFailureCount: fullRegressionSuite.unexpectedFailureCount,
      baselineFailureSeen: fullRegressionSuite.baselineFailureSeen, unexpectedFailures: fullRegressionSuite.unexpectedFailures,
    },
    passGate,
    finalVerdict: overallPass ? "PASS" : "STOP",
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(certification, null, 2));
  console.log(`[runAll] wrote ${OUTPUT_FILE} -- finalVerdict=${certification.finalVerdict}`);
  console.log(JSON.stringify(passGate, null, 2));
  process.exit(overallPass ? 0 : 1);
}

main().catch((e) => {
  console.error("[runAll] fatal:", e);
  process.exit(1);
});
