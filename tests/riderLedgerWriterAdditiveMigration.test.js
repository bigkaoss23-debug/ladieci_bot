'use strict';
// S2-7D6E2 — static contract of migrations/2026-07-27_s2_7d6e2_rider_delivery_collection.sql.
//
// The migration is a DRAFT (not applied), so this test is the only thing standing between a
// typo and a production accounting change. It asserts the properties that make the rider
// path safe, not the prose:
//   * ONE ledger writer; the rider RPC writes no event of its own and derives no amount
//   * order_mark_paid's generic authority is still admin/operator ONLY (no role widening)
//   * the rider contract demands role === 'rider' exactly, and trip membership
//   * the ledger-less complete_rider_stop is DROPPED, not merely replaced
//   * completion never writes cobrado/metodo_pago — payment stays separate from state
//   * a lost race after taking the money ABORTS rather than returning
//
// Run: node tests/riderDeliveryCollectionMigration.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const MIG = path.join(__dirname, '..', 'migrations');
const FILE = '2026-07-27_s2_7d6e2_rider_delivery_collection.sql';
const sql = fs.readFileSync(path.join(MIG, FILE), 'utf8');
const rollback = fs.readFileSync(path.join(MIG, FILE.replace('.sql', '.ROLLBACK.sql')), 'utf8');

// Body of one CREATE OR REPLACE FUNCTION block, up to the closing $fn$;
function fnBody(source, name) {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
  if (start < 0) return '';
  const rest = source.slice(start);
  const end = rest.indexOf('$fn$;');
  return rest.slice(0, end === -1 ? rest.length : end);
}

const writer = fnBody(sql, '_ledger_write_payment');
const markPaid = fnBody(sql, 'order_mark_paid');
const rider = fnBody(sql, 'rider_collect_and_complete_stop');

console.log('\n[transaction + guards]');
check('wrapped in a single transaction', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/.test(sql.trim()));
check('staging sentinel guard present', sql.includes("version='20260710075612'"));
check('refuses to run without the guarded order_mark_paid', /S2-7D6E2 refused: guarded order_mark_paid absent/.test(sql));

console.log('\n[one ledger writer]');
check('the shared writer exists', writer.length > 0);
check('writer is the ONLY inserter into order_financial_events',
  (sql.match(/INSERT INTO public\.order_financial_events/g) || []).length === 1);
check('the single INSERT lives inside the writer', /INSERT INTO public\.order_financial_events/.test(writer));
check('writer derives the amount server-side from the order total', /v_amount := round\(v_ord\.totale, 2\)/.test(writer));
check('writer amount variable is numeric(10,2) — guards the digest-replay bug class',
  /v_amount numeric\(10,2\)/.test(writer));
check('writer refuses a non-positive amount', /AUTH_AMOUNT_INVALID/.test(writer));
check('writer enforces one payment basis per order', /AUTH_BASIS_EXISTS/.test(writer));
check('writer refuses to double-count pre-ledger money', /AUTH_LEGACY_IMPORT_REQUIRED/.test(writer));
check('writer builds exactly one canonical payload', (writer.match(/v_canon := jsonb_build_object/g) || []).length === 1);

