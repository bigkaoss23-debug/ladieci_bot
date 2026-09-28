#!/usr/bin/env node
'use strict';
// ECONOMY 139 -> 156 ROLLOUT PREFLIGHT (R1) -- READ-ONLY. It never writes to any database and never changes a file.
//
// The Economy base package is deployed ONLY by scripts/economyChainApply.js (docs/ECONOMY_139_156_ROLLOUT_CONTRACT.md): one certified step
// per transaction (body + ledger row + registry row + the preflight of the target mode before COMMIT), in EXACTLY this order:
//     [V3 greenfield baseline, ledger row 138] -> 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148 -> GUARDED(149 + 150, ONE transaction)
//     -> [backend] -> 151 -> 152 -> 153 -> 154 -> 155 -> 156   (141 / 142 are Fiscal numbers and are NOT part of it)
// Applying a file by hand (Supabase MCP apply_migration, the SQL editor, psql -f) is NOT a deployment path for this package: nothing else
// runs 149 + 150 atomically nor writes the ledger in the migration's own transaction. This preflight stays the read-only gate of every step.
// POST-ASTRA corrective cycle: 152 = the post-close resolution fact (F1), 153 = the canonical order editor writer (F5 + N1), 154 = the Business
// Day window freshness of the close (F2). The backend of the package is deployed after 150 and BEFORE 151 (an older backend must never meet
// the 151 refusals, ASTRA F7); it works against every later prefix: before 152 a closed-service cancel / adjustment is a typed failure, before
// 153 the editor keeps the direct PATCH (classified fail-closed), before 154 no digest is asked. 154 refuses a reconciliation without the
// digest that backend sends. 152 / 153 / 154 guard on their predecessors themselves; the backend position is an operator step this preflight
// cannot see (BEFORE_151 is where it must already have happened).
// FINAL LIVENESS GATE: 155 = the Planner (start_rider_trip_v2 + three giro_authority commands) takes the order_entities / auth_actors KEY
// SHARE before the order lock (N2 deadlock), 156 = every insert of a day-window fact (order_financial_events, cash_counts) takes the close
// gate (bounded F2 residual). Both are DB-only and backend-agnostic; both guard on their predecessors themselves.
// No migration guard alone enforces the whole chain: 145 requires 143, 146 requires 143 + 145, but NOTHING requires 144 (the
// C8 order_cancel_v1 W-first fix), and 148 guards only on the 145 payment body (not on 146 / 147). This preflight is the gate that does: every mode checks that the database is EXACTLY the expected
// prefix of the chain -- every earlier migration installed with its certified bodies and ledger row, every later one not yet applied
// with its predecessor bodies intact -- so 145 / 146 can never be applied (and POST_APPLY never passes) with 144 skipped.
//
// POST-FINAL-BLIND H-1 (rollout contract amendment): 149 and 150 are applied -- and rolled back -- as ONE step by
// scripts/economy149150GuardedStep.js (lifecycle lock held, no open service, certified files, this preflight in the same session). The
// database never rests at "149 without 150": BEFORE_150 is the transient state INSIDE that step, so the CLI refuses it as a resting mode
// (renderSql still renders it for the step). Every mode also checks section E: no closeout for a service that is still open / closing.
//
// Modes (the state the database must be in when the check runs):
//   PRE_APPLY   before 139 (staging today: ledger tip 138)      BEFORE_140  after 139           BEFORE_143  after 140
//   BEFORE_144  after 143                                       BEFORE_145  after 144           BEFORE_146  after 145
//   BEFORE_147  after 146 (147 = R2, the Mesa refund projection on the canonical obligation; it guards on the 146 body itself)
//   BEFORE_148  after 147 (148 = the legacy paid ambiguity guard in order_post_payment_v1; it guards on the 145 body itself)
//   BEFORE_149  after 148 (149 = R4B, terminal close + attempt completion in one transaction, plus two deferred invariants; it guards on the 139
//               close body, the attempt-completion body and the 148 tip)
//   BEFORE_150  after 149 (150 = the corrective slice: the close is judged against its evidence and commits closeout + reconciliation +
//               close together, a closeout commits only with the terminal close, and the Mesa writer refuses legacy paid ambiguity; it
//               guards on the 149 tip, the 145 Mesa body and every closeout authority it calls)
//   BEFORE_151  after 150 (151 = the final concurrency fix: every obligation revision -- cancel, Cash / Mesa commercial adjustment, totale
//               edit -- takes the close gate (pointer FOR SHARE) and is refused on a service that is no longer open; it guards on the 150
//               tip, the two bodies it replaces, their three callers (the 144 cancel body among them) and the gate-carrying money writers)
//   BEFORE_152  after 151 (the backend of the package was deployed before 151)
//   BEFORE_153  after 152 (152 = the post-close resolution fact: an append-only obligation revision for an order whose service is no longer
//               open, plus its source / cause / provenance constraints and resolution_service_session_id; it guards on the 151 bodies)
//   BEFORE_154  after 153 (153 = order_apply_editor_patch_v1; it guards on 151 and 152)
//   BEFORE_155  after 154 (154 = the day-window digest judged by close_service_session_with_evidence_v1; it guards on 150, 151, 152, 153)
//   BEFORE_156  after 155 (155 = the Planner entity KEY SHARE before the order lock; it guards on 151 .. 154 and on the four bodies it replaces)
//   POST_APPLY  after 156 (156 = the close gate on the window fact inserts; it guards on 154 and 155)
//
// Usage:
//   node scripts/economy139to146Preflight.js files                      local: the candidate files, their sha256, the chain, the declared dependencies
//   node scripts/economy139to146Preflight.js sql --mode PRE_APPLY       prints ONE read-only SELECT for that mode (for the Supabase MCP execute_sql path);
//                                                                       every row is one check (ok true / false); the last row is VERDICT
//   node scripts/economy139to146Preflight.js run --mode PRE_APPLY       runs the same SELECT inside BEGIN TRANSACTION READ ONLY ... ROLLBACK
//                                                                       (connection: PREFLIGHT_DATABASE_URL, or PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE)
//   Option --no-registry: ONLY for an ephemeral certification database that has no Supabase migration registry. Never on staging.
// Exit code: 0 = PASS, 1 = FAIL, 2 = usage / connection error.
//
// What the SELECT checks (all modes): PostgreSQL 17.x; default_transaction_isolation = read committed (and the session itself); no isolation
// override in pg_db_role_setting, in any role's rolconfig or in any function's proconfig; server_encoding UTF8; the client path transmits the
// non-ASCII bytes the 146 files carry unaltered (client_encoding UTF8 or SQL_ASCII, and the 146 transport literal arrives as its 4 UTF-8 bytes);
// service_role (BYPASSRLS, SELECT + UPDATE on service_session_state); single overloads; the exact state of every object the chain touches for
// that mode (md5(prosrc) of 24 function states, the 143 trigger and its position, 2 constraints, 4 comments); the ledger
// (public.ladieci_schema_migrations): tip, exact rows (filename, apply_order, sha256/16) of the applied prefix, no row for a later chain
// member, no 141 / 142 row; and, for every applied migration, the byte-level proof in the Supabase registry
// (sha256(supabase_migrations.schema_migrations.statements[1]) = sha256 of the committed file).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const sha256File = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// ── the chain: files and their certified sha256 (MIGRATION_MANIFEST.md rows 139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151) ──────────────────────────
const CHAIN = [
  { n: 139, file: '2026-09-19_delivery_economy_decoupling_v1_migration_139.sql', sha: '161cde6ff479057c40b04dc94ea9cbb7a26811d5ce9b818d84b344fc7c4d5750', rbkSha: '96774be3a888b719370662aded9edf57a02d1cb06fc13f12cb009c4baff93806' },
  { n: 140, file: '2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql', sha: '1f36e395649d6ef665c762d9afb8dfe12cfa7ca1a47052fe178e361894113dfd', rbkSha: '490e5d6bc577116974a993035e13a5d056178753337a2e2c9363fee0f139350f' },
  { n: 143, file: '2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql', sha: '1da70b2357f34d9a4c259f38766ec6d6c6996a170f49d0b63853a826539c3677', rbkSha: 'ff3a992a86f5e21c12278798edcff3ed597f55077042c13ad314bc8ecf49245d' },
  { n: 144, file: '2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql', sha: 'e0a56b4765e4d849b274217326681ba56d338837e1dd53cbf213a01f104ee7cb', rbkSha: '6eb0743b2fc9df6b6b71635146b0935432b8592dfb1dd05839baaee9a86cffe7' },
  { n: 145, file: '2026-09-24_payment_close_receipt_lock_v1_migration_145.sql', sha: '138160b7d962a1d0a7dade69e6f90db4246829f5b7725cba5015b3ec25b5f32f', rbkSha: '345824cb3139de3dcc927e131ecf32c818da81558a64badd55232d1ea69f8f84' },
  { n: 146, file: '2026-09-25_refund_close_receipt_lock_v1_migration_146.sql', sha: '64f11dc5f5c487153a19630254b92e1391d62655705de4a9819c85660e74d5a7', rbkSha: 'a6e3989725fdd369ade491d78025c062e8f6c3fb8876cd5b18e87f7c4ad8f381' },
  { n: 147, file: '2026-09-25_mesa_refund_canonical_projection_v1_migration_147.sql', sha: 'f4710bc023710d7ae1f4ffc28cff850262ce6d6afd7bc8cc4673c8dcb027b0b2', rbkSha: '7fe358a211ba71005d626d2be3d020a1fa2b0b74f0bae27b7a67ae37d2ab4838' },
  { n: 148, file: '2026-09-25_legacy_paid_ambiguity_payment_guard_v1_migration_148.sql', sha: 'c04bf391f4f95d0723f179bf418b0590ccdedc8e3c18930ec3e377234f469cbf', rbkSha: '167579094265f89530cc3e525e17ab0196d87549170545fd249fdc2a70ed56b0' },
  { n: 149, file: '2026-09-25_close_attempt_atomic_completion_v1_migration_149.sql', sha: '5c593ee58bd952c7d3fe528f8b3a6c5599844375848fa9f1c34a6539a423f4d8', rbkSha: '9a565b7f4bf328cf2917bed6d401fcc33e0d4150ae65661fdc3c49a999c3d31e' },
  { n: 150, file: '2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.sql', sha: 'e8d7b5beb012916780f15ca74c21c7057aea38d2ce399eea5151b7a56cf4e463', rbkSha: 'f1376a61d99a342aa14fbd5be4c6251adc124df7a9f41276e549f7ac87a9a72a' },
  { n: 151, file: '2026-09-26_economic_close_gate_v1_migration_151.sql', sha: '8f36ca590996e5cba5f58b2d84542bf3608e2a4d56b091989682731856c18f52', rbkSha: '72c9d5df0d1994e518b0e0d081a7f3e2b97c58b27fd393c7ea0e99b208d46c47' },
  { n: 152, file: '2026-09-26_post_close_obligation_resolution_v1_migration_152.sql', sha: 'ae3fc880d190e71c01f4ca0506e2976d384383898a80e9ec153500e25201d2c0', rbkSha: '5c9f6f71be687b96a3476c27dbd842bcbb2e3f1f226c85937dcf173225d7036d' },
  { n: 153, file: '2026-09-26_order_editor_canonical_writer_v1_migration_153.sql', sha: 'bf17e988f055e52145e499fae5448c3e9556c11303a78a969711ebff8f937400', rbkSha: '89e2c7fed7fc6726dd74517a816259b2c877e2d6a4d273d96b59c0721727276b' },
  { n: 154, file: '2026-09-26_close_day_evidence_freshness_v1_migration_154.sql', sha: '18c0365140a519bfcdb84027160688075ef3f5f678f02a03c03587bf691cfaf0', rbkSha: 'e13c2a95a13ed6093b4b6b96beb251d6c959d28fcef3d7425d5dfa3800c9174e' },
  { n: 155, file: '2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.sql', sha: 'ce4c6b6560652c252107d0d8dfec42fa5ee834dcb9c3c9cc2bd329570014aa8a', rbkSha: '8536eb571c68e0e43b802bdd6c5f0a105b7b40135febd3ce65a2cb3e587b1b5b' },
  { n: 156, file: '2026-09-27_close_gate_on_window_facts_v1_migration_156.sql', sha: '4bb485d4c66baadec2b0b0f7a6e61c0efd22c15af81e1f1d4c17602f6da241f4', rbkSha: '75b4dc4b330cb1cd990b3e13a010df2da130f346584e8a8ede704101e3b228c8' },
];
const LEDGER_TIP_BEFORE = 138;
const MODES = { PRE_APPLY: [], BEFORE_140: [139], BEFORE_143: [139, 140], BEFORE_144: [139, 140, 143], BEFORE_145: [139, 140, 143, 144], BEFORE_146: [139, 140, 143, 144, 145], BEFORE_147: [139, 140, 143, 144, 145, 146], BEFORE_148: [139, 140, 143, 144, 145, 146, 147], BEFORE_149: [139, 140, 143, 144, 145, 146, 147, 148], BEFORE_150: [139, 140, 143, 144, 145, 146, 147, 148, 149], BEFORE_151: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150], BEFORE_152: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151], BEFORE_153: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152], BEFORE_154: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153], BEFORE_155: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154], BEFORE_156: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155], POST_APPLY: [139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156] };
// the declared dependencies, and where each one is enforced
const DEPENDENCIES = [
  { m: 140, needs: [139], enforcedBy: 'its own guard (order_post_payment_v1 = the 139 body af52d596...) + this preflight' },
  { m: 143, needs: [140], enforcedBy: 'rollout order: this preflight only (143 pins bodies 139 / 140 do not change)' },
  { m: 144, needs: [143], enforcedBy: 'rollout order: this preflight only' },
  { m: 145, needs: [143, 144], enforcedBy: '143: its own guard (prelude + trigger a0); 144: THIS PREFLIGHT ONLY (145 does not check it)' },
  { m: 146, needs: [143, 144, 145], enforcedBy: '143 and 145: its own guards (prelude, ECONOMY_LINEAGE); 144: THIS PREFLIGHT ONLY (146 does not check it)' },
  { m: 147, needs: [146], enforcedBy: 'its own guard (mesa_post_refund_v1 = the 146 body 9679556f...; mesa_post_payment_v1 = the 145 body 94867e16...) + this preflight' },
  { m: 148, needs: [145, 147], enforcedBy: '145: its own guard (order_post_payment_v1 = the 145 body 799f8093...; plus the wrapper bodies 139 bedbfc46... / 140 ef3d4230...); 147 (its rollout position, and with it 146): THIS PREFLIGHT ONLY (148 does not check it)' },
  { m: 149, needs: [139, 148], enforcedBy: 'its own guard (close_service_session_v3 = the 139 body a6680181...; complete_closeout_attempt = f96adc78...; order_post_payment_v1 = the 148 body e1ce2229..., i.e. the chain tip) + this preflight (144 / 146 / 147 before it: THIS PREFLIGHT ONLY)' },
  { m: 150, needs: [145, 149], enforcedBy: 'applied together with 149 as ONE guarded step (scripts/economy149150GuardedStep.js: lifecycle lock, no open service) + its own guard (the 149 tip: close_service_session_and_complete_attempt_v1 = f53a677b... and its two triggers; mesa_post_payment_v1 = the 145 body 94867e16...; the closeout authorities it calls: create_service_closeout e089a36c..., create_service_closeout_reconciliation_v1 f8f351a9..., capture_closeout_snapshot 2a3a4b1d..., supersede_closeout_attempt 1ee56590..., acquire / complete_closeout_attempt, close_service_session_v3 a6680181..., order_canonical_obligation_v1 c68e8313...) + this preflight (144 / 146 / 147 / 148 before it: through the 149 tip it guards on, and THIS PREFLIGHT)' },
  { m: 151, needs: [144, 150], enforcedBy: 'its own guard (the 150 tip: close_service_session_with_evidence_v1 = a25b330f... and mesa_post_payment_v1 = 2d6ebfe7... plus service_closeouts_terminal_close_v1; the two bodies it replaces: order_obligation_apply_adjustment_v1 = b4c358e2..., order_obligation_revision_v1 = 49387a6b... and its trigger; its three callers: order_cancel_v1 = the 144 body 26408ba3..., order_apply_commercial_adjustment_v1 = bfac890a..., mesa_post_commercial_adjustment_v1 = 76c4eb34...; the gate-carrying writers 145 / 146 / 147 / 148 and the close / open lock sets) + this preflight' },
  { m: 152, needs: [151], enforcedBy: 'its own guard (the 151 bodies: order_economic_service_gate_v1 = 3c8c4c46..., order_obligation_apply_adjustment_v1 = 2c411d98..., order_obligation_revision_v1 = bfac4ec3...; the three order_obligations constraints it extends, byte for byte; order_obligations_client_request_uq) + this preflight' },
  { m: 153, needs: [151, 152], enforcedBy: 'its own guard (the 151 gate 3c8c4c46... and revision bfac4ec3... bodies; the 152 function d79f71a2...) + this preflight' },
  { m: 154, needs: [150, 151, 152, 153], enforcedBy: 'its own guard (close_service_session_with_evidence_v1 = the 150 body a25b330f...; the 151 gate 3c8c4c46...; the 152 function d79f71a2...; the 153 function d5f96286...) + this preflight; the BACKEND of the package deployed before it (in fact before 151): operator step (a backend that sends no digest makes every Finalizar fail closed with CLOSE_EVIDENCE_INCOMPLETE)' },
  { m: 155, needs: [151, 152, 153, 154], enforcedBy: 'its own guard (the 154 bodies c57584ba... / f637aa2e...; the 153 function d5f96286...; the 152 function d79f71a2...; the 151 gate 3c8c4c46..., adjustment core 2c411d98..., revision bfac4ec3...; the four bodies it replaces: start_rider_trip_v2 0323fbb1..., giro_authority_create_or_move_v1 e4966ba6..., giro_authority_attach_or_move_v1 85fb8a84..., giro_authority_consume_intent_v1 3dde4755...) + this preflight; DB-only, backend-agnostic' },
  { m: 156, needs: [154, 155], enforcedBy: 'its own guard (the 154 bodies c57584ba... / f637aa2e...; the four 155 bodies baa7e42e... / b5823fc5... / 4f39a046... / 2a59a168...) + this preflight; DB-only, backend-agnostic' },
];

