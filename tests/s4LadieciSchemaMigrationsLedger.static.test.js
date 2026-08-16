"use strict";
// MESA / SALA — S4 (public.ladieci_schema_migrations authority ledger).
// Static (source-text) proof for the three migration files and the runtime
// wiring (migrationAuthority.js, index.js /status block, resource-policy
// registry entry) -- same convention as
// tests/s2AttributionWritersReceiptService.static.test.js. The full
// CRITICAL TEST MATRIX (idempotent same-checksum, fail-closed different-
// checksum, DELETE-forbidden, regression-forbidden, lawful promotion,
// CHECK constraints, RLS/REVOKE) was live-validated against real staging
// during this slice via Supabase MCP execute_sql -- against the real table
// where a failure was structurally guaranteed to be a safe no-op (DELETE,
// illegal UPDATE, mismatched-checksum INSERT all raise with zero writes),
// and via an isolated scratch table (dropped immediately after, zero
// residue) for the happy-path lawful-promotion case, which would otherwise
// have permanently altered a real ledger row. Postgres functions/triggers
// cannot run standalone in Node, so that behavioral proof is not
// duplicated here -- same division of labor as every prior slice's static
// test file.
// Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S4.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripComments = (text) => text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const LEDGER = read("migrations/2026-08-15_s4_ladieci_schema_migrations_ledger.sql");
const LEDGER_ROLLBACK = read("migrations/2026-08-15_s4_ladieci_schema_migrations_ledger.ROLLBACK.sql");
const SEED = read("migrations/2026-08-15_s4_ladieci_schema_migrations_bootstrap_seed.sql");
const SEED_ROLLBACK = read("migrations/2026-08-15_s4_ladieci_schema_migrations_bootstrap_seed.ROLLBACK.sql");
const GUARD = read("migrations/2026-08-15_s4_ladieci_schema_migrations_insert_checksum_guard.sql");
const GUARD_ROLLBACK = read("migrations/2026-08-15_s4_ladieci_schema_migrations_insert_checksum_guard.ROLLBACK.sql");
const LEDGER_CODE = stripComments(LEDGER);
const GUARD_CODE = stripComments(GUARD);

console.log("\n== A. Table shape (§15 verbatim) ==");
assert("1a: table name is public.ladieci_schema_migrations, never public.schema_migrations",
  /CREATE TABLE public\.ladieci_schema_migrations/.test(LEDGER));
assert("1b: filename is the PRIMARY KEY",
  /filename\s+text\s+PRIMARY KEY/.test(LEDGER));
assert("1c: verification_status CHECK restricts to exactly verified / bootstrapped_unverified -- no vague boolean, no third status",
  /verification_status\s+text\s+NOT NULL CHECK \(verification_status IN \('verified','bootstrapped_unverified'\)\)/.test(LEDGER));
assert("1d: kind CHECK restricts to ddl/data/repair/bootstrap",
  /kind\s+text\s+NOT NULL CHECK \(kind IN \('ddl','data','repair','bootstrap'\)\)/.test(LEDGER));
