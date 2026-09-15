'use strict';
// tests/giroAuthorityW3Candidate.static.test.js — Planner W3 (Giro Authority + Projection)
// + W4 (canonical read-boundary cutover, Packets 01 + 02A) static guard. OFFLINE: no DB,
// no network. The behavioural certification ran on an ephemeral PostgreSQL in
// ci/giro-authority-certification/harness/run.js (W3-N01..N30 matrix, provenance kept
// byte-identical below); migration 130 is now applied to STAGING (see
// MIGRATION_MANIFEST.md). This file pins what must stay true in the repository:
//   * the untouched candidate provenance file still says DEFERRED/not-reserved (it is a
//     historical artifact); the REAL numbered migration is verified separately by
//     filename + checksum;
//   * previewTiming.js (W4 Packet 01) and riderReads.js (W4 Packet 02A) are the ONLY
//     live consumers of giroProjectionPort; giroProjectionReader.js is the ONLY live
//     I/O boundary onto giro_projection_v1; nothing else references the Authority or
//     the projection. giro_projection_v1 has exactly one H1B registry entry (W6.0 —
//     restoring the registration its real W4 caller always needed; see the
//     W6_0_REGISTRY_INVARIANT below);
//   * giroFactsPort.js (the W2 temporary shim) is still required by nothing live —
//     the cutover went straight to the canonical projection, never through it;
//   * previewTiming.js no longer reads raw manual_giro_id / manual_giros; riderReads.js
//     no longer treats them as giro-fact truth (only its narrow entrega_ref
//     legacy-metadata enrichment select remains, extended detail in
//     tests/riderReadsW4Packet02A.static.test.js); giroProjectionReader.js reads none
//     of manual_giro_id / manual_giros / salida_ref / dissolved_at / pending_giro_intent
//     — pure I/O only;
//   * timingAssessmentV3 (W2 core) is untouched by this packet;
//   * the forward SQL never writes/alters ordenes, salida_*, config, money, publications,
//     never reads the raw manual_giro_id inside the bounded context, and never defines
//     the operational service or the calendar day on its own;
//   * lock order, private boundary and DEFINER shape are declared;
//   * the capture trigger exists only as the W5 artifact (still not installed).
//
// Run: node tests/giroAuthorityW3Candidate.static.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const ROOT = path.join(__dirname, '..');
const CERT = path.join(ROOT, 'ci', 'giro-authority-certification');
const read = (p) => fs.readFileSync(p, 'utf8');
const FWD_FILE = path.join(CERT, 'candidate', 'giro_authority_v1.sql');
const RB_FILE = path.join(CERT, 'candidate', 'giro_authority_v1.ROLLBACK.sql');
const W5_FILE = path.join(CERT, 'candidate', 'giro_intent_capture_trigger_v1.W5_DORMANT.sql');
const ADAPTER = path.join(ROOT, 'src', 'core', 'delivery', 'giroProjectionPort.js');

// Removes `--` comments (full-line and trailing) so prose can never satisfy or defeat
// an assertion about executable SQL. The candidate has no `--` inside string literals.
const code = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
// Same principle for JS: strips `//` line comments so an explanatory comment describing
// what a module does NOT do (e.g. "never reads raw manual_giro_id") can never itself
// trip a raw-reader assertion. None of the guarded files use `//` inside string literals.
const jsCode = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

section('FILES');
for (const f of [FWD_FILE, RB_FILE, W5_FILE, ADAPTER, path.join(CERT, 'fixture', 'staging_shape_v1.sql'),
  path.join(CERT, 'harness', 'run.js'), path.join(CERT, 'harness', 'matrix.js')]) {
  assert(`exists: ${path.relative(ROOT, f)}`, fs.existsSync(f));
}
const FWD_RAW = read(FWD_FILE);
const FWD = code(FWD_RAW);
const RB = code(read(RB_FILE));
const W5_RAW = read(W5_FILE);
const W5 = code(W5_RAW);

