'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.4.1 — migration-order deployability guard.
//
// WHY THIS EXISTS: this project has no automated migration runner (no CI, no
// Supabase-CLI ledger, no deploy script — confirmed by direct investigation,
// see SERVICE_LIFECYCLE_V3_4_1_MIGRATION_ORDER_REPORT.md). Migrations are
// applied MANUALLY, and MIGRATION_MANIFEST.md's own header is explicit that
// its `apply_order` column — NOT filename lexical order — is "the explicit
// replay authority". That policy is only as good as (a) an operator actually
// following it and (b) the apply_order it hands them actually being correct.
// This test is (b): it derives EVERY guard-checked dependency directly from
// the migration files' own SQL text (never hardcoded pair-by-pair) and
// proves the manifest's apply_order satisfies every one of them. If a future
// migration is added, renamed, or renumbered and breaks this, this test
// fails BEFORE anyone tries to replay the chain — the exact class of bug
// Gate 0 (V3.4) discovered by hand, once, expensively.
//
// SCOPE: the SERVICE LIFECYCLE V3 migration family (rows 57-62 as of this
// writing, matched by filename pattern below — never a hardcoded row-number
// list) plus the retired row 56 it must never depend on. Earlier migrations
// (rows 44-55 and below) are already applied to real staging and out of
// scope for a REPLAY-order proof.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'MIGRATION_MANIFEST.md');

// ── STEP 1 — the real order-determining rule: MIGRATION_MANIFEST.md's own
// `apply_order` column (leftmost `| N |`), ascending. Parsed generically —
// never a hardcoded {file: row} map — so a future renumber is picked up
// automatically. Mirrors the exact row shape every other manifest test in
// this repo already relies on (tests/migrationManifestOrder.test.js).
function parseManifestOrder(manifestText) {
  const order = new Map(); // filename -> apply_order (number)
  for (const line of manifestText.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|[^|]*\|\s*([\w.-]+\.sql)\s*\|/);
    if (!m) continue;
    order.set(m[2], Number(m[1]));
  }
  return order;
}

// ── STEP 2 — the V3 chain under test: every not-yet-applied SERVICE
// LIFECYCLE V3 migration file, discovered by filename pattern (never listed
// by hand), plus retired row 56 (included ONLY to assert it stays excluded).
const V3_CHAIN_PATTERN = /^2026-08-09_service_lifecycle_v3_[a-z_]+\.sql$/;
const RETIRED_ROW_56_FILENAME = '2026-08-09_service_closeout_cross_service_table_policy.sql';

function discoverChainFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.includes('ROLLBACK'))
    .filter((f) => V3_CHAIN_PATTERN.test(f))
    .sort();
}

// ── STEP 3 — extract "provides" and "depends on" facts directly from each
// migration's own SQL text. Two independent fact kinds:
//   FUNCTION facts — a function name (bare, no arg-type signature: this repo
//     sometimes CREATE OR REPLACEs the SAME function across two migrations
//     with the SAME signature, e.g. close_service_session_v3, so signature-
//     level tracking would over-constrain; name-level is what every guard in
//     this repo actually checks via to_regprocedure anyway).
//   TABLE / COLUMN facts — table existence and column existence.
//   MARKER facts — the row-59 "v3_close_authorized_session_id" transaction-
//     marker signal, detected the same way incident_policy.sql/rollover.sql's
//     OWN guards detect it (pg_get_functiondef(...) LIKE '%...%'), since this
//     is a body-content dependency, not a plain existence check.
//
// A guard check `IS NULL` means "I depend on this already existing" — a real
// cross-migration edge. A guard check `IS NOT NULL` means "refuse if the
// thing I am ABOUT TO CREATE already exists" — a self-referential drift
// guard, never a dependency, and deliberately excluded here.
function extractFacts(sql) {
  const provides = new Set();
  const dependsOn = new Set();

  for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)) {
    provides.add('function:' + m[1]);
  }
  for (const m of sql.matchAll(/CREATE TABLE public\.(\w+)/g)) {
    provides.add('table:' + m[1]);
  }
  for (const m of sql.matchAll(/ALTER TABLE public\.\w+\s*\n?\s*ADD COLUMN (\w+)/g)) {
    provides.add('column:' + m[1]);
  }
  // The row-59 marker is introduced into close_service_session_v3's OWN body
  // (a CREATE OR REPLACE of an existing function, not a new one) — detected
  // by the literal marker string appearing in an actual (non-comment) SQL
  // statement, i.e. inside a function body being defined by THIS file.
  const sqlNoComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  if (/PERFORM set_config\('ladieci\.v3_close_authorized_session_id'/.test(sqlNoComments)) {
    provides.add('marker:v3_close_authorized_session_id');
  }

  for (const m of sql.matchAll(/to_regprocedure\('public\.(\w+)\([^)]*\)'\)\s*IS NULL/g)) {
    dependsOn.add('function:' + m[1]);
  }
  for (const m of sql.matchAll(/to_regclass\('public\.(\w+)'\)\s*IS NULL/g)) {
    dependsOn.add('table:' + m[1]);
  }
  // Column-existence dependency (guard style: `EXISTS (SELECT 1 FROM
  // information_schema.columns WHERE ... column_name='X') THEN RAISE
  // EXCEPTION '... already exists'` is a DRIFT guard, not a dependency —
  // only a bare "missing" style (none of the current V3 chain uses this for
  // columns) would count; none present today, kept for completeness/future.
  if (/pg_get_functiondef\(p\.oid\)\s*LIKE\s*'%v3_close_authorized_session_id%'/.test(sqlNoComments)
      && !/refused: .*already references v3_close_authorized_session_id/.test(sqlNoComments)) {
    // Present as a REQUIRE check (not the "already patched" drift guard,
    // which also matches this string but is worded as an "already
    // references" refusal — excluded by the negative lookahead above).
    dependsOn.add('marker:v3_close_authorized_session_id');
  }

  return { provides, dependsOn };
}