assert("1e: ladieci_schema_migrations_verified_chk enforces verified<=>verified_at+verification_method present, bootstrapped_unverified<=>verified_at absent",
  /CONSTRAINT ladieci_schema_migrations_verified_chk CHECK \(\s*\n\s*\(verification_status = 'verified'\s+AND verified_at IS NOT NULL AND verification_method IS NOT NULL\)\s*\n\s*OR\s*\n\s*\(verification_status = 'bootstrapped_unverified' AND verified_at IS NULL\)/.test(LEDGER));
assert("1f: apply_order is UNIQUE",
  /CONSTRAINT ladieci_schema_migrations_apply_order_uq UNIQUE \(apply_order\)/.test(LEDGER));
assert("1g: checksum_sha256 shape matches this project's existing 16-hex-char manifest convention, not a new format",
  /CONSTRAINT ladieci_schema_migrations_checksum_shape_chk CHECK \(checksum_sha256 ~ '\^\[0-9a-f\]\{16\}\$'\)/.test(LEDGER));

console.log("\n== B. Access boundary: service_role only ==");
assert("2a: REVOKE ALL FROM anon, authenticated",
  /REVOKE ALL ON public\.ladieci_schema_migrations FROM anon, authenticated;/.test(LEDGER));
assert("2b: RLS enabled, zero policies (no CREATE POLICY anywhere in this file)",
  /ALTER TABLE public\.ladieci_schema_migrations ENABLE ROW LEVEL SECURITY;/.test(LEDGER) &&
  !/CREATE POLICY/i.test(LEDGER));

console.log("\n== C. Immutability trigger (ledger migration: BEFORE UPDATE OR DELETE only) ==");
assert("3a: DELETE unconditionally raises",
  /IF TG_OP = 'DELETE' THEN\s*\n\s*RAISE EXCEPTION 'ladieci_schema_migrations is append-only: DELETE is forbidden/.test(LEDGER));
assert("3b: every immutable fact (filename/checksum/apply_order/kind/applied_at/applied_by) is compared OLD vs NEW before any UPDATE is allowed",
  /OLD\.filename\s+IS DISTINCT FROM NEW\.filename[\s\S]*?OR OLD\.checksum_sha256 IS DISTINCT FROM NEW\.checksum_sha256[\s\S]*?OR OLD\.apply_order\s+IS DISTINCT FROM NEW\.apply_order[\s\S]*?OR OLD\.kind\s+IS DISTINCT FROM NEW\.kind[\s\S]*?OR OLD\.applied_at\s+IS DISTINCT FROM NEW\.applied_at[\s\S]*?OR OLD\.applied_by\s+IS DISTINCT FROM NEW\.applied_by/.test(LEDGER));
assert("3c: regression (already verified) is explicitly rejected before the promotion check",
  /IF OLD\.verification_status = 'verified' THEN\s*\n\s*RAISE EXCEPTION 'ladieci_schema_migrations: % is already verified/.test(LEDGER));
assert("3d: the only lawful target status for an UPDATE is 'verified'",
  /IF NEW\.verification_status <> 'verified' THEN\s*\n\s*RAISE EXCEPTION 'ladieci_schema_migrations: % -- the only lawful UPDATE is bootstrapped_unverified -> verified'/.test(LEDGER));
assert("3e: ledger migration's trigger fires BEFORE UPDATE OR DELETE only (INSERT guard is the row-76 follow-up, not this file)",
  /CREATE TRIGGER ladieci_schema_migrations_immutable_v1\s*\n\s*BEFORE UPDATE OR DELETE ON public\.ladieci_schema_migrations/.test(LEDGER));

console.log("\n== D. Predecessor guard + post-conditions (ledger migration) ==");
assert("4a: refuses if the ledger already exists",
  /RAISE EXCEPTION 'S4 refused: public\.ladieci_schema_migrations already exists/.test(LEDGER));
assert("4b: escalates if a bare public.schema_migrations exists (S4's own name-collision clause, per spec's STOP condition)",
  /RAISE EXCEPTION 'S4 refused: public\.schema_migrations already exists/.test(LEDGER));
assert("4c: refuses if any S5+ table (order_entities/table_ledger_adjustments/ledger_adjustment_operations) already exists",
  /order_entities','table_ledger_adjustments','ledger_adjustment_operations/.test(LEDGER));
assert("4d: post-condition block asserts table+trigger+RLS all exist before returning success",
  /S4 post-condition failed: public\.ladieci_schema_migrations was not created/.test(LEDGER) &&
  /S4 post-condition failed: immutability trigger missing or disabled/.test(LEDGER) &&
  /S4 post-condition failed: RLS not enabled/.test(LEDGER));

console.log("\n== E. Ledger rollback: drops everything, refuses over real post-bootstrap verification work ==");
assert("5a: drops trigger, function, and table in that order",
  /DROP TRIGGER IF EXISTS ladieci_schema_migrations_immutable_v1[\s\S]*DROP FUNCTION IF EXISTS public\.ladieci_schema_migrations_immutability_v1\(\)[\s\S]*DROP TABLE IF EXISTS public\.ladieci_schema_migrations/.test(LEDGER_ROLLBACK));
assert("5b: refuses if any row carries real (non-bootstrap-seed) verification work",
  /S4 rollback refused: % row\(s\) carry real post-bootstrap verification work/.test(LEDGER_ROLLBACK));

console.log("\n== F. Bootstrap seed: exactly 73 rows, 38 verified / 35 bootstrapped_unverified ==");
const seedValuesBlock = SEED.match(/VALUES\s*\n([\s\S]*?)\nON CONFLICT \(filename\) DO NOTHING;/);
assert("6a: a single VALUES block exists, terminated by ON CONFLICT (filename) DO NOTHING", !!seedValuesBlock);
// Row count via top-level row-opening parens at the start of a VALUES line.
const rowCount = seedValuesBlock ? (seedValuesBlock[1].match(/^\s*\('/gm) || []).length : 0;
assert("6b: exactly 73 rows in the VALUES block", rowCount === 73, `found ${rowCount}`);
const verifiedCount = seedValuesBlock ? (seedValuesBlock[1].match(/'verified'/g) || []).length : 0;
const unverifiedCount = seedValuesBlock ? (seedValuesBlock[1].match(/'bootstrapped_unverified'/g) || []).length : 0;
assert("6c: exactly 38 rows classified verified", verifiedCount === 38, `found ${verifiedCount}`);
assert("6d: exactly 35 rows classified bootstrapped_unverified", unverifiedCount === 35, `found ${unverifiedCount}`);
assert("6e: 38 + 35 = 73 (no row double-classified, none missing)", verifiedCount + unverifiedCount === rowCount);
assert("6f: every row uses kind='bootstrap' (pre-epoch, per §15's REQUIRED_MIGRATIONS post-epoch rule)",
  (seedValuesBlock[1].match(/'bootstrap'/g) || []).length === rowCount);
assert("6g: post-condition block asserts the exact aggregate (73 total / 38 verified / 35 unverified / max(apply_order)=73)",
  /expected 73 bootstrap rows/.test(SEED) &&
  /expected 38 verified rows/.test(SEED) &&
  /expected 35 bootstrapped_unverified rows/.test(SEED) &&
  /expected max\(apply_order\) = 73/.test(SEED));
assert("6h: idempotent -- ON CONFLICT (filename) DO NOTHING",
  /ON CONFLICT \(filename\) DO NOTHING;/.test(SEED));
assert("6i: predecessor guard refuses if the ledger table does not exist yet (seed must run after the DDL migration)",
  /S4 bootstrap-seed refused: public\.ladieci_schema_migrations does not exist/.test(SEED));

console.log("\n== G. Bootstrap seed: apply_order is a contiguous 1..73 sequence, filenames unique ==");
const applyOrders = (seedValuesBlock[1].match(/,\s*(\d+),\s*'bootstrap'/g) || []).map((m) => Number(m.match(/(\d+)/)[0]));
assert("7a: 73 apply_order values extracted", applyOrders.length === 73, `found ${applyOrders.length}`);
assert("7b: apply_order values are exactly {1..73}, no gap, no duplicate",
  (() => {
    const sorted = [...applyOrders].sort((a, b) => a - b);
    const expected = Array.from({ length: 73 }, (_, i) => i + 1);
    return JSON.stringify(sorted) === JSON.stringify(expected);
  })());
const filenames = (seedValuesBlock[1].match(/^\s*\('([^']+)'/gm) || []).map((m) => m.match(/\('([^']+)'/)[1]);
assert("7c: 73 filenames extracted, all unique", filenames.length === 73 && new Set(filenames).size === 73);
assert("7d: rows 71-73 (created after S0, classified live in this slice) are present with the expected filenames",
  filenames.includes("2026-08-15_s1_guard_null_payment_idempotency.sql") &&
  filenames.includes("2026-08-15_s1_auth_audit_payment_events.sql") &&
  filenames.includes("2026-08-15_s2_attribution_writers_receipt_service.sql"));

console.log("\n== H. Bootstrap seed: checksum shape (all 73 must satisfy the table's own CHECK) ==");
const checksums = (seedValuesBlock[1].match(/^\s*\('[^']+',\s*'([0-9a-f]{16})'/gm) || []).map((m) => m.match(/,\s*'([0-9a-f]{16})'/)[1]);
assert("8a: 73 checksums matched the 16-lowercase-hex shape (would be fewer if any row still held a placeholder like the stale S0 §K artifact did)",
  checksums.length === 73, `found ${checksums.length}`);

console.log("\n== I. Row 71 explicitly NOT asserted verified on an inexact ledger-name match ==");
assert("9a: row 71 (s1_guard_null_payment_idempotency) is bootstrapped_unverified with its exact reason documented",
  /2026-08-15_s1_guard_null_payment_idempotency\.sql', 'b56385d2648dd427', 71, 'bootstrap', 'bootstrapped_unverified'/.test(SEED) &&
  /No exact filename-slug match in supabase_migrations\.schema_migrations/.test(SEED));
assert("9b: rows 72 and 73 ARE verified, each with a confirmed exact live slug match",
  /2026-08-15_s1_auth_audit_payment_events\.sql', '7d05b06fa3ca2f30', 72, 'bootstrap', 'verified'/.test(SEED) &&
  /2026-08-15_s2_attribution_writers_receipt_service\.sql', 'ad5e45e02c45cdf8', 73, 'bootstrap', 'verified'/.test(SEED));

console.log("\n== J. Seed rollback is documentation-only (DELETE is unconditionally forbidden) ==");
assert("10a: the seed's own rollback contains no DELETE statement -- explains why, points to the ledger rollback instead",
  !/DELETE FROM/.test(SEED_ROLLBACK) && /2026-08-15_s4_ladieci_schema_migrations_ledger\.ROLLBACK\.sql/.test(SEED_ROLLBACK));

console.log("\n== K. INSERT-time checksum-conflict guard (follow-up migration) ==");
assert("11a: predecessor guard refuses if the INSERT guard is already present",
  /S4 follow-up refused: the INSERT guard is already present/.test(GUARD));
assert("11b: predecessor guard refuses if the trigger already fires on INSERT",
  /S4 follow-up refused: trigger already fires on INSERT/.test(GUARD));
assert("11c: the new INSERT branch compares the incoming checksum against any existing row for the same filename",
  /IF TG_OP = 'INSERT' THEN\s*\n\s*SELECT checksum_sha256 INTO v_existing_checksum\s*\n\s*FROM public\.ladieci_schema_migrations WHERE filename = NEW\.filename;/.test(GUARD));
assert("11d: a mismatch RAISEs with both the existing and attempted checksum named, ERRCODE 23505 (unique-violation family)",
  /IF v_existing_checksum IS NOT NULL AND v_existing_checksum <> NEW\.checksum_sha256 THEN\s*\n\s*RAISE EXCEPTION 'ladieci_schema_migrations: % already recorded with a DIFFERENT checksum[\s\S]*?USING ERRCODE = '23505';/.test(GUARD));
assert("11e: UPDATE/DELETE branches are byte-identical to the ledger migration's original body (comment-stripped)",
  (() => {
    const guardUpdateDelete = GUARD_CODE.match(/IF TG_OP = 'DELETE' THEN[\s\S]*?RETURN NEW;\s*\nEND;/);
    const ledgerUpdateDelete = LEDGER_CODE.match(/IF TG_OP = 'DELETE' THEN[\s\S]*?RETURN NEW;\s*\nEND;/);
    return guardUpdateDelete && ledgerUpdateDelete && guardUpdateDelete[0] === ledgerUpdateDelete[0];
  })());
assert("11f: trigger is DROPped and re-CREATEd (Postgres cannot ALTER a trigger's fired-event list) to now fire on INSERT OR UPDATE OR DELETE",
  /DROP TRIGGER IF EXISTS ladieci_schema_migrations_immutable_v1 ON public\.ladieci_schema_migrations;\s*\nCREATE TRIGGER ladieci_schema_migrations_immutable_v1\s*\n\s*BEFORE INSERT OR UPDATE OR DELETE ON public\.ladieci_schema_migrations/.test(GUARD));
assert("11g: post-condition asserts INSERT/UPDATE/DELETE are all present on the live trigger, and that the 73 bootstrap rows are untouched by this purely-additive fix",
  /S4 follow-up post-condition failed: trigger does not fire on all of INSERT\/UPDATE\/DELETE/.test(GUARD) &&
  /S4 follow-up post-condition failed: bootstrap row count changed unexpectedly \(expected 73/.test(GUARD));
assert("11h: guard rollback restores the pre-follow-up trigger (BEFORE UPDATE OR DELETE only) and refuses if the guard isn't currently present",
  /BEFORE UPDATE OR DELETE ON public\.ladieci_schema_migrations/.test(GUARD_ROLLBACK) &&
  /S4 follow-up rollback refused: the INSERT guard is not currently present/.test(GUARD_ROLLBACK));

console.log("\n== L. Non-interference: S0-S3 architecture and S5+ objects untouched ==");
assert("12a: no S0-S3 owned object (mesa_post_payment_v1, mesa_snapshot_order_lines_v1, service_session_assign_financial_event, supabaseResourcePolicy REGISTRY splice) is mutated by any S4 SQL file",
  !/CREATE OR REPLACE FUNCTION public\.mesa_post_payment_v1/.test(LEDGER + SEED + GUARD) &&
  !/CREATE OR REPLACE FUNCTION public\.mesa_snapshot_order_lines_v1/.test(LEDGER + SEED + GUARD) &&
  !/CREATE OR REPLACE FUNCTION public\.service_session_assign_financial_event/.test(LEDGER + SEED + GUARD));
assert("12b: no S5+ object (order_entities, order_uid, table_ledger_adjustments) is CREATEd anywhere (order_entities/table_ledger_adjustments appear only inside the ledger migration's own predecessor-guard absence-check, never as a CREATE)",
  !/CREATE TABLE public\.order_entities/.test(LEDGER + SEED + GUARD) &&
  !/ADD COLUMN order_uid/.test(LEDGER + SEED + GUARD) &&
  !/CREATE TABLE public\.table_ledger_adjustments/.test(LEDGER + SEED + GUARD));
assert("12c: no UPDATE/DELETE against any of the four append-only financial tables, or payment_transactions, anywhere in S4",
  !/UPDATE\s+public\.(table_order_lines|payment_transactions|payment_allocations|order_financial_events)\b/i.test(stripComments(LEDGER + SEED + GUARD)) &&
  !/DELETE\s+FROM\s+public\.(table_order_lines|payment_transactions|payment_allocations|order_financial_events)\b/i.test(stripComments(LEDGER + SEED + GUARD)));
assert("12d: no ALTER TABLE ... DISABLE TRIGGER anywhere in S4 (S4 is not S8 -- no sanctioned trigger-suspension bypass exists in this slice)",
  !/DISABLE TRIGGER/i.test(LEDGER + SEED + GUARD));

console.log("\n== M. Runtime wiring: migrationAuthority.js, index.js /status, resource-policy registry ==");
const AUTHORITY_JS = read("src/utils/migrationAuthority.js");
assert("13a: REQUIRED_MIGRATIONS exists, frozen, and is empty for this release (S4 is the epoch itself)",
  /const REQUIRED_MIGRATIONS = Object\.freeze\(\[\]\);/.test(AUTHORITY_JS));
assert("13b: getMigrationStatus computes head_verified from verified rows only, head_recorded from all rows",
  /headVerified = verifiedRows\.length/.test(AUTHORITY_JS) &&
  /headRecorded = rows\.length/.test(AUTHORITY_JS));
assert("13c: level is red on any missing-required or checksum-mismatch, yellow on unverified-only, else green (§15 verbatim rule)",
  /missingRequired\.length > 0 \|\| checksumMismatches\.length > 0\)\s*\n\s*\? 'red'\s*\n\s*: \(unverifiedCount > 0 \? 'yellow' : 'green'\)/.test(AUTHORITY_JS));
assert("13d: reads ladieci_schema_migrations via sbSelect (the same runtime-enforced path S3 instrumented), never writes to it",
  /sbSelect\(\s*\n\s*'ladieci_schema_migrations'/.test(AUTHORITY_JS) &&
  !/sbInsert|sbUpdate|sbUpsert|sbDelete/.test(AUTHORITY_JS));

const INDEX_JS = read("index.js");
assert("13e: index.js imports getMigrationStatus AND getMigrationStatusForStatusEndpoint from migrationAuthority (the latter added by the SHADOW fix -- see tests/s4ShadowWindow.test.js)",
  /const \{ getMigrationStatus, getMigrationStatusForStatusEndpoint \} = require\("\.\/src\/utils\/migrationAuthority"\);/.test(INDEX_JS));
assert("13f: /status folds migrations.level into the overall _worstLevel computation ONLY once shadow has completed (SHADOW fix: omitted entirely, not merely pushed as undefined, while migrations.phase === 'shadow')",
  // language-guard: allow-legacy `ordini` below is index.js's own existing local variable name (pre-dating S4), quoted verbatim to assert it's still in the base levels array, not new vocabulary
  /const levels = \[backend\.level, dbCheck\.level, waIn\.level, waProc\.level, ordini\.level\];/.test(INDEX_JS) &&
  /if \(migrations\.phase !== "shadow"\) levels\.push\(migrations\.level\);/.test(INDEX_JS));
assert("13g: /status payload exposes the migrations block under checks.migrations",
  /checks:\s*\{[\s\S]*?migrations,[\s\S]*?\}/.test(INDEX_JS));
assert("13h: boot check logs both heads once at startup, never throws into the boot path",
  /\[S4 boot check\] migration heads:/.test(INDEX_JS) &&
  /\[S4 boot check\] migration status read failed:/.test(INDEX_JS));

const REGISTRY_JS = read("src/utils/supabaseResourcePolicy.js");
assert("13i: ladieci_schema_migrations is registered GET-only (read-only from the runtime's own perspective)",
  /entry\('ladieci_schema_migrations', KIND\.TABLE, \['GET'\], SENSITIVITY\.AUDIT,/.test(REGISTRY_JS));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