section('NUMBERING — candidate header intact; migration 130 is now the real, applied ledger migration');
assert('header declares FINAL_MIGRATION_NUMBER = DEFERRED', FWD_RAW.includes('FINAL_MIGRATION_NUMBER = DEFERRED'));
assert('header records PLANNER_NEXT_MIGRATION_CANDIDATE = 130 (not reserved)', FWD_RAW.includes('PLANNER_NEXT_MIGRATION_CANDIDATE = 130'));
// The candidate file above (ci/giro-authority-certification/candidate/giro_authority_v1.sql)
// intentionally still says DEFERRED/not-reserved — it is untouched provenance, byte-identical
// to what was certified. The REAL, numbered migration is a separate, later file under
// migrations/ (packaged and applied to STAGING before this W4 packet), verified here by
// exact filename and checksum rather than by absence.
const migFiles = fs.readdirSync(path.join(ROOT, 'migrations'));
const MIGRATION_130_FILE = path.join(ROOT, 'migrations', '2026-09-14_giro_authority_v1_migration_130.sql');
const crypto = require('crypto');
assert('migration-130 file exists under migrations/ (packaged + applied to staging, not just a candidate)',
  migFiles.includes('2026-09-14_giro_authority_v1_migration_130.sql'));
assert('migration-130 file checksum matches the certified/applied sha256',
  fs.existsSync(MIGRATION_130_FILE) &&
  crypto.createHash('sha256').update(fs.readFileSync(MIGRATION_130_FILE)).digest('hex') ===
    'ef7e52ad2a60cbdf1e31ae5b6f7d66b181ae9ef302c1e823702c439301c4d3ab');
const giroAuthoritySqlFiles = migFiles.filter((f) => f.endsWith('.sql') && read(path.join(ROOT, 'migrations', f)).includes('giro_authority')).sort();
// W5 Packet 01 (migration 131) is the first additive migration onto the giro_authority
// schema since W3 -- it adds two new composite commands and touches detach_v1/dissolve_v1,
// so its forward+rollback pair legitimately joins 130's here. W5 Intent Activation
// (migration 132) is the next: capture trigger + consume signal-bump fix + the new
// read-only pending-intent helper + the close_service_session_v3 sweep. W6.1 Lock-Order
// Unification (migration 133) is the next: inserts the L0 dispatch-lock acquisition into
// create_or_move_v1/attach_or_move_v1/detach_v1/dissolve_v1/consume_intent_v1, matching
// what start_rider_trip/rider_collect_and_complete_stop already take first. W6.2 Trip
// Authority Foundation (migration 134) is the next: adds the dormant private trip_authority
// schema (trips/trip_members) + dormant public.start_rider_trip_v2/trip_projection_v1, and
// re-points giro_authority.trip_facts_v1 to prefer canonical trip data when present.
assert('exactly the migration-130, migration-131, migration-132, migration-133 and migration-134 forward+rollback pairs reference giro_authority under migrations/ (MANIFEST excluded, it is narrative)',
  JSON.stringify(giroAuthoritySqlFiles) === JSON.stringify([
    '2026-09-14_giro_authority_v1_migration_130.ROLLBACK.sql',
    '2026-09-14_giro_authority_v1_migration_130.sql',
    '2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.ROLLBACK.sql',
    '2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.sql',
    '2026-09-15_planner_w6_lock_order_unification_v1_migration_133.ROLLBACK.sql',
    '2026-09-15_planner_w6_lock_order_unification_v1_migration_133.sql',
    '2026-09-15_planner_w6_trip_authority_v1_migration_134.ROLLBACK.sql',
    '2026-09-15_planner_w6_trip_authority_v1_migration_134.sql',
    '2026-09-15_w5_intent_activation_v1_migration_132.ROLLBACK.sql',
    '2026-09-15_w5_intent_activation_v1_migration_132.sql',
  ]), giroAuthoritySqlFiles.join(', '));
assert('MIGRATION_MANIFEST.md documents migration 130 (giro_authority row present)',
  read(path.join(ROOT, 'migrations', 'MIGRATION_MANIFEST.md')).includes('giro_authority'));
assert('no migration-127 file of any kind (CASE L still holds, S4 untouched)',
  !migFiles.some((f) => /_migration_127\b/.test(f) || /^2026-\d\d-\d\d_.*127/.test(f)));

section('W4 CUTOVER — canonical reader chain is the ONLY live consumer, nothing else touches it');
const srcFiles = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
  .filter((f) => /\.(js|mjs|ts)$/.test(f)).map((f) => path.join(ROOT, 'src', f));