// ── every catalog object the chain touches: its state before the chain, then after each migration that changes it ─────────────────────
// fn: md5(prosrc) (null = must not exist); the "after" bodies are the bodies carried by the committed files (checked by the `files` command)
const FN = [
  { sig: 'public.close_service_session_v3(uuid,uuid,text,text)', states: { 0: '3051158274094b46d668481b0dbdbdc5', 139: 'a6680181760dd8dabfa29aa43c786906' } },
  { sig: 'public.start_rider_trip_v2(uuid,text,integer,uuid[])', states: { 0: '0323fbb1bab76a12fd2be3fed0b3187e', 155: 'baa7e42e28b15565e93f5da66374a6a9' } },
  { sig: 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)', states: { 0: '778cd30008632707e47a372e6afa5640', 139: 'af52d59658719bd7898d9cd88dd29179', 140: 'ea4fe577feddbd2ba6f6ae42695feba6', 145: '799f8093328b4ac81e1ad5a3d37e1bb6', 148: 'e1ce2229f2418d6a7f91fe50771564f8' } },
  { sig: 'public.operator_confirm_delivery_v1(text,text,integer,jsonb)', states: { 0: null, 139: 'bedbfc46ca7e385220c2ea4531064c62' } },
  { sig: 'public.trip_residual_scope_v1()', states: { 0: null, 139: 'dfdbd3a5daad5f0f8c839df7aec61125' } },
  { sig: 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)', states: { 0: '4b2b4f4ce6155deea2e7f15a74f7707c', 140: null } },
  { sig: 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)', states: { 0: null, 140: 'ef3d423028b2d4d823359264bc5cfadc' } },
  { sig: 'public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)', states: { 0: '94fa5265c0ad334b79f3f00228f8300d', 140: null } },
  { sig: 'public.order_entity_anchor_v1()', states: { 0: '3db9189218204ad2488cff64fd55eb9c' } },
  { sig: 'public.mesa_singleton_workspace_v1()', states: { 0: '7f431effcabf52dc541f5456dcdf7f28' } },
  { sig: 'public.mesa_prepare_table_order_v1()', states: { 0: '50c48c3083e106b586940f29f9640fab' } },
  { sig: 'public.order_initial_payment_v1()', states: { 0: 'e397b66e3aabe66a123a5356c825f124' } },
  { sig: 'public.order_intake_lock_prelude_v1()', states: { 0: null, 143: '067a9127b4ab4b5435c40ecd4c32f476' } },
  { sig: 'public.order_cancel_v1(text,text,text,text,text,text,jsonb)', states: { 0: 'd75624fd1393d7dbf94d2155e19626b7', 144: '26408ba35e2a43420273a6f4c126083d' } },
  { sig: 'public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', states: { 0: '9543ab52d9933ffd52cc7f9b595c4cfb', 145: '94867e165d0732f36ae4692fc6998c58', 150: '2d6ebfe704559dd5a9a083025fb77057' } },
  { sig: 'public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', states: { 0: 'f057928b8f6fade25d38d4bb1d3ed09a', 146: '687b55f29d69323d54a73111529cebe9' } },
  { sig: 'public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', states: { 0: '62f0e128a6e5d0623b0423a69f0329d3', 146: '9679556fe209fbadac5275b3ac71e456', 147: '69629f700425ebf48b88cc659c689992' } },
  { sig: 'public.complete_closeout_attempt(uuid,text)', states: { 0: 'f96adc7871c50751fdd7a4b1aebf3783' } },
  { sig: 'public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)', states: { 0: null, 149: 'f53a677bf72aebdec2ce90eea8a81668' } },
  { sig: 'public.service_session_close_attempt_terminal_v1()', states: { 0: null, 149: 'c3e18316e5375981061e57b25cdf8915' } },
  { sig: 'public.service_closeout_attempt_open_service_v1()', states: { 0: null, 149: 'aff9e7d796c3b4fd19267ac5f946ac31' } },
  // 150 -- the corrective slice: its four new functions, and the unchanged authorities its terminal step calls or relies on
  { sig: 'public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)', states: { 0: null, 150: 'a7f89499be50f338607ff64f8778f2ae' } },
  { sig: 'public.service_close_live_evidence_v1(uuid)', states: { 0: null, 150: '49163cc1ec55c7f2154e4d76ee77445c' } },
  { sig: 'public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', states: { 0: null, 150: 'a25b330f095ff3441bca034e79e750f7', 154: 'c57584ba03c40ee940e402188fd40d2d' } },
  { sig: 'public.service_closeout_requires_terminal_close_v1()', states: { 0: null, 150: 'be58c0f28da316fcb8495be7676c2738' } },
  { sig: 'public.create_service_closeout(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer)', states: { 0: 'e089a36c1cbdcfb1f148a86aaf0ae226' } },
  { sig: 'public.create_service_closeout_reconciliation_v1(uuid,uuid,timestamp with time zone,timestamp with time zone,text,text,date,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,text,uuid,integer)', states: { 0: 'f8f351a9ec2d2754220b95a165a3ae06' } },
  { sig: 'public.capture_closeout_snapshot(uuid,uuid,text,text,jsonb,integer,text)', states: { 0: '2a3a4b1d746f5bc549991e5f0cdd13c3' } },
  { sig: 'public.supersede_closeout_attempt(uuid,text,text)', states: { 0: '1ee565901cad6b66f2e92772aad902ea' } },
  { sig: 'public.acquire_closeout_attempt(uuid,text)', states: { 0: 'e0e510d074ce61a6cc6b7d505ac38012' } },
  { sig: 'public.order_canonical_obligation_v1(uuid)', states: { 0: 'c68e831344fd537128608567727c2f9d' } },
  // 151 -- the final concurrency fix: the shared gate, the two obligation writers it extends, their three callers and the open lock set it relies on
  { sig: 'public.order_economic_service_gate_v1(uuid)', states: { 0: null, 151: '3c8c4c46dac20285081b85a3313ef576' } },
  { sig: 'public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)', states: { 0: 'b4c358e2a3913ba110d400f07059e8e5', 151: '2c411d98f63545c4a4b7d04fd9beb7fe' } },
  { sig: 'public.order_obligation_revision_v1()', states: { 0: '49387a6bf8e0ec66694d7bebe14d3d17', 151: 'bfac4ec3f428daa91d5d9505d8b1285a' } },
  { sig: 'public.order_apply_commercial_adjustment_v1(uuid,text,text,uuid,numeric,text,text,text,numeric,jsonb)', states: { 0: 'bfac890abc0e6103466649d37fe92ddf' } },
  { sig: 'public.mesa_post_commercial_adjustment_v1(uuid,text,text,uuid,uuid,numeric,text,text,text,numeric,jsonb)', states: { 0: '76c4eb343b741fd1746aebdd738c7cea' } },
  { sig: 'public.open_operational_service_v1(text,text,text)', states: { 0: '497183409192e9a15c0f3b33c2d336ba' } },
  // 152 / 153 / 154 -- the POST-ASTRA corrective cycle: the post-close resolution fact, the canonical order editor, the day-window digest
  { sig: 'public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)', states: { 0: null, 152: 'd79f71a2a40350307493ea1807b5fa77' } },
  { sig: 'public.order_apply_editor_patch_v1(text,jsonb,jsonb)', states: { 0: null, 153: 'd5f962866a565fe63eb0842124829cfe' } },
  { sig: 'public.service_close_day_evidence_digest_v1(timestamp with time zone,timestamp with time zone)', states: { 0: null, 154: 'f637aa2eaa3baec55bf7e88332d3d345' } },
  // 155 / 156 -- the FINAL LIVENESS GATE: the Planner entity KEY SHARE before the order lock (N2), the close gate on the window fact inserts (F2)
  { sig: 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])', states: { 0: 'e4966ba63a075f6914c26d6508cfef00', 155: 'b5823fc5417a92007295efe531a899f0' } },
  { sig: 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])', states: { 0: '85fb8a84ed311edfa02c11a4c7f9afec', 155: '4f39a046a0c4f04ef4ea5cc548328f03' } },
  { sig: 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])', states: { 0: '3dde47553cc347d097735df8ba7ca5aa', 155: '2a59a168d43c398d9e34d3ae651d1ea4' } },
  { sig: 'public.close_gate_window_fact_insert_v1()', states: { 0: null, 156: '6ed381c0bcfa60fb48250c5dbb63ef2c' } },
];
// 149 -- the two deferred constraint triggers, 150 -- the closeout terminal-close trigger: exact pg_get_triggerdef when present (null = must not exist)
const TRIGGERS = [
  { name: 'service_sessions_close_attempt_terminal_v1', rel: 'public.service_sessions', states: { 0: null, 149: 'CREATE CONSTRAINT TRIGGER service_sessions_close_attempt_terminal_v1 AFTER UPDATE OF status ON public.service_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.status = \'closed\'::text) AND (old.status IS DISTINCT FROM \'closed\'::text))) EXECUTE FUNCTION service_session_close_attempt_terminal_v1()' } },
  { name: 'service_closeout_attempts_open_service_v1', rel: 'public.service_closeout_attempts', states: { 0: null, 149: 'CREATE CONSTRAINT TRIGGER service_closeout_attempts_open_service_v1 AFTER INSERT ON public.service_closeout_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.status = \'active\'::text)) EXECUTE FUNCTION service_closeout_attempt_open_service_v1()' } },
  { name: 'service_closeouts_terminal_close_v1', rel: 'public.service_closeouts', states: { 0: null, 150: 'CREATE CONSTRAINT TRIGGER service_closeouts_terminal_close_v1 AFTER INSERT ON public.service_closeouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_closeout_requires_terminal_close_v1()' } },
  // 151 relies on the totale revision trigger exactly as it is (unchanged by the chain)
  { name: 'ordenes_order_obligation_revision_v1', rel: 'public.ordenes', states: { 0: 'CREATE TRIGGER ordenes_order_obligation_revision_v1 AFTER UPDATE OF totale ON public.ordenes FOR EACH ROW EXECUTE FUNCTION order_obligation_revision_v1()' } },
  // 156 -- the close gate on the two window fact tables (the same trigger name on both relations)
  { name: 'a0_close_gate_window_fact_v1', rel: 'public.order_financial_events', states: { 0: null, 156: 'CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.order_financial_events FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1()' } },
  { name: 'a0_close_gate_window_fact_v1', rel: 'public.cash_counts', states: { 0: null, 156: 'CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.cash_counts FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1()' } },
];
// md5 of pg_get_constraintdef / of the comment text ('' when absent)
const CONSTRAINTS = [
  { name: 'payment_transactions_scope_chk', rel: 'public.payment_transactions', states: { 0: 'eb153cec92c425bf7171ae8b1572a766', 139: 'c2459358ad4b9fdc2c7f19fa7c8def4e' } },
  { name: 'payment_transactions_by_role_check', rel: 'public.payment_transactions', states: { 0: '70f5316995338b656f6945260c4bcb90', 140: '5508d4f22170baa2f6d80711416f3241' } },
  // 152 -- the post-close resolution fact: three order_obligations constraints extended, one added (null = must not exist)
  { name: 'order_obligations_source_chk', rel: 'public.order_obligations', states: { 0: '3560f8e0f2ea3db3b2c5d179f2d08ab5', 152: '57ded733ab750a0cccbf6e790dbc79b4' } },
  { name: 'order_obligations_cause_presence_chk', rel: 'public.order_obligations', states: { 0: '4c9a0355d288dcda4ec688ea9bc33200', 152: 'a9a620b89668a62ef6b21b9d445da1de' } },
  { name: 'order_obligations_adjustment_provenance_chk', rel: 'public.order_obligations', states: { 0: '635446d5dae75a3c4dd6cb00382cc701', 152: '8083ae720401654a0191f1d9af2169ea' } },
  { name: 'order_obligations_post_close_resolution_chk', rel: 'public.order_obligations', states: { 0: null, 152: 'd3bead7069e2b401ebf753035731a813' } },
];
const COMMENTS = [
  { k: 'constraint payment_transactions_scope_chk', sql: "obj_description((SELECT oid FROM pg_constraint WHERE conrelid = 'public.payment_transactions'::regclass AND conname = 'payment_transactions_scope_chk'), 'pg_constraint')", states: { 0: 'd41d8cd98f00b204e9800998ecf8427e', 139: 'ce5acd99d9e8383d42b792948afdd5b7' } },
  { k: 'constraint payment_transactions_by_role_check', sql: "obj_description((SELECT oid FROM pg_constraint WHERE conrelid = 'public.payment_transactions'::regclass AND conname = 'payment_transactions_by_role_check'), 'pg_constraint')", states: { 0: 'd41d8cd98f00b204e9800998ecf8427e', 140: 'b35d7baffb7655d25448617c072c428f' } },
  { k: 'column payment_transactions.service_session_id', sql: "col_description('public.payment_transactions'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.payment_transactions'::regclass AND attname = 'service_session_id'))", states: { 0: '75476d90c0c01df4a9a275ba1ac8ab85', 139: '9d13c6006aa59f96efd6988b6bdb3225' } },
  { k: 'column payment_transactions.table_session_id', sql: "col_description('public.payment_transactions'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.payment_transactions'::regclass AND attname = 'table_session_id'))", states: { 0: '42c63a6c36e1f24510c79c80f84ee285', 139: '85485ad4bafc274d70f902ddd3cb3f13' } },
];
// the 146 files carry the live mojibake "¬ß" (UTF-8 C2 AC C3 9F): the path must deliver these 4 bytes unchanged
const TRANSPORT_LITERAL = '¬ß';
const TRANSPORT_MD5 = '45e0e64ed4f04e4ea4e6e21148e2eadc';

