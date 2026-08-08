'use strict';
// SERVICE CLOSEOUT V2 / Slice 2 — static test over the post-close financial
// resolution migration SQL text itself. Same convention as
// tests/serviceCloseoutIncidentsFoundation.static.test.js (see that file's
// header for why static-text assertions are used here — STAGING ONLY, no
// live Postgres available/permitted from this test runner).

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '2026-08-08_service_closeout_post_close_financial_resolutions.sql');
const ROLLBACK_PATH = path.join(__dirname, '..', 'migrations', '2026-08-08_service_closeout_post_close_financial_resolutions.ROLLBACK.sql');

(async () => {
  console.log('\n== post-close financial resolution foundation — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: staging sentinel guard present (matches every other migration in this repo)', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1c: fail-closed on pre-existing target object (no silent drift)', sql.includes('post-close financial resolutions refused: target object already exists'));
  assert('1d: prerequisite check for service_sessions/service_incidents/storico', sql.includes("to_regclass('public.service_sessions') IS NULL") && sql.includes("to_regclass('public.service_incidents') IS NULL") && sql.includes("to_regclass('public.storico') IS NULL"));

  console.log('\n── additive-only, no rewrite of existing financial/closeout truth ──');
  const destructivePatterns = [
    /DROP\s+TABLE(?!\s+IF\s+NOT)/i,
    /ALTER\s+TABLE\s+public\.(service_sessions|service_session_state|service_session_audit|order_financial_events|orden_estado_logs|ordenes|storico|serata_summary|backup_serata|service_closeout_snapshots|service_incidents|service_incident_resolutions)\s+DROP/i,
    /RENAME\s+TO/i,
    /TRUNCATE/i,
  ];
  for (const re of destructivePatterns) {
    assert('2: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  assert('2b: no existing table is ALTERed at all (only the new table is created)', !/ALTER\s+TABLE\s+public\.(service_sessions|service_session_state|service_session_audit|order_financial_events|orden_estado_logs|ordenes|storico|serata_summary|backup_serata|service_closeout_snapshots|service_incidents|service_incident_resolutions)\b/i.test(sql));
  assert('2c: no existing function is dropped', !/DROP\s+FUNCTION/i.test(sql));
  assert('2d: storico is never written to (no INSERT/UPDATE/UPSERT statement targets it)', !/(INSERT\s+INTO|UPDATE)\s+public\.storico/i.test(sql));
  assert('2e: serata_summary is never written to', !/(INSERT\s+INTO|UPDATE)\s+public\.serata_summary/i.test(sql));
  assert('2f: order_financial_events is never written to (this is a separate ledger family, not an extension of it)', !/(INSERT\s+INTO|UPDATE)\s+public\.order_financial_events/i.test(sql));
  assert('2g: service_incidents.financial_exposure_cents is never written to (immutable detection fact, never overwritten by a resolution)', !/UPDATE\s+public\.service_incidents/i.test(sql));

  console.log('\n── identity (lineage keyed on the pair, never archived_order_id alone) ──');
  assert('3a: archived_order_id carries no REFERENCES clause (FK-less historical identity, same philosophy as order_financial_events.order_id/service_incidents.order_id)', !/archived_order_id\s+text\s+REFERENCES/.test(sql));
  assert('3b: rationale documented inline (not just tribal knowledge)', sql.includes('order numbers are reused across sessions'));
  assert('3c: the lineage lookup index covers the composite (service_session_id, archived_order_id), not archived_order_id alone', sql.includes('aofr_lineage_idx') && /CREATE (?:UNIQUE )?INDEX aofr_lineage_idx ON public\.archived_order_financial_resolutions\(service_session_id, archived_order_id/.test(sql));

  console.log('\n── amount semantics (integer cents, never float) ──');
  for (const col of ['original_exposure_cents', 'amount_cents', 'remaining_exposure_cents']) {
    assert('4a: ' + col + ' is integer typed, never numeric/float/decimal', new RegExp(col + '\\s+integer').test(sql));
  }
  assert('4b: original_exposure_cents/remaining_exposure_cents can never go negative at the DB level', /original_exposure_cents\s+integer\s+NOT NULL\s+CHECK\s*\(original_exposure_cents >= 0\)/.test(sql) && /remaining_exposure_cents\s+integer\s+NOT NULL\s+CHECK\s*\(remaining_exposure_cents >= 0\)/.test(sql));
  assert('4c: amount_cents must be strictly positive (a zero-amount event is meaningless)', /amount_cents\s+integer\s+NOT NULL\s+CHECK\s*\(amount_cents > 0\)/.test(sql));
  assert('4f: created_at defaults to clock_timestamp(), never now() — now()/transaction_timestamp() is frozen for the whole transaction, which made lineage-ordering ties possible (a real defect caught by real-Postgres validation) when multiple events on one lineage are inserted in the same transaction', /created_at\s+timestamptz NOT NULL DEFAULT clock_timestamp\(\)/.test(sql) && !/created_at\s+timestamptz NOT NULL DEFAULT now\(\)/.test(sql));
  assert('4d: the RPC fails closed on over-resolution rather than clamping to zero', sql.includes('OVER_RESOLUTION_EXCEEDS_REMAINING') && sql.includes('v_remaining < 0'));
  assert('4e: reversal is full-amount-only, checked against the exact reversed event amount', sql.includes('REVERSAL_AMOUNT_MISMATCH') && sql.includes('p_amount_cents IS DISTINCT FROM v_reversed.amount_cents'));

  console.log('\n── SLICE 2.1 — authoritative exposure (caller can no longer choose original_exposure_cents) ──');
  const rpcSignature = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.create_archived_order_financial_resolution('),
    sql.indexOf(') RETURNS jsonb')
  );
  assert('4g: p_original_exposure_cents no longer exists as an RPC parameter (checked against the signature itself, not prose comments that document its removal)', rpcSignature.length > 0 && !rpcSignature.includes('p_original_exposure_cents'));
  assert('4g2: p_related_incident_id IS a required parameter of that same signature (no DEFAULT — Postgres would refuse a non-default param after a defaulted one, so this also proves it was moved earlier in the parameter list)', /p_related_incident_id\s+uuid,/.test(rpcSignature));
  assert('4h: ORIGINAL_EXPOSURE_REQUIRED/ORIGINAL_EXPOSURE_MISMATCH (the old caller-trust codes) are gone — there is nothing left for a caller to supply that could mismatch', !sql.includes('ORIGINAL_EXPOSURE_REQUIRED') && !sql.includes('ORIGINAL_EXPOSURE_MISMATCH'));
  assert('4i: the first event of a lineage derives original_exposure_cents from the linked incident immutable financial_exposure_cents, not from any p_ parameter', /v_original\s*:=\s*v_incident\.financial_exposure_cents/.test(sql));
  assert('4j: a defensive NULL-exposure check exists even though service_incidents already forbids a financial incident with a NULL exposure', sql.includes('INCIDENT_MISSING_EXPOSURE') && /v_incident\.financial_exposure_cents IS NULL/.test(sql));

  console.log('\n── SLICE 2.1 — archived order must actually exist ──');
  assert('4k: the RPC verifies the archived order exists in storico, keyed on the same (service_session_id, orden_id) pair storico itself uses', sql.includes('ARCHIVED_ORDER_NOT_FOUND') && /FROM public\.storico\s+WHERE service_session_id = p_service_session_id AND orden_id = p_archived_order_id/.test(sql));

  console.log('\n── SLICE 2.1 — mandatory, validated incident linkage ──');
  assert('4l: related_incident_id is NOT NULL at the table level (was optional pre-2.1)', /related_incident_id\s+uuid NOT NULL REFERENCES public\.service_incidents\(id\)/.test(sql));
  assert('4m: a NULL p_related_incident_id is rejected before any lookup', sql.includes('INCIDENT_LINK_REQUIRED') && /IF p_related_incident_id IS NULL THEN/.test(sql));
  assert('4n: the incident must belong to the exact same service_session_id', sql.includes('INCIDENT_SERVICE_MISMATCH') && /v_incident\.service_session_id IS DISTINCT FROM p_service_session_id/.test(sql));
  assert('4o: the incident must be category=financial', sql.includes('INCIDENT_NOT_FINANCIAL') && /v_incident\.category <> 'financial'/.test(sql));
  assert('4p: the incident must describe the exact same archived order', sql.includes('INCIDENT_ORDER_MISMATCH') && /v_incident\.order_id IS DISTINCT FROM p_archived_order_id/.test(sql));
  assert('4q: every later event in a lineage must reference the SAME incident as the first (frozen, exactly like original_exposure_cents)', sql.includes('INCIDENT_LINK_MISMATCH') && /p_related_incident_id IS DISTINCT FROM v_prior\.related_incident_id/.test(sql));

  console.log('\n── SLICE 2.1 — lineage_sequence is the sole accounting-order primitive ──');
  assert('4r: lineage_sequence column exists, integer, NOT NULL, strictly positive', /lineage_sequence\s+integer NOT NULL CHECK \(lineage_sequence > 0\)/.test(sql));
  assert('4s: aofr_lineage_idx is a UNIQUE index on (service_session_id, archived_order_id, lineage_sequence) — no two events in one lineage can share a sequence number', /CREATE UNIQUE INDEX aofr_lineage_idx ON public\.archived_order_financial_resolutions\(service_session_id, archived_order_id, lineage_sequence\)/.test(sql));
  assert('4t: the RPC current-state lookup orders by lineage_sequence DESC', /ORDER BY lineage_sequence DESC\s*$/m.test(sql));
  assert('4u: REGRESSION GUARD — no executable ORDER BY in this file ever sorts a current-state lookup by created_at DESC (the exact Slice-2 defect this hardening fixes)', !/ORDER BY created_at DESC/.test(sqlWithoutComments));
  assert('4v: REGRESSION GUARD — no executable ORDER BY ever adds a uuid/id tiebreak to a current-state lookup (random, not accounting order)', !/ORDER BY (created_at|lineage_sequence)[^;]*,\s*id DESC/.test(sqlWithoutComments));
  assert('4w: the INSERT statement persists lineage_sequence explicitly (v_sequence), it is never left to a DB default', /lineage_sequence\)\s*\n?\s*VALUES/.test(sql.replace(/\s+/g, ' ')) || /remaining_exposure_cents, lineage_sequence,/.test(sql));
  assert('4x: a retry (ON CONFLICT DO NOTHING) never allocates a fresh sequence — v_sequence is computed once, before the INSERT is even attempted, and discarded on conflict', sqlWithoutComments.indexOf('v_sequence := ') < sqlWithoutComments.indexOf('ON CONFLICT (action_correlation_id) DO NOTHING'));

  console.log('\n── resolution vocabulary and effects ──');
  assert('5a: resolution_type is a closed 3-value vocabulary', sql.includes("CHECK (resolution_type IN ('recovered_payment','write_off','reversal'))"));
  assert('5b: recovered_payment requires a canonical payment method (same vocabulary as order_financial_events)', /payment_method IN \('efectivo','tarjeta','bizum'\)/.test(sql));
  assert('5c: write_off/reversal are constrained to NEVER carry a payment method (never pretend cash was collected)', sql.includes('aofr_payment_method_chk'));
  assert('5d: reversal requires reversed_event_id; every other type forbids it', sql.includes('aofr_reversal_target_chk'));
  assert('5e: a given event can be reversed at most once', sql.includes('aofr_one_reversal_per_event_uq') && /WHERE resolution_type = 'reversal'/.test(sql));
  assert('5f: only recovered_payment/write_off are reversible — a reversal of a reversal is rejected', sql.includes('REVERSED_EVENT_NOT_REVERSIBLE'));

  console.log('\n── idempotency (action identity, never order_id+amount) ──');
  assert('6a: action_correlation_id is DB-enforced unique — real idempotency, not just app discipline', sql.includes('aofr_correlation_uq UNIQUE (action_correlation_id)'));
  assert('6b: idempotency is on action identity, ON CONFLICT DO NOTHING + reselect (same shape as capture_closeout_snapshot/create_service_incident)', /ON CONFLICT \(action_correlation_id\) DO NOTHING/.test(sql) && sql.includes('ALREADY_RECORDED'));
  assert('6c: no dedup on (archived_order_id, amount_cents) anywhere — the same amount can legitimately recur', !/UNIQUE\s*\(\s*archived_order_id\s*,\s*amount_cents/i.test(sql));
  assert('6d: original_exposure_cents is frozen per lineage structurally, SLICE 2.1 — there is no p_original_exposure_cents parameter left for a later event to mismatch on; it is always carried forward from v_prior', /v_original\s*:=\s*v_prior\.original_exposure_cents/.test(sql));
  assert('6e: concurrency — an advisory lock serializes every writer on the same lineage, including the first event', /pg_advisory_xact_lock\(hashtext\(p_service_session_id::text \|\| ':' \|\| p_archived_order_id\)\)/.test(sql));

  console.log('\n── SLICE 2.1 — retry idempotency is unconditional, not order-dependent (real-Postgres finding) ──');
  const idempotencyShortCircuitIdx = sql.indexOf("SELECT * INTO v_row FROM public.archived_order_financial_resolutions WHERE action_correlation_id = p_action_correlation_id;\n  IF FOUND THEN");
  const advisoryLockIdx = sql.indexOf('PERFORM pg_advisory_xact_lock');
  const incidentLinkRequiredIdx = sql.indexOf("code','INCIDENT_LINK_REQUIRED'");
  assert('6f: an early SELECT-by-action_correlation_id short-circuit exists', idempotencyShortCircuitIdx !== -1);
  assert('6g: the short-circuit runs BEFORE the advisory lock and BEFORE any state-dependent validation (incident/exposure/arithmetic) — a retry must never be evaluated against the CURRENT lineage state', idempotencyShortCircuitIdx !== -1 && idempotencyShortCircuitIdx < incidentLinkRequiredIdx && idempotencyShortCircuitIdx < advisoryLockIdx);
  assert('6h: ON CONFLICT DO NOTHING is retained as a genuine-concurrent-race backstop alongside the early short-circuit, not replaced by it', /ON CONFLICT \(action_correlation_id\) DO NOTHING/.test(sql));

  console.log('\n── SLICE 2.2 — idempotency is bound to the exact command, not just the correlation id ──');
  const shortCircuitBlock = sql.slice(idempotencyShortCircuitIdx, idempotencyShortCircuitIdx + 1200);
  assert('6i: a correlation-id match is NOT unconditionally treated as ALREADY_RECORDED — a comparison gate exists first', idempotencyShortCircuitIdx !== -1 && /IF v_row\.service_session_id IS DISTINCT FROM p_service_session_id/.test(shortCircuitBlock));
  for (const field of ['archived_order_id', 'related_incident_id', 'resolution_type', 'amount_cents', 'reversed_event_id']) {
    assert('6j: the payload-binding comparison covers ' + field, new RegExp('v_row\\.' + field + '\\s+IS DISTINCT FROM\\s+p_' + field).test(shortCircuitBlock));
  }
  assert('6k: the payload-binding comparison covers payment_method (normalized the same way as storage: lower(btrim(...)))', /v_row\.payment_method IS DISTINCT FROM \(CASE WHEN p_payment_method IS NULL THEN NULL ELSE lower\(btrim\(p_payment_method\)\) END\)/.test(shortCircuitBlock));
  assert('6l: a mismatch returns a distinct, fail-closed conflict code — never ALREADY_RECORDED for a different command', /code','ACTION_CORRELATION_ID_CONFLICT'/.test(shortCircuitBlock));
  const conflictIdx = sql.indexOf("code','ACTION_CORRELATION_ID_CONFLICT'");
  const alreadyRecordedInShortCircuitIdx = shortCircuitBlock.indexOf("code','ALREADY_RECORDED'");
  assert('6m: the conflict check is placed BEFORE the ALREADY_RECORDED return, so a genuine mismatch can never fall through to it', conflictIdx !== -1 && conflictIdx < idempotencyShortCircuitIdx + alreadyRecordedInShortCircuitIdx);
  assert('6n: naming rationale documents the repo-established precedent for this exact class of defect (capture_closeout_snapshot.CLOSEOUT_CORRELATION_ID_CONFLICT, Slice 1)', sql.includes('CLOSEOUT_CORRELATION_ID_CONFLICT'));
  assert('6o: actor/reason/note are explicitly documented as excluded from the binding comparison (attribution/narrative, not command-defining)', /actor\/reason\/note are (deliberately )?NOT compared/.test(sql));

  console.log('\n── append-only enforcement ──');
  assert('7a: a BEFORE UPDATE OR DELETE trigger unconditionally blocks mutation', sql.includes('archived_order_financial_resolutions_no_update_delete') && sql.includes('BEFORE UPDATE OR DELETE ON public.archived_order_financial_resolutions'));
  assert('7b: the trigger function unconditionally raises (no allowlist — nothing on this table is ever legitimately mutable)', /archived_order_financial_resolutions_append_only[\s\S]{0,300}RAISE EXCEPTION/.test(sql));

  console.log('\n── access control — deterministic privilege floor (Slice 1.3 discipline, applied from the start here) ──');
  assert('8a: RLS enabled', sql.includes('ALTER TABLE public.archived_order_financial_resolutions ENABLE ROW LEVEL SECURITY'));
  assert('8b: zero CREATE POLICY statements (default-deny for anon/authenticated)', !/CREATE\s+POLICY\s+\w/i.test(sqlWithoutComments));
  assert('8c: REVOKE ALL FROM PUBLIC, anon, authenticated, service_role BEFORE any grant-back — deterministic, not reliant on ambient defaults', /REVOKE ALL ON public\.archived_order_financial_resolutions\s+FROM PUBLIC, anon, authenticated, service_role/.test(sql));
  const revokeIdx = sql.indexOf('REVOKE ALL ON public.archived_order_financial_resolutions');
  const grantMatch = sql.match(/GRANT\s+([A-Z, ]+?)\s+ON\s+public\.archived_order_financial_resolutions\s+TO\s+service_role;/);
  assert('8d: exactly one GRANT ... TO service_role statement exists for this table', !!grantMatch);
  assert('8e: the grant is placed AFTER the REVOKE ALL (deterministic ordering, not accidental)', !!grantMatch && revokeIdx !== -1 && sql.indexOf(grantMatch[0]) > revokeIdx);
  const grantedPrivs = grantMatch ? grantMatch[1].split(',').map((s) => s.trim()).filter(Boolean).sort() : [];
  assert('8f: service_role privileges are EXACTLY {INSERT, SELECT} — the RPC only ever SELECTs and INSERTs, nothing here is ever UPDATEd/DELETEd', JSON.stringify(grantedPrivs) === JSON.stringify(['INSERT', 'SELECT']), JSON.stringify(grantedPrivs));
  const dangerousPrivileges = ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL', 'UPDATE'];
  const grantStatements = sqlWithoutComments.match(/GRANT\s+[^;]*?\bON\b[^;]*;/gi) || [];
  const grantsOnThisTable = grantStatements.filter((g) => /archived_order_financial_resolutions/.test(g));
  const offendingGrants = grantsOnThisTable.filter((g) => dangerousPrivileges.some((p) => new RegExp('\\b' + p + '\\b').test(g.slice(0, g.toUpperCase().indexOf(' ON ')))));
  assert('8g: no GRANT statement on this table ever includes UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/ALL, in any phrasing — regression guard against future accidental widening', offendingGrants.length === 0, JSON.stringify(offendingGrants));
  assert('8h: no sequence objects are created (uuid PRIMARY KEY DEFAULT gen_random_uuid(), never serial/bigserial)', !/CREATE\s+SEQUENCE/i.test(sql));
  assert('8i: every new function is SECURITY INVOKER (never SECURITY DEFINER)', !sql.includes('SECURITY DEFINER'));

  console.log('\n── authorization trust boundary (Slice 1.1 pattern reused) ──');
  assert('9a: the RPC enforces role=\'admin\' server-side, independent of any caller-supplied claim', sql.includes("p_actor_role IS DISTINCT FROM 'admin'") && sql.includes('FINANCIAL_RESOLUTION_FORBIDDEN'));
  assert('9b: header documents p_actor_role is NOT proof of identity by itself', /NOT proof of[\s\S]{0,40}identity/.test(sql));
  assert('9c: header forbids a future HTTP action from trusting a request body role field', /request body field/.test(sql));

  // No public HTTP resolution path yet — same repo-wide scan pattern as
  // tests/serviceCloseoutIncidentsFoundation.static.test.js §10d.
  const ROOT = path.join(__dirname, '..');
  const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'tests', 'migrations', 'docs']);
  const EXCLUDED_FILES = new Set([path.join(ROOT, 'src', 'closeout', 'archivedOrderFinancialResolutions.js')]);
  const SUSPECT_PATTERNS = [/create_archived_order_financial_resolution/, /archivedOrderFinancialResolutions\.record\(/];
  function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), out);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(path.join(dir, entry.name));
      }
    }
    return out;
  }
  const candidateFiles = [...walk(path.join(ROOT, 'src'), []), path.join(ROOT, 'index.js')].filter((f) => fs.existsSync(f) && !EXCLUDED_FILES.has(f));
  const wiredHits = [];
  for (const f of candidateFiles) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of SUSPECT_PATTERNS) {
      if (re.test(text)) wiredHits.push(path.relative(ROOT, f) + ' matches ' + re);
    }
  }
  assert('9d: no HTTP action/route or any other application module references this RPC/wrapper — no public resolution path yet', wiredHits.length === 0, JSON.stringify(wiredHits));

  console.log('\n── no wiring into existing financial RPCs or rollover behaviour ──');
  assert('10a: order_mark_paid/order_refund/order_void, if mentioned at all, only appear in prose comments', sqlWithoutComments.replace(/'[^']*'/g, '').indexOf('order_mark_paid') === -1 && sqlWithoutComments.replace(/'[^']*'/g, '').indexOf('order_refund') === -1 && sqlWithoutComments.replace(/'[^']*'/g, '').indexOf('order_void') === -1);
  assert('10b: chiudiServizio is not modified/referenced in executable SQL', sqlWithoutComments.replace(/'[^']*'/g, '').indexOf('chiudiServizio') === -1);
  assert('10c: explicit no-wiring statement present in the migration itself', sql.includes('nothing in this migration is called by any existing trigger'));

  console.log('\n── rollback is a clean mirror ──');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  assert('11a: rollback drops the new table', rollback.includes('DROP TABLE IF EXISTS public.archived_order_financial_resolutions'));
  assert('11b: rollback drops the new RPC', rollback.includes('DROP FUNCTION IF EXISTS public.create_archived_order_financial_resolution'));
  assert('11c: rollback touches no pre-existing table', !/ALTER\s+TABLE\s+public\.(service_sessions|order_financial_events|storico|serata_summary|service_incidents|service_closeout_snapshots)\b/i.test(rollback));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