const READER = path.join(ROOT, 'src', 'core', 'delivery', 'giroProjectionReader.js');
const PREVIEW_TIMING = path.join(ROOT, 'src', 'agents', 'previewTiming.js');
const RIDER_READS = path.join(ROOT, 'src', 'agents', 'riderReads.js');
const MANUAL_GIRO_READS = path.join(ROOT, 'src', 'agents', 'manualGiroReads.js');
const PLANNER_SNAPSHOT = path.join(ROOT, 'src', 'core', 'delivery', 'plannerSnapshot.js');
const GIRO_FACTS_PORT = path.join(ROOT, 'src', 'core', 'delivery', 'giroFactsPort.js');
const MANUAL_GIROS = path.join(ROOT, 'src', 'agents', 'manualGiros.js');
// language-guard: allow-legacy AGENT_ORDINI is the existing identifier being cited, not new vocabulary
const AGENT_ORDINI = path.join(ROOT, 'src', 'agents', 'agentOrdini.js');
const GIRO_INTENT_RECONCILER = path.join(ROOT, 'src', 'delivery', 'giroIntentReconciler.js');
const RESOURCE_POLICY = path.join(ROOT, 'src', 'utils', 'supabaseResourcePolicy.js');
// Packet 01 (previewTiming.js) + Packet 02A (riderReads.js) + Packet 02B (manualGiroReads.js)
// + Final W4 Read-Cutover Packet (plannerSnapshot.js) + W5 Packet 01 (manualGiros.js, the
// single Authority WRITER -- it calls giro_authority_create_or_move_v1/attach_or_move_v1/
// detach_v1/dissolve_v1 directly via sbRpc, never through giroProjectionPort/Reader, which
// language-guard: allow-legacy agentOrdini is the existing identifier being cited, not new vocabulary
// stay the read-only boundary) + W5 Intent Activation (agentOrdini.js's cambiaStato() hooks
// and the new giroIntentReconciler.js module, both calling giro_authority_consume_intent_v1/
// giro_authority_list_pending_intents_v1 directly via sbRpc, same non-projection pattern).
const ALLOWED_PROJECTION_CONSUMERS = new Set([
  ADAPTER, READER, PREVIEW_TIMING, RIDER_READS, MANUAL_GIRO_READS, PLANNER_SNAPSHOT, MANUAL_GIROS,
  // language-guard: allow-legacy AGENT_ORDINI is the existing identifier being cited, not new vocabulary
  AGENT_ORDINI, GIRO_INTENT_RECONCILER,
]);
// The H1B access-control registry is not a live caller of the Authority or the projection —
// it only declares the {resource, method, sensitivity} the 6 approved giro_authority_* RPCs
// are allowed to be invoked with (proven exactly by the W3_REGISTRY_INVARIANT check below).
// Its own resource-name string literals legitimately contain "giro_authority", so it needs a
// narrower, separate allowlist rather than being folded into ALLOWED_PROJECTION_CONSUMERS.
const ALLOWED_NON_CONSUMER_REFERENCES = new Set([RESOURCE_POLICY]);
const live = [...srcFiles, path.join(ROOT, 'index.js')]
  .filter((f) => !ALLOWED_PROJECTION_CONSUMERS.has(f) && !ALLOWED_NON_CONSUMER_REFERENCES.has(f));
const mentions = live.filter((f) => /giro_authority|giro_projection_v1/.test(read(f)));
assert('no live src/** or index.js file outside the allowlisted W4 chain references the Authority or the projection',
  mentions.length === 0, mentions.join(', '));
const requirers = live.filter((f) => /giroProjectionPort|giroProjectionReader/.test(read(f)));
assert('nothing outside the allowlisted W4 chain requires giroProjectionPort/giroProjectionReader',
  requirers.length === 0, requirers.join(', '));
const portRequirers = [...srcFiles, path.join(ROOT, 'index.js')].filter((f) => f !== ADAPTER && /require\([^)]*giroProjectionPort/.test(read(f)));
assert('exactly previewTiming.js + riderReads.js + manualGiroReads.js + plannerSnapshot.js require giroProjectionPort (Packet 01 + 02A + 02B + Final W4 scope, nothing more)',
  portRequirers.length === 4 &&
  portRequirers.includes(PREVIEW_TIMING) && portRequirers.includes(RIDER_READS) &&
  portRequirers.includes(MANUAL_GIRO_READS) && portRequirers.includes(PLANNER_SNAPSHOT),
  portRequirers.join(', '));