// state of an object for a set of applied migrations: the latest listed state whose migration is applied (0 = before the chain)
const stateFor = (states, applied) => { let key = 0; for (const k of Object.keys(states).map(Number).sort((a, b) => a - b)) if (k === 0 || applied.includes(k)) key = k; return states[key]; };
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

function renderSql(mode, { noRegistry = false } = {}) {
  if (!MODES[mode]) throw new Error('unknown mode ' + mode + ' (use one of ' + Object.keys(MODES).join(', ') + ')');
  const applied = MODES[mode];
  const pending = CHAIN.filter((c) => !applied.includes(c.n)).map((c) => c.n);
  const tip = applied.length ? applied[applied.length - 1] : LEDGER_TIP_BEFORE;
  const fnRows = FN.map((f) => `(${q(f.sig)}, ${q(stateFor(f.states, applied))})`).join(',\n    ');
  const conRows = CONSTRAINTS.map((c) => `(${q(c.name)}, ${q(c.rel)}, ${q(stateFor(c.states, applied))})`).join(',\n    ');
  const col152 = applied.includes(152);
  const trgRows = TRIGGERS.map((t) => `(${q(t.name)}, ${q(t.rel)}, ${q(stateFor(t.states, applied))})`).join(',\n    ');
  const comRows = COMMENTS.map((c) => `(${q(c.k)}, md5(COALESCE(${c.sql}, '')), ${q(stateFor(c.states, applied))})`).join(',\n    ');
  const ledRows = CHAIN.map((c) => `(${c.n}, ${q(c.file)}, ${q(c.sha.slice(0, 16))}, ${q(c.sha)}, ${applied.includes(c.n)})`).join(',\n    ');
  const a0 = applied.includes(143);
  const names = [...new Set(FN.map((f) => f.sig.replace(/^public\./, '').replace(/\(.*$/, '')))];
  return `-- ECONOMY 139 -> 156 PREFLIGHT, mode ${mode} (applied: ${applied.join(', ') || 'none'}; pending: ${pending.join(', ') || 'none'}). READ-ONLY: one SELECT, no write.
WITH
  fn_expect(sig, want) AS (VALUES
    ${fnRows}),
  con_expect(name, rel, want) AS (VALUES
    ${conRows}),
  trg_expect(name, rel, want) AS (VALUES
    ${trgRows}),
  com_state(k, got, want) AS (VALUES
    ${comRows}),
  chain(n, filename, sha16, sha_full, applied) AS (VALUES
    ${ledRows}),
  led AS (SELECT * FROM public.ladieci_schema_migrations),
  checks(sec, k, got, want, ok) AS (
    SELECT 'A', 'server_version (17.x)', current_setting('server_version'), '17.x', current_setting('server_version_num')::int BETWEEN 170000 AND 179999
    UNION ALL SELECT 'A', 'default_transaction_isolation', current_setting('default_transaction_isolation'), 'read committed', current_setting('default_transaction_isolation') = 'read committed'
    UNION ALL SELECT 'A', 'transaction_isolation (this session)', current_setting('transaction_isolation'), 'read committed', current_setting('transaction_isolation') = 'read committed'
    UNION ALL SELECT 'A', 'pg_db_role_setting entries (this database or all databases) setting an isolation level', (SELECT count(*)::text FROM pg_db_role_setting WHERE setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())) AND array_to_string(setconfig, ';') ILIKE '%isolation%'), '0',
      NOT EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database())) AND array_to_string(setconfig, ';') ILIKE '%isolation%')
    UNION ALL SELECT 'A', 'roles with an isolation level in rolconfig', (SELECT count(*)::text FROM pg_roles WHERE array_to_string(rolconfig, ';') ILIKE '%isolation%'), '0', NOT EXISTS (SELECT 1 FROM pg_roles WHERE array_to_string(rolconfig, ';') ILIKE '%isolation%')
    UNION ALL SELECT 'A', 'functions (any schema) with an isolation level in proconfig', (SELECT count(*)::text FROM pg_proc WHERE array_to_string(proconfig, ';') ILIKE '%isolation%'), '0', NOT EXISTS (SELECT 1 FROM pg_proc WHERE array_to_string(proconfig, ';') ILIKE '%isolation%')
    UNION ALL SELECT 'A', 'service_role: exists, BYPASSRLS, SELECT + UPDATE on service_session_state', COALESCE((SELECT rolbypassrls::text FROM pg_roles WHERE rolname = 'service_role'), 'missing') || ' / ' || (CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') AND to_regclass('public.service_session_state') IS NOT NULL THEN (has_table_privilege('service_role', 'public.service_session_state', 'SELECT') AND has_table_privilege('service_role', 'public.service_session_state', 'UPDATE'))::text ELSE 'n/a' END), 'true / true',
      COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'), false) AND to_regclass('public.service_session_state') IS NOT NULL AND has_table_privilege('service_role', 'public.service_session_state', 'SELECT') AND has_table_privilege('service_role', 'public.service_session_state', 'UPDATE')
    UNION ALL SELECT 'B', 'server_encoding', current_setting('server_encoding'), 'UTF8', current_setting('server_encoding') = 'UTF8'
    UNION ALL SELECT 'B', 'client_encoding of this path (must not re-encode bytes)', current_setting('client_encoding'), 'UTF8 or SQL_ASCII', current_setting('client_encoding') IN ('UTF8', 'SQL_ASCII')
    UNION ALL SELECT 'B', 'the 146 transport literal arrives as its 4 UTF-8 bytes', octet_length('${TRANSPORT_LITERAL}')::text || ' / ' || md5('${TRANSPORT_LITERAL}'), '4 / ${TRANSPORT_MD5}', octet_length('${TRANSPORT_LITERAL}') = 4 AND md5('${TRANSPORT_LITERAL}') = '${TRANSPORT_MD5}'
    UNION ALL SELECT 'C', 'ledger table present', (to_regclass('public.ladieci_schema_migrations') IS NOT NULL)::text, 'true', to_regclass('public.ladieci_schema_migrations') IS NOT NULL
    UNION ALL SELECT 'C', 'ledger tip max(apply_order)', (SELECT max(apply_order)::text FROM led), '${tip}', (SELECT max(apply_order) FROM led) = ${tip}
    UNION ALL SELECT 'C', 'ledger rows above ${LEDGER_TIP_BEFORE} = exactly the applied prefix (${applied.join(', ') || 'none'})', (SELECT COALESCE(string_agg(apply_order::text, ',' ORDER BY apply_order), '') FROM led WHERE apply_order > ${LEDGER_TIP_BEFORE}), '${applied.join(',')}', (SELECT COALESCE(string_agg(apply_order::text, ',' ORDER BY apply_order), '') FROM led WHERE apply_order > ${LEDGER_TIP_BEFORE}) = '${applied.join(',')}'
    UNION ALL SELECT 'C', 'no 141 / 142 (Fiscal) in the ledger (apply_order or filename)', (SELECT count(*)::text FROM led WHERE apply_order IN (141, 142) OR filename ~ '_migration_14[12]\\y'), '0', NOT EXISTS (SELECT 1 FROM led WHERE apply_order IN (141, 142) OR filename ~ '_migration_14[12]\\y')
    UNION ALL SELECT 'C', 'ledger row ' || c.n || CASE WHEN c.applied THEN ' present: filename + sha256/16' ELSE ' ABSENT (not applied yet): neither its number nor its filename is taken' END,
      COALESCE((SELECT l.filename || ' ' || l.checksum_sha256 FROM led l WHERE l.apply_order = c.n), '(none)') || CASE WHEN EXISTS (SELECT 1 FROM led l WHERE l.filename = c.filename AND l.apply_order <> c.n) THEN ' + filename under another apply_order' ELSE '' END,
      CASE WHEN c.applied THEN c.filename || ' ' || c.sha16 ELSE '(none)' END,
      CASE WHEN c.applied THEN EXISTS (SELECT 1 FROM led l WHERE l.apply_order = c.n AND l.filename = c.filename AND l.checksum_sha256 = c.sha16) AND NOT EXISTS (SELECT 1 FROM led l WHERE l.filename = c.filename AND l.apply_order <> c.n)
           ELSE NOT EXISTS (SELECT 1 FROM led l WHERE l.apply_order = c.n OR l.filename = c.filename) END
      FROM chain c
    UNION ALL SELECT 'C', 'registry byte proof ' || c.n || ': sha256(supabase_migrations.schema_migrations.statements[1]) = sha256(file)',
      ${noRegistry ? "'(registry check disabled: ephemeral certification database)'" : "CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'registry missing' ELSE (SELECT count(*)::text FROM supabase_migrations.schema_migrations r WHERE encode(sha256(convert_to(r.statements[1], 'UTF8')), 'hex') = c.sha_full) || ' matching statement(s)' END"},
      '1 matching statement(s)',
      ${noRegistry ? 'true' : "to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AND (SELECT count(*) FROM supabase_migrations.schema_migrations r WHERE encode(sha256(convert_to(r.statements[1], 'UTF8')), 'hex') = c.sha_full) = 1"}
      FROM chain c WHERE c.applied
    UNION ALL SELECT 'D', 'body ' || e.sig, COALESCE((SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(e.sig)), '(absent)'), COALESCE(e.want, '(absent)'),
      (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(e.sig)) IS NOT DISTINCT FROM e.want
      FROM fn_expect e
    UNION ALL SELECT 'D', 'single overload of every touched function name', COALESCE((SELECT string_agg(proname || '=' || n, ',' ORDER BY proname) FROM (SELECT proname, count(*) AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${names.filter((x) => x !== 'rider_collect_and_complete_stop').map(q).join(', ')}) GROUP BY proname HAVING count(*) > 1) x), 'none'), 'none',
      NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${names.filter((x) => x !== 'rider_collect_and_complete_stop').map(q).join(', ')}) GROUP BY proname HAVING count(*) > 1)
      AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rider_collect_and_complete_stop') = 1
    UNION ALL SELECT 'D', 'constraint ' || e.name, COALESCE((SELECT md5(pg_get_constraintdef(c.oid)) FROM pg_constraint c WHERE c.conrelid = to_regclass(e.rel) AND c.conname = e.name), '(absent)'), COALESCE(e.want, '(absent)'),
      (SELECT md5(pg_get_constraintdef(c.oid)) FROM pg_constraint c WHERE c.conrelid = to_regclass(e.rel) AND c.conname = e.name) IS NOT DISTINCT FROM e.want
      FROM con_expect e
    UNION ALL SELECT 'D', 'column order_obligations.resolution_service_session_id (152) ${col152 ? 'present: uuid, nullable, FK service_sessions' : 'absent'}',
      COALESCE((SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_obligations' AND column_name = 'resolution_service_session_id'), '(absent)'),
      '${col152 ? 'uuid:YES' : '(absent)'}',
      ${col152
    ? `(SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_obligations' AND column_name = 'resolution_service_session_id') = 'uuid:YES'
      AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.order_obligations'::regclass AND c.contype = 'f' AND c.confrelid = 'public.service_sessions'::regclass
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.order_obligations'::regclass AND attname = 'resolution_service_session_id')]::int2[])`
    : `NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_obligations' AND column_name = 'resolution_service_session_id')`}
    UNION ALL SELECT 'D', 'comment ' || s.k, s.got, s.want, s.got = s.want FROM com_state s
    UNION ALL SELECT 'D', 'trigger ' || e.name || ' on ' || e.rel || (CASE WHEN e.want IS NULL THEN ' absent' ELSE ' present: enabled, exact definition, deferrable / initially deferred exactly as that definition says' END),
      COALESCE((SELECT string_agg(t.tgenabled::text || ':' || t.tgdeferrable::text || ':' || t.tginitdeferred::text || ':' || md5(pg_get_triggerdef(t.oid)), ',') FROM pg_trigger t WHERE t.tgname = e.name AND t.tgrelid = to_regclass(e.rel) AND NOT t.tgisinternal), '(absent)'),
      COALESCE('O:' || (e.want LIKE '%DEFERRABLE INITIALLY DEFERRED%')::text || ':' || (e.want LIKE '%DEFERRABLE INITIALLY DEFERRED%')::text || ':' || md5(e.want), '(absent)'),
      CASE WHEN e.want IS NULL THEN NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = e.name AND t.tgrelid = to_regclass(e.rel))
           ELSE (SELECT count(*) FROM pg_trigger t WHERE t.tgname = e.name AND t.tgrelid = to_regclass(e.rel) AND NOT t.tgisinternal) = 1
                AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = e.name AND t.tgrelid = to_regclass(e.rel) AND t.tgenabled = 'O' AND t.tgdeferrable = (e.want LIKE '%DEFERRABLE INITIALLY DEFERRED%') AND t.tginitdeferred = (e.want LIKE '%DEFERRABLE INITIALLY DEFERRED%') AND pg_get_triggerdef(t.oid) = e.want) END
      FROM trg_expect e
    UNION ALL SELECT 'E', 'no closeout committed for a service that is still open / closing (the H-1 state: a Finalizar of the previous backend against "149 without 150"; see scripts/economy149150GuardedStep.js)',
      (SELECT count(*)::text FROM public.service_closeouts c JOIN public.service_sessions s ON s.id = c.service_session_id WHERE s.status IN ('open', 'closing')), '0',
      NOT EXISTS (SELECT 1 FROM public.service_closeouts c JOIN public.service_sessions s ON s.id = c.service_session_id WHERE s.status IN ('open', 'closing'))
    UNION ALL SELECT 'D', 'the trigger names of the chain exist on no relation other than the ones listed for them',
      COALESCE((SELECT string_agg(t.tgname::text || ' on ' || t.tgrelid::regclass::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN (SELECT name FROM trg_expect) AND NOT EXISTS (SELECT 1 FROM trg_expect x WHERE x.name = t.tgname AND to_regclass(x.rel) = t.tgrelid)), 'none'), 'none',
      NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN (SELECT name FROM trg_expect) AND NOT EXISTS (SELECT 1 FROM trg_expect x WHERE x.name = t.tgname AND to_regclass(x.rel) = t.tgrelid))
    UNION ALL SELECT 'D', 'trigger a0_order_intake_lock_prelude_v1 (143) ${a0 ? 'present, enabled, BEFORE INSERT FOR EACH ROW, no WHEN, calls the prelude, FIRST BEFORE INSERT trigger' : 'absent, and no BEFORE INSERT trigger of ordenes sorts at or before its name'}',
      COALESCE((SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text || ':' || t.tgtype::text || ':' || (t.tgqual IS NULL)::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4), '(none)'),
      '${a0 ? 'a0_order_intake_lock_prelude_v1 first' : 'no trigger <= a0_order_intake_lock_prelude_v1'}',
      ${a0
    ? `EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname = 'a0_order_intake_lock_prelude_v1' AND t.tgfoid = to_regprocedure('public.order_intake_lock_prelude_v1()') AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 0 AND (t.tgtype & 16) = 0 AND (t.tgtype & 32) = 0 AND t.tgqual IS NULL AND t.tgenabled = 'O' AND NOT t.tgisinternal)
      AND (SELECT min(t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4) = 'a0_order_intake_lock_prelude_v1'`
    : `NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal AND t.tgname <= 'a0_order_intake_lock_prelude_v1')`}
  )