console.log('\n[order_mark_paid: generic authority UNCHANGED]');
check('order_mark_paid still gates to admin/operator only',
  /IF v_role NOT IN \('admin','operator'\) THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE'/.test(markPaid));
check("the generic gate was NOT widened to include 'rider'",
  !/NOT IN \('admin','operator','rider'\)/.test(sql));
check('order_mark_paid still verifies session_version against the locked actor',
  /p_session_version <> v_by\.session_version/.test(markPaid));
check('order_mark_paid delegates the money tail to the shared writer',
  /RETURN public\._ledger_write_payment\(/.test(markPaid));
check('order_mark_paid no longer inserts on its own', !/INSERT INTO public\.order_financial_events/.test(markPaid));

console.log('\n[rider contract: narrow by construction]');
check('rider contract exists', rider.length > 0);
check("requires the role to be EXACTLY 'rider'", /v_by\.role <> 'rider'/.test(rider));
check('rider contract never accepts admin/operator as a fallback', !/'admin'/.test(rider) && !/'operator'/.test(rider));
check('validates session_version against the locked actor row',
  /p_session_version <> v_by\.session_version/.test(rider));
check('requires an ACTIVE trip', /NO_ACTIVE_TRIP/.test(rider));
check('requires the order to belong to that trip', /NON_MEMBER/.test(rider) && /order_ids' \? p_order_id/.test(rider));
check('accepts only real delivery collection methods',
  /v_method NOT IN \('efectivo','tarjeta','bizum'\)/.test(rider));
check('takes no amount parameter — the client cannot price the collection',
  !/p_amount/.test(rider));
check('forces meta.source = rider_delivery server-side',
  /jsonb_build_object\('source', 'rider_delivery'\)/.test(rider));
check('records the payment through the shared writer, never its own INSERT',
  /public\._ledger_write_payment\(/.test(rider) && !/INSERT INTO/.test(rider));
check('passes the rider as the real actor/role on the event',
  /p_by_actor, v_by\.role/.test(rider));
check('can only ever write a payment — no refund/void/discount path',
  !/order_refund|order_void|descuento/.test(rider));

console.log('\n[payment separate from operative state]');
check('stop completion does NOT write cobrado', !/SET[\s\S]*cobrado/.test(rider.split('UPDATE public.ordenes')[1] || ''));
check('stop completion does NOT write metodo_pago',
  !/metodo_pago\s*=/.test(rider.split('UPDATE public.ordenes')[1] || ''));
check('completion only sets estado + hora_entrega',
  /SET\s+estado\s+=\s+'RETIRADO',\s*\n\s*hora_entrega/.test(rider));
check('a lost race ABORTS so a recorded payment cannot outlive an uncompleted stop',
  /RAISE EXCEPTION 'RIDER_STOP_LOST_RACE'/.test(rider));
check('a refused payment stops the flow before completion', /PAYMENT_REFUSED/.test(rider));

console.log('\n[the ledger-less path is gone]');
check('old complete_rider_stop is DROPPED',
  /DROP FUNCTION IF EXISTS public\.complete_rider_stop\(text, boolean, text\);/.test(sql));
// Strip `--` comments first: the migration header QUOTES the old defect verbatim to
// explain it, and a prose mention must not read as surviving executable SQL.
const executable = sql.replace(/^\s*--.*$/gm, '');
check('no surviving cobrado = COALESCE(p_cobrado, true) in executable SQL',
  !/COALESCE\(p_cobrado/.test(executable));
check('the migration never takes a p_cobrado parameter', !/p_cobrado\s+boolean/.test(executable));
check('the defect IS still documented in the header for the next reader',
  /COALESCE\(p_cobrado, true\)/.test(sql));

console.log('\n[grants]');
for (const fn of ['_ledger_write_payment', 'rider_collect_and_complete_stop']) {
  check(fn + ' revoked from anon/authenticated',
    new RegExp('REVOKE EXECUTE ON FUNCTION public\\.' + fn + '[\\s\\S]{0,200}FROM PUBLIC, anon, authenticated').test(sql));
  check(fn + ' granted to service_role only',
    new RegExp('GRANT  EXECUTE ON FUNCTION public\\.' + fn + '[\\s\\S]{0,200}TO service_role').test(sql));
}

console.log('\n[rollback]');
check('rollback exists and is transactional', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/.test(rollback.trim()));
check('rollback restores the ledger-less complete_rider_stop',
  /CREATE OR REPLACE FUNCTION public\.complete_rider_stop\(/.test(rollback));
check('rollback drops the rider contract',
  /DROP FUNCTION IF EXISTS public\.rider_collect_and_complete_stop/.test(rollback));
check('rollback drops the shared writer',
  /DROP FUNCTION IF EXISTS public\._ledger_write_payment/.test(rollback));
check('rollback restores an order_mark_paid that inserts on its own',
  /INSERT INTO public\.order_financial_events/.test(rollback));
check('rollback REFUSES if rider-recorded payments already exist',
  /ROLLBACK REFUSED: rider-recorded payments exist/.test(rollback));

console.log('');
console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