assert('previewTiming.js requires giroProjectionReader (the canonical I/O boundary)',
  /require\([^)]*giroProjectionReader/.test(read(PREVIEW_TIMING)));
assert('riderReads.js requires giroProjectionReader (the canonical I/O boundary)',
  /require\([^)]*giroProjectionReader/.test(read(RIDER_READS)));
assert('previewTiming.js no longer reads raw manual_giro_id / manual_giros in executable code (getManualGiros, findCompatibleManualGiro, or the table name outside comments)',
  !/getManualGiros|findCompatibleManualGiro|\bmanual_giros\b/.test(jsCode(read(PREVIEW_TIMING))));
assert('riderReads.js does not require manualGiros.js (no dependency on the writer-adjacent module)',
  !/require\([^)]*\/manualGiros["')]/.test(jsCode(read(RIDER_READS))));
assert('riderReads.js no longer treats raw manual_giro_id / manual_giros as giro-fact truth (only the id+entrega_ref legacy-metadata enrichment select remains)',
  !/g\.dissolved\s*!==\s*true|g\.completed\s*!==\s*true|manual_giro_id=eq\.|manual_giro_id=in\./.test(jsCode(read(RIDER_READS))) &&
  (jsCode(read(RIDER_READS)).match(/sbSelect\(\s*"manual_giros"/g) || []).length === 1);
assert('giroFactsPort.js is required by nothing live (not introduced into the live path)',
  fs.existsSync(GIRO_FACTS_PORT) &&
  ![...srcFiles, path.join(ROOT, 'index.js')].some((f) => f !== GIRO_FACTS_PORT && /require\([^)]*giroFactsPort/.test(read(f))));
assert('giroProjectionReader.js is pure I/O in executable code: no raw manual_giro_id / manual_giros / salida_ref / dissolved_at / pending_giro_intent outside comments',
  fs.existsSync(READER) && !/manual_giro_id|manual_giros|salida_ref|dissolved_at|pending_giro_intent/.test(jsCode(read(READER))));
assert('timingAssessmentV3 still consumes GiroFacts only (no projection import — W2 core untouched by this packet)',
  !/giroProjectionPort|giro_projection/.test(read(path.join(ROOT, 'src', 'core', 'delivery', 'timingAssessmentV3.js'))));
// W3-era invariant was "H1B registry has no Giro Authority resource or RPC" — true only
// while the Authority stayed dormant. W5 Packet 01 (manual giro writer cutover) and W5
// Intent Activation now legitimately call it, so the invariant evolves into a stricter,
// current least-privilege check: registered by NAME, not by absence.
const POLICY = require(path.join(ROOT, 'src', 'utils', 'supabaseResourcePolicy'));
const APPROVED_AUTHORITY_RPCS = new Set([
  'rpc/giro_authority_create_or_move_v1',
  'rpc/giro_authority_attach_or_move_v1',
  'rpc/giro_authority_detach_v1',
  'rpc/giro_authority_dissolve_v1',
  'rpc/giro_authority_consume_intent_v1',
  'rpc/giro_authority_list_pending_intents_v1',
]);
const registeredAuthorityRpcs = POLICY.REGISTRY.filter((e) => e.resource.startsWith('rpc/giro_authority_'));
const registeredAuthorityRpcNames = new Set(registeredAuthorityRpcs.map((e) => e.resource));
assert('W3_REGISTRY_INVARIANT: exactly the 6 approved Giro Authority RPCs are registered, no more, no fewer',
  registeredAuthorityRpcs.length === 6 &&
  APPROVED_AUTHORITY_RPCS.size === registeredAuthorityRpcNames.size &&
  [...APPROVED_AUTHORITY_RPCS].every((r) => registeredAuthorityRpcNames.has(r)),
  registeredAuthorityRpcs.map((e) => e.resource).join(', '));
assert('every approved Giro Authority RPC is POST-only and INTERNAL_OPERATIONAL',
  registeredAuthorityRpcs.every((e) =>
    e.kind === POLICY.KIND.RPC &&
    JSON.stringify(e.allowedMethods) === JSON.stringify(['POST']) &&
    e.sensitivity === POLICY.SENSITIVITY.INTERNAL_OPERATIONAL));
// W6.0 — giro_projection_v1 now has a real, confirmed live caller
// (core/delivery/giroProjectionReader.js readGiroProjection(), consumed since
// W4 Packets 01/02A). The raw-absence invariant this replaced predated that
// cutover and, unlike the dormant Authority RPCs above, pinned a genuine
// defect: the RPC had a live caller but no registry entry, so every real
// Node call failed closed with SUPABASE_RESOURCE_NOT_ALLOWED before any
// network request (see tests/giroProjectionTransportReachability.test.js).
// Evolves exactly the way the Authority RPC invariant above already did:
// registered by NAME, not by absence — exactly rpc/giro_projection_v1,
// nothing else giro_projection-prefixed.
const registeredProjectionResources = POLICY.REGISTRY.filter((e) => e.resource.includes('giro_projection'));
assert('W6_0_REGISTRY_INVARIANT: exactly rpc/giro_projection_v1 is registered as the sole giro_projection resource, no more, no fewer',
  registeredProjectionResources.length === 1 && registeredProjectionResources[0].resource === 'rpc/giro_projection_v1',
  registeredProjectionResources.map((e) => e.resource).join(', '));
assert('rpc/giro_projection_v1 is POST-only and INTERNAL_OPERATIONAL',
  registeredProjectionResources.length === 1 &&
  registeredProjectionResources[0].kind === POLICY.KIND.RPC &&
  JSON.stringify(registeredProjectionResources[0].allowedMethods) === JSON.stringify(['POST']) &&
  registeredProjectionResources[0].sensitivity === POLICY.SENSITIVITY.INTERNAL_OPERATIONAL);
assert('no raw giro_members resource is registered',
  !POLICY.REGISTRY.some((e) => e.resource.includes('giro_members')));
assert('no raw giro_intents resource is registered',
  !POLICY.REGISTRY.some((e) => e.resource.includes('giro_intents')));
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
assert('no DB runtime added to package.json (the harness brings its own)',
  !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /^(pg|embedded-postgres|@electric-sql\/pglite)$/.test(d)));

section('FORWARD — never touches ordenes, salida_*, config, money, publications');
assert('no INSERT/UPDATE/DELETE on public.ordenes', !/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.ordenes\b/i.test(FWD));
assert('no ALTER TABLE public.ordenes', !/ALTER\s+TABLE\s+public\.ordenes\b/i.test(FWD));
const triggers = FWD.match(/CREATE\s+TRIGGER[\s\S]*?;/gi) || [];
assert('the only trigger is the intent one-shot guard on the private table',
  triggers.length === 1 && /ON\s+giro_authority\.giro_intents/i.test(triggers[0]), triggers.join(' | '));
assert('no salida_ref / plan_source / computed_at in executable SQL', !/\b(salida_ref|plan_source|computed_at)\b/.test(FWD));
assert('never takes the dispatch lock', !FWD.includes('LA_DIECI_DRIVER_STATO'));
assert('no publication change', !/(ALTER|CREATE)\s+PUBLICATION|supabase_realtime/i.test(FWD));
for (const id of ['order_financial_events', 'order_obligations', 'payment_transactions', 'order_mark_paid',
  '_ledger_write_payment', 'order_cancel_v1', 'delete_order_if_not_active', 'start_rider_trip',
  'close_rider_trip', 'complete_rider_stop']) {
  assert(`no reference to ${id}`, !new RegExp('\\b' + id + '\\b').test(FWD));
}
assert('no write to public.config (DRIVER_STATO is read-only here)', !/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.config\b/i.test(FWD));
assert('no CASCADE anywhere (forward and rollback)', !/\bCASCADE\b/i.test(FWD) && !/\bCASCADE\b/i.test(RB));
assert('no CREATE POLICY (RLS forced with zero policies)', !/CREATE\s+POLICY/i.test(FWD));

section('BOUNDED CONTEXT — effective membership only; scope is an input');
const bodies = [...FWD.matchAll(/AS\s+\$fn\$([\s\S]*?)\$fn\$;/g)].map((m) => m[1]);
assert('function bodies found', bodies.length > 20, String(bodies.length));
assert('no function body reads the raw ordenes.manual_giro_id (only the one-time D5 precondition does)',
  bodies.every((b) => !/\bmanual_giro_id\b/.test(b)));
assert('no autonomous service definition: no session-status literals in the candidate',
  !/'(open|closing|rolled_over|closed)'/.test(FWD));
assert('no calendar-day logic: no CURRENT_DATE / AT TIME ZONE / now()::date / Madrid clock',
  !/CURRENT_DATE|AT\s+TIME\s+ZONE|now\(\)\s*::\s*date|Europe\/Madrid/i.test(FWD));
assert('every public entry point takes the operational scope as an input parameter',
  (FWD.match(/CREATE\s+FUNCTION\s+public\.[\s\S]*?AS\s+\$fn\$/gi) || []).every((h) => /p_operational_session_ids\s+uuid\[\]/.test(h)));
assert('SCOPE_UNAVAILABLE is a declared consume outcome', /'SCOPE_UNAVAILABLE'/.test(FWD.slice(FWD.indexOf('giro_intents_state_shape_chk'))));

section('LOCK ORDER — giro row first, then order locks, then FOR SHARE on entering orders');
const pubBodies = [...FWD.matchAll(/CREATE\s+FUNCTION\s+public\.(\w+)\([\s\S]*?AS\s+\$fn\$([\s\S]*?)\$fn\$;/g)].map((m) => ({ name: m[1], body: m[2] }));
for (const { name, body } of pubBodies) {
  const giroLock = body.search(/manual_giros\s+mg\s+WHERE\s+mg\.id[^;]*FOR\s+UPDATE/i);
  const orderLock = body.indexOf('lock_orders_v1');
  const share = body.search(/FOR\s+SHARE/i);
  if (giroLock >= 0 && orderLock >= 0) assert(`${name}: giro row (L1) before order locks (L2)`, giroLock < orderLock);
  if (share >= 0) assert(`${name}: FOR SHARE (L4) only after the order locks (L2)`, orderLock >= 0 && orderLock < share);
}
assert('the lock protocol is documented in the candidate header', /LOCK PROTOCOL/.test(FWD_RAW) && /start_rider_trip must take the same row first/.test(FWD_RAW));

section('GIRO RECORD — additive only, no persisted derived state');
const addCols = (FWD.match(/ALTER\s+TABLE\s+public\.manual_giros\s+ADD\s+COLUMN[\s\S]*?;/i) || [''])[0];
const colNames = [...addCols.matchAll(/ADD\s+COLUMN\s+(\w+)/gi)].map((m) => m[1]);
assert('manual_giros gains exactly business_date, anchor_order_uid, dissolved_by',
  JSON.stringify(colNames) === JSON.stringify(['business_date', 'anchor_order_uid', 'dissolved_by']), colNames.join(','));
const ddl = (FWD.match(/CREATE\s+TABLE[\s\S]*?\n\);/gi) || []).join('\n');
assert('no persisted giro_state / completed / closed column', !/\b(giro_state|completed|closed)\s+(text|boolean|timestamptz)/i.test(ddl + addCols));
assert('dissolved_at is written only by the explicit dissolve command',
  (FWD.match(/SET\s+dissolved_at\s*=/gi) || []).length === 1 && /giro_authority_dissolve_v1[\s\S]*SET\s+dissolved_at\s*=/.test(FWD));

section('PRIVATE BOUNDARY + DEFINER SHAPE');
assert('schema giro_authority owned by postgres', /CREATE\s+SCHEMA\s+giro_authority\s+AUTHORIZATION\s+postgres/i.test(FWD));
assert('schema: REVOKE ALL from PUBLIC and from anon, authenticated, service_role',
  /REVOKE\s+ALL\s+ON\s+SCHEMA\s+giro_authority\s+FROM\s+PUBLIC/i.test(FWD) &&
  /REVOKE\s+ALL\s+ON\s+SCHEMA\s+giro_authority\s+FROM\s+anon,\s*authenticated,\s*service_role/i.test(FWD));
for (const t of ['giro_members', 'giro_intents']) {
  assert(`${t}: RLS enabled and forced`, new RegExp(`giro_authority\\.${t}\\s+ENABLE\\s+ROW`, 'i').test(FWD) &&
    new RegExp(`giro_authority\\.${t}\\s+FORCE\\s+ROW`, 'i').test(FWD));
  assert(`${t}: REVOKE ALL from PUBLIC, anon, authenticated, service_role (service_role named)`,
    new RegExp(`REVOKE\\s+ALL\\s+ON\\s+giro_authority\\.${t}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role`, 'i').test(FWD));
}
const fnHeads = [...FWD.matchAll(/CREATE\s+FUNCTION\s+([\w.]+)\(([\s\S]*?)AS\s+\$fn\$/gi)];
const names = fnHeads.map((m) => m[1]);
assert('every function pins SET search_path = pg_catalog, pg_temp',
  fnHeads.length > 20 && fnHeads.every((m) => /SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp/i.test(m[2])));
assert('every function is in giro_authority or is a public entry point',
  names.every((n) => n.startsWith('giro_authority.') || /^public\.(giro_authority_\w+_v1|giro_projection_v1)$/.test(n)), names.join(','));
const pub = fnHeads.filter((m) => m[1].startsWith('public.'));
assert('exactly 8 public entry points, all SECURITY DEFINER', pub.length === 8 && pub.every((m) => /SECURITY\s+DEFINER/i.test(m[2])));
assert('every function has an explicit OWNER TO postgres',
  names.every((n) => new RegExp(`ALTER\\s+FUNCTION\\s+${n.replace('.', '\\.')}\\(.*\\)\\s+OWNER\\s+TO\\s+postgres`, 'i').test(FWD)));
assert('EXECUTE is revoked from PUBLIC, anon, authenticated, service_role for every Authority function',
  /REVOKE\s+ALL\s+ON\s+FUNCTION\s+%s\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i.test(FWD));
const grants = FWD.match(/GRANT\s+EXECUTE[^;]*;/gi) || [];
assert('GRANT EXECUTE only to service_role, only on the 8 entry points',
  grants.length === 8 && grants.every((g) => /ON\s+FUNCTION\s+public\.(giro_authority_\w+_v1|giro_projection_v1)\([^)]*\)\s+TO\s+service_role;$/i.test(g.trim())));
assert('no GRANT to anon / authenticated / PUBLIC anywhere', !/GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i.test(FWD));
assert('D5 data precondition present (raw membership and persisted intent refused)',
  FWD.includes('carry a raw manual_giro_id') && FWD.includes('persisted pending_giro_intent'));

section('ROLLBACK — exact reversal');
for (const n of names) {
  assert(`rollback drops ${n}`, new RegExp(`DROP\\s+FUNCTION\\s+${n.replace('.', '\\.')}\\(`, 'i').test(RB));
}
assert('rollback drops both private tables and the schema (RESTRICT)',
  /DROP\s+TABLE\s+giro_authority\.giro_intents;/i.test(RB) && /DROP\s+TABLE\s+giro_authority\.giro_members;/i.test(RB) &&
  /DROP\s+SCHEMA\s+giro_authority;/i.test(RB));
assert('rollback drops the three manual_giros columns',
  ['dissolved_by', 'anchor_order_uid', 'business_date'].every((c) => new RegExp(`DROP\\s+COLUMN\\s+${c}`, 'i').test(RB)));
assert('rollback refuses when Authority data or the W5 trigger exists',
  /data exists/.test(read(RB_FILE)) && /roll W5 back first/.test(read(RB_FILE)));

section('W5 ARTIFACT — the capture trigger exists only here, never applied by W3');
assert('W5 header says NOT PART OF W3', W5_RAW.includes('NOT PART OF W3. NEVER APPLIED BY W3.'));
const w5Triggers = W5.match(/CREATE\s+TRIGGER[\s\S]*?;/gi) || [];
assert('exactly one CREATE TRIGGER: ordenes_zz_giro_intent_capture_v1 BEFORE INSERT ON public.ordenes',
  w5Triggers.length === 1 && /CREATE\s+TRIGGER\s+ordenes_zz_giro_intent_capture_v1\s+BEFORE\s+INSERT\s+ON\s+public\.ordenes/i.test(w5Triggers[0]));
assert('WHEN (NEW.pending_giro_intent IS NOT NULL) and executes the Authority capture function',
  /WHEN\s+\(NEW\.pending_giro_intent\s+IS\s+NOT\s+NULL\)/i.test(W5) && /EXECUTE\s+FUNCTION\s+giro_authority\.capture_giro_intent_v1\(\)/i.test(W5));
assert('W5 asserts it is the last BEFORE INSERT trigger', /is not the last BEFORE INSERT trigger/.test(W5_RAW));
assert('the forward candidate never installs it', !/ordenes_zz_giro_intent_capture_v1/.test(FWD));

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