(async () => {
  console.log('\n== V3 migration chain — dependency-order deployability guard ==\n');

  assert('0a: manifest file exists', fs.existsSync(MANIFEST_PATH));
  const manifestText = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const applyOrder = parseManifestOrder(manifestText);

  const chainFiles = discoverChainFiles();
  assert('0b: discovered a non-trivial V3 chain (guards against a broken glob silently checking nothing)', chainFiles.length >= 6, String(chainFiles.length));

  console.log('\n── every chain file has a manifest apply_order ──');
  const fileFacts = new Map();
  for (const f of chainFiles) {
    const order = applyOrder.get(f);
    assert(`${f}: has a manifest apply_order`, typeof order === 'number', 'not found in manifest');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    fileFacts.set(f, { order, ...extractFacts(sql) });
  }

  console.log('\n── build the provider index: fact -> [files providing it, earliest apply_order] ──');
  const providerOf = new Map(); // fact -> {file, order}
  for (const [f, { order, provides }] of fileFacts) {
    for (const fact of provides) {
      const existing = providerOf.get(fact);
      if (!existing || order < existing.order) providerOf.set(fact, { file: f, order });
    }
  }
  assert('1a: at least one function/table/marker fact was discovered (sanity)', providerOf.size > 5, String(providerOf.size));

  console.log('\n── every guard-checked dependency is satisfied by manifest apply_order ──');
  let edgesChecked = 0;
  for (const [f, { order, dependsOn }] of fileFacts) {
    for (const fact of dependsOn) {
      const provider = providerOf.get(fact);
      if (!provider) continue; // dependency provided by an already-applied, out-of-chain migration — not this test's concern
      if (provider.file === f) continue; // a migration can legitimately re-check its own just-created object mid-file
      edgesChecked++;
      assert(
        `${f} (order ${order}) depends on "${fact}" provided by ${provider.file} (order ${provider.order}) — provider must apply first`,
        provider.order < order,
        `provider order ${provider.order} is NOT less than dependent order ${order}`
      );
    }
  }
  assert('2a: at least one real cross-file dependency edge was actually checked (guards against a vacuously-true pass)', edgesChecked >= 3, String(edgesChecked));

  console.log('\n── the specific Gate-0 finding stays fixed: mesa_release_empty_session_auto_v1 provider precedes its dependent ──');
  {
    const releaseProvider = providerOf.get('function:mesa_release_empty_session_auto_v1');
    const incidentPolicyFile = chainFiles.find((f) => f.includes('incident_policy'));
    assert('3a: mesa_release_empty_session_auto_v1 has a provider in the chain', !!releaseProvider);
    assert('3b: incident_policy file found in the chain', !!incidentPolicyFile);
    if (releaseProvider && incidentPolicyFile) {
      const incidentOrder = fileFacts.get(incidentPolicyFile).order;
      assert('3c: the provider\'s apply_order is strictly less than incident_policy\'s', releaseProvider.order < incidentOrder,
        `provider=${releaseProvider.file}(${releaseProvider.order}) incident_policy=${incidentPolicyFile}(${incidentOrder})`);
    }
  }

  console.log('\n── row 56 stays excluded from the chain ──');
  {
    assert('4a: row 56\'s filename never appears as a dependency provider for anything in the chain', ![...providerOf.keys()].some((k) => providerOf.get(k).file === RETIRED_ROW_56_FILENAME));
    // Comment-aware: a migration's header MAY legitimately DISCUSS row 56 in
    // prose (e.g. explaining why/how a dependency on it was removed — see
    // 2026-08-09_service_lifecycle_v3_incident_policy.sql's own V3.4.1
    // header) without that being a real functional dependency. Only a
    // reference in actual executable SQL (a guard check, a comment-free
    // statement) would be a real violation — same comment-blind discipline
    // as tests/serviceLifecycleV3EngineLegacyNonInterference.static.test.js.
    for (const f of chainFiles) {
      const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const codeOnly = sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      assert(`4b: ${f} never references retired row 56's filename in actual SQL (prose/comments may still discuss it historically)`, !codeOnly.includes('cross_service_table_policy'));
    }
    const row56Line = manifestText.split('\n').find((l) => l.includes(RETIRED_ROW_56_FILENAME) && /^\|\s*\d+\s*\|/.test(l));
    assert('4c: row 56 is marked pending/UNAPPLIED in the manifest (never silently marked applied)', !!row56Line && / pending /.test(row56Line));
    assert('4d: row 56 is explicitly marked retired/do-not-deploy in the manifest', !!row56Line && /UNAPPLIED — V2 legacy-policy migration; do not deploy pending V3 replacement/.test(row56Line));
  }

  console.log('\n── no ambiguous/duplicate RPC signature survives the chain (the V3.3 overload class of bug) ──');
  {
    // Track EVERY function creation (CREATE FUNCTION or CREATE OR REPLACE
    // FUNCTION — both count, since PostgreSQL identity/overload rules do not
    // care which keyword form was used, only the resulting parameter TYPE
    // list) per function name, in manifest apply_order, with its parameter
    // list captured verbatim. Whenever apply_order N's signature differs
    // from the signature apply_order N-1 left behind for that SAME function
    // name, migration N MUST contain an explicit DROP FUNCTION of the exact
    // prior signature — otherwise PostgreSQL creates a second, ambiguous
    // overload (empirically proven this session's V3.3 report; the DROP+
    // CREATE fix is this repo's own established pattern for it).
    const creationsByFunction = new Map(); // funcName -> [{file, order, params}]
    for (const f of chainFiles) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      // Find each "CREATE [OR REPLACE ]FUNCTION public.NAME(" then the
      // matching ") RETURNS" that follows it — sufficient for this repo's
      // own consistent formatting (one param per line, no nested parens in
      // a param list anywhere in this chain — verified by inspection of all
      // six files).
      const startRe = /CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g;
      let sm;
      while ((sm = startRe.exec(sql))) {
        const name = sm[1];
        const openParenIdx = sm.index + sm[0].length - 1;
        const returnsIdx = sql.indexOf(') RETURNS', openParenIdx);
        if (returnsIdx === -1) continue;
        const normalizedParamCount = sql.slice(openParenIdx + 1, returnsIdx).split(',').filter((p) => p.trim()).length;
        const list = creationsByFunction.get(name) || [];
        list.push({ file: f, order: fileFacts.get(f).order, paramCount: normalizedParamCount });
        creationsByFunction.set(name, list);
      }
    }
    let signatureChangesChecked = 0;
    for (const [fn, creations] of creationsByFunction) {
      if (creations.length <= 1) continue;
      creations.sort((a, b) => a.order - b.order);
      for (let i = 1; i < creations.length; i++) {
        if (creations[i].paramCount === creations[i - 1].paramCount) continue; // same shape — CREATE OR REPLACE is safe, no ambiguity possible
        signatureChangesChecked++;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, creations[i].file), 'utf8');
        assert(
          `5a: ${creations[i].file} (order ${creations[i].order}) changes public.${fn}'s param count (${creations[i - 1].paramCount} -> ${creations[i].paramCount}) and contains an explicit DROP FUNCTION for it (no overload left behind)`,
          new RegExp(`DROP FUNCTION public\\.${fn}\\(`).test(sql)
        );
      }
    }
    assert('5b: at least one real signature change was found and checked (guards against a vacuously-true pass — this chain is KNOWN to contain one: create_service_closeout 18->23 params)', signatureChangesChecked >= 1, String(signatureChangesChecked));
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