SELECT sec, k, got, want, ok FROM (
  SELECT sec, k, got, want, ok, 0 AS ord FROM checks
  UNION ALL SELECT 'Z', 'VERDICT ${mode}', (SELECT count(*) FILTER (WHERE ok IS NOT TRUE)::text || ' failing of ' || count(*)::text FROM checks), 'all ok', (SELECT bool_and(ok IS TRUE) FROM checks), 1
) v ORDER BY ord, sec, k;
`;
}

// ── local files: presence, sha256, chain, declared dependencies, perimeter ─────────────────────────────────────────────────────────────
function checkFiles() {
  const out = []; const add = (k, ok, detail) => out.push({ k, ok: !!ok, detail });
  const mig = path.join(ROOT, 'migrations');
  const all = fs.readdirSync(mig);
  for (const c of CHAIN) {
    const f = 'migrations/' + c.file, r = f.replace(/\.sql$/, '.ROLLBACK.sql');
    add(`${c.n} forward present, sha256 = certified`, fs.existsSync(path.join(ROOT, f)) && sha256File(f) === c.sha, fs.existsSync(path.join(ROOT, f)) ? sha256File(f) : 'missing');
    add(`${c.n} rollback present, sha256 = certified`, fs.existsSync(path.join(ROOT, r)) && sha256File(r) === c.rbkSha, fs.existsSync(path.join(ROOT, r)) ? sha256File(r) : 'missing');
  }
  const nums = [...new Set(all.map((x) => (/_migration_(\d+)\b/.exec(x) || [])[1]).filter(Boolean).map(Number).filter((n) => n > LEDGER_TIP_BEFORE))].sort((a, b) => a - b);
  add(`the migrations above 138 are EXACTLY the chain ${CHAIN.map((c) => c.n).join(', ')} (no 141 / 142, nothing else)`, nums.join(',') === CHAIN.map((c) => c.n).join(','), nums.join(','));
  const manifest = fs.readFileSync(path.join(mig, 'MIGRATION_MANIFEST.md'), 'utf8');
  for (const c of CHAIN) { const row = (manifest.split(`| ${c.n} |`)[1] || '').split('\n')[0]; add(`manifest row ${c.n} carries the certified forward + rollback sha256`, row.includes(c.sha) && row.includes(c.rbkSha)); }
  // the expected "after" bodies of this preflight are exactly the bodies the committed files carry
  const bodies = (file) => { const sql = fs.readFileSync(path.join(mig, file), 'utf8'); const res = {}; const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-zA-Z0-9_]+)\s*\(/g; let m;
    while ((m = re.exec(sql))) { const rest = sql.slice(m.index); const o = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest); if (!o) continue; const bs = m.index + o.index + o[0].length; const e = sql.indexOf(o[1], bs); (res[m[1]] = res[m[1]] || []).push(md5(sql.slice(bs, e))); } return res; };
  for (const c of CHAIN) {
    const b = bodies(c.file);
    for (const f of FN) { const want = f.states[c.n]; if (!want) continue; const name = f.sig.replace(/^public\./, '').replace(/\(.*$/, ''); add(`expected body of ${name} after ${c.n} = the body carried by the ${c.n} file`, (b[name] || []).includes(want), JSON.stringify(b[name])); }
  }
  // declared dependencies, as carried by the guards of the files themselves
  const code = (n) => fs.readFileSync(path.join(mig, CHAIN.find((c) => c.n === n).file), 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  add('140 guards on 139 (order_post_payment_v1 must be the 139 body af52d596...)', /IS DISTINCT FROM 'af52d59658719bd7898d9cd88dd29179'/.test(code(140)));
  add('145 guards on 143 (prelude function + trigger a0)', /order_intake_lock_prelude_v1\(\)'\) IS NULL/.test(code(145)) && /a0_order_intake_lock_prelude_v1/.test(code(145)));
  add('146 guards on 143 and on 145 (ECONOMY_LINEAGE: the two 145 payment bodies)', /order_intake_lock_prelude_v1\(\)'\) IS NULL/.test(code(146)) && /ECONOMY_LINEAGE/.test(code(146)) && code(146).includes('799f8093328b4ac81e1ad5a3d37e1bb6') && code(146).includes('94867e165d0732f36ae4692fc6998c58'));
  add('147 guards on 146 (mesa_post_refund_v1 must be the 146 body 9679556f...) and on the 145 Mesa payment body 94867e16... it copies', /IS DISTINCT FROM '9679556fe209fbadac5275b3ac71e456'/.test(code(147)) && code(147).includes('94867e165d0732f36ae4692fc6998c58'));
  add('148 guards on 145 (order_post_payment_v1 must be the 145 body 799f8093...) and on the wrapper bodies whose 55000 handling it relies on (139 bedbfc46..., 140 ef3d4230...)', /IS DISTINCT FROM '799f8093328b4ac81e1ad5a3d37e1bb6'/.test(code(148)) && /IS DISTINCT FROM 'bedbfc46ca7e385220c2ea4531064c62'/.test(code(148)) && /IS DISTINCT FROM 'ef3d423028b2d4d823359264bc5cfadc'/.test(code(148)));
  add('149 guards on 139 (close_service_session_v3 = the 139 body a6680181...), on the attempt-completion body f96adc78... it calls, and on the 148 tip (order_post_payment_v1 = e1ce2229...)', /IS DISTINCT FROM 'a6680181760dd8dabfa29aa43c786906'/.test(code(149)) && /IS DISTINCT FROM 'f96adc7871c50751fdd7a4b1aebf3783'/.test(code(149)) && /IS DISTINCT FROM 'e1ce2229f2418d6a7f91fe50771564f8'/.test(code(149)));
  add('150 guards on the 149 tip (close_service_session_and_complete_attempt_v1 = f53a677b... and its two triggers), on the 145 Mesa body 94867e16... it extends, and on every closeout authority its terminal step calls', /IS DISTINCT FROM 'f53a677bf72aebdec2ce90eea8a81668'/.test(code(150)) && code(150).includes("'94867e165d0732f36ae4692fc6998c58'") && ['e089a36c1cbdcfb1f148a86aaf0ae226', 'f8f351a9ec2d2754220b95a165a3ae06', '2a3a4b1d746f5bc549991e5f0cdd13c3', '1ee565901cad6b66f2e92772aad902ea', 'a6680181760dd8dabfa29aa43c786906', 'f96adc7871c50751fdd7a4b1aebf3783', 'c68e831344fd537128608567727c2f9d'].every((h) => code(150).includes(h)));
  add('151 guards on the 150 tip (close_service_session_with_evidence_v1 = a25b330f... + service_closeouts_terminal_close_v1), on the two bodies it replaces (b4c358e2... / 49387a6b... and the totale trigger), on their three callers (order_cancel_v1 = the 144 body 26408ba3..., bfac890a..., 76c4eb34...) and on the gate-carrying money writers and close / open lock sets', ['a25b330f095ff3441bca034e79e750f7', 'b4c358e2a3913ba110d400f07059e8e5', '49387a6bf8e0ec66694d7bebe14d3d17', '26408ba35e2a43420273a6f4c126083d', 'bfac890abc0e6103466649d37fe92ddf', '76c4eb343b741fd1746aebdd738c7cea', 'e1ce2229f2418d6a7f91fe50771564f8', '687b55f29d69323d54a73111529cebe9', '69629f700425ebf48b88cc659c689992', '2d6ebfe704559dd5a9a083025fb77057', 'a6680181760dd8dabfa29aa43c786906', '497183409192e9a15c0f3b33c2d336ba'].every((h) => code(151).includes(h)) && code(151).includes('service_closeouts_terminal_close_v1') && code(151).includes('ordenes_order_obligation_revision_v1'));
  add('152 guards on the three 151 bodies (gate 3c8c4c46..., adjustment core 2c411d98..., revision bfac4ec3...) and on the exact pre-152 definitions of the three order_obligations constraints it extends', ['3c8c4c46dac20285081b85a3313ef576', '2c411d98f63545c4a4b7d04fd9beb7fe', 'bfac4ec3f428daa91d5d9505d8b1285a'].every((h) => code(152).includes(h)) && code(152).includes('order_obligations_source_chk') && code(152).includes('order_obligations_cause_presence_chk') && code(152).includes('order_obligations_adjustment_provenance_chk'));
  add('153 guards on 151 (gate 3c8c4c46..., revision bfac4ec3...) and on 152 (d79f71a2...)', ['3c8c4c46dac20285081b85a3313ef576', 'bfac4ec3f428daa91d5d9505d8b1285a', 'd79f71a2a40350307493ea1807b5fa77'].every((h) => code(153).includes(h)));
  add('154 guards on the 150 terminal body (a25b330f...), on 151 (3c8c4c46...), on 152 (d79f71a2...) and on 153 (d5f96286...)', ['a25b330f095ff3441bca034e79e750f7', '3c8c4c46dac20285081b85a3313ef576', 'd79f71a2a40350307493ea1807b5fa77', 'd5f962866a565fe63eb0842124829cfe'].every((h) => code(154).includes(h)));
  add('155 guards on 154 (c57584ba... / f637aa2e...), 153 (d5f96286...), 152 (d79f71a2...), 151 (3c8c4c46... / 2c411d98... / bfac4ec3...) and on the four bodies it replaces (0323fbb1... / e4966ba6... / 85fb8a84... / 3dde4755...)', ['c57584ba03c40ee940e402188fd40d2d', 'f637aa2eaa3baec55bf7e88332d3d345', 'd5f962866a565fe63eb0842124829cfe', 'd79f71a2a40350307493ea1807b5fa77', '3c8c4c46dac20285081b85a3313ef576', '2c411d98f63545c4a4b7d04fd9beb7fe', 'bfac4ec3f428daa91d5d9505d8b1285a', '0323fbb1bab76a12fd2be3fed0b3187e', 'e4966ba63a075f6914c26d6508cfef00', '85fb8a84ed311edfa02c11a4c7f9afec', '3dde47553cc347d097735df8ba7ca5aa'].every((h) => code(155).includes(h)));
  add('155 takes the order_entities KEY SHARE before the order lock in each of its four functions (and the actor KEY SHARE in start_rider_trip_v2); it changes no money writer', (code(155).match(/PERFORM 1 FROM public\.order_entities e\s+WHERE [^;]*\bFOR KEY SHARE;/g) || []).length === 4 && /FROM public\.auth_actors a WHERE a\.actor = p_actor FOR KEY SHARE;/.test(code(155)) && !/FUNCTION\s+public\.(order_post_payment_v1|order_post_refund_v1|order_cancel_v1|mesa_post_payment_v1|order_apply_commercial_adjustment_v1)\b/.test(code(155)));
  add('156 guards on 154 (c57584ba... / f637aa2e...) and on the four 155 bodies (baa7e42e... / b5823fc5... / 4f39a046... / 2a59a168...)', ['c57584ba03c40ee940e402188fd40d2d', 'f637aa2eaa3baec55bf7e88332d3d345', 'baa7e42e28b15565e93f5da66374a6a9', 'b5823fc5417a92007295efe531a899f0', '4f39a046a0c4f04ef4ea5cc548328f03', '2a59a168d43c398d9e34d3ae651d1ea4'].every((h) => code(156).includes(h)));
  add('156 installs exactly the two BEFORE INSERT triggers the TRIGGERS table expects, and its gate is the lifecycle pointer FOR SHARE', TRIGGERS.filter((x) => x.states[156]).every((x) => code(156).includes(x.states[156].replace(/^CREATE TRIGGER (\S+) BEFORE INSERT ON (\S+) .*$/, '$1 BEFORE INSERT ON $2'))) && /FROM public\.service_session_state WHERE singleton = true FOR SHARE;/.test(code(156)));
  add('NO migration of the chain guards on 144 (so 144 can only be enforced by this preflight: BEFORE_145 / BEFORE_146 / BEFORE_147 / BEFORE_148 / POST_APPLY require it)', ![145, 146, 147, 148, 149, 150].some((n) => code(n).includes('26408ba35e2a43420273a6f4c126083d')));
  add('148 does NOT guard on 146 / 147 (their rollout position before 148 is enforced by this preflight only: BEFORE_148 / POST_APPLY require them)', !['687b55f29d69323d54a73111529cebe9', '9679556fe209fbadac5275b3ac71e456', '69629f700425ebf48b88cc659c689992'].some((h) => code(148).includes(h)));
  add('no dependency on M141 / M142 / Fiscal in the code of the chain files', !CHAIN.some((c) => /period_checkpoint|business_date_of_v1|verifactu|migration_14[12]\b/i.test(code(c.n))));
  return out;
}

async function connect() {
  const base = process.env.W3_PG_NODE_MODULES;
  const pg = base ? require(path.join(base, 'pg')) : require('pg');
  const client = process.env.PREFLIGHT_DATABASE_URL ? new pg.Client({ connectionString: process.env.PREFLIGHT_DATABASE_URL }) : new pg.Client();
  await client.connect();
  return client;
}
async function runSql(client, sql) {        // read-only transaction; always rolled back
  await client.query('BEGIN TRANSACTION READ ONLY');   // no isolation level forced: the session check must see the real defaults
  try { return (await client.query(sql)).rows; } finally { await client.query('ROLLBACK').catch(() => {}); }
}
const verdictOf = (rows) => { const v = rows.find((r) => /^VERDICT /.test(r.k)); return !!(v && v.ok === true) && rows.every((r) => r.ok === true); };

module.exports = { CHAIN, MODES, FN, TRIGGERS, CONSTRAINTS, COMMENTS, DEPENDENCIES, renderSql, checkFiles, runSql, verdictOf, stateFor };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const noRegistry = rest.includes('--no-registry');
    if (cmd === 'files') {
      const r = checkFiles(); for (const x of r) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.k}${x.ok ? '' : '  -> ' + (x.detail || '')}`);
      for (const d of DEPENDENCIES) console.log(`INFO  ${d.m} requires ${d.needs.join(' + ')}: ${d.enforcedBy}`);
      const ok = r.every((x) => x.ok); console.log(`\nFILES ${ok ? 'PASS' : 'FAIL'} (${r.filter((x) => x.ok).length}/${r.length})`); process.exit(ok ? 0 : 1);
    }
    if ((cmd === 'sql' || cmd === 'run') && opt('--mode') === 'BEFORE_150') {
      console.error('BEFORE_150 is not a resting state: 149 and 150 are ONE step, applied and rolled back only by scripts/economy149150GuardedStep.js '
        + '(a database found at "149 without 150" is completed by its `forward` command).');
      process.exit(1);
    }
    if (cmd === 'sql') { process.stdout.write(renderSql(opt('--mode'), { noRegistry })); return; }
    if (cmd === 'run') {
      const mode = opt('--mode'); const sql = renderSql(mode, { noRegistry }); let client;
      try { client = await connect(); } catch (e) { console.error('connection error: ' + e.message); process.exit(2); }
      try { const rows = await runSql(client, sql); for (const x of rows) console.log(`${x.ok === true ? 'PASS' : 'FAIL'}  [${x.sec}] ${x.k}  got=${x.got}  want=${x.want}`); const ok = verdictOf(rows); console.log(`\nPREFLIGHT ${mode} ${ok ? 'PASS' : 'FAIL'}`); process.exit(ok ? 0 : 1); }
      finally { await client.end().catch(() => {}); }
    }
    console.error('usage: economy139to146Preflight.js files | sql --mode <MODE> [--no-registry] | run --mode <MODE> [--no-registry]\nmodes: ' + Object.keys(MODES).join(', '));
    process.exit(2);
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
