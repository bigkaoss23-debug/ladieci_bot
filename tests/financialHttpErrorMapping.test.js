'use strict';
// B7A3 error-to-HTTP mapping tests. Run: node tests/financialHttpErrorMapping.test.js
// Proves every recognized B7A2C domain code maps to exactly one expected HTTP class,
// no recognized code falls through, unknown codes fail closed to 500, and the mapper
// exposes no SQL text. Expected classes are declared independently here (not imported
// from the mapper) to avoid a tautology.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { statusForCode, STATUS_BY_CODE, UNMAPPED_RECOGNIZED } = require('../src/auth/financialHttpErrors');
const { RECOGNIZED_DOMAIN_CODES, INTERNAL_ERROR_CODE } = require('../src/auth/financialDao');
const { UNAUTHENTICATED, INVALID_REQUEST } = require('../src/auth/financialService');

// Independent expected classification of the 23 SQL domain markers.
const EXPECT = {
  AUTH_ACTOR_NOT_FOUND: 401,
  AUTH_INITIATOR_INACTIVE: 403,
  AUTH_FORBIDDEN_ROLE: 403,
  AUTH_ORDER_NOT_FOUND: 404,
  AUTH_AMOUNT_INVALID: 400,
  AUTH_CONFIRMATION_REQUIRED: 400,
  AUTH_IDEM_KEY_INVALID: 400,
  AUTH_METHOD_INVALID: 400,
  AUTH_REASON_BLANK: 400,
  AUTH_META_INVALID: 400,
  AUTH_META_TOO_LARGE: 400,
  AUTH_META_SENSITIVE_KEY: 400,
  AUTH_IP_HASH_REQUIRED: 400,
  AUTH_IP_HASH_TOO_LONG: 400,
  AUTH_IDEMPOTENCY_CONFLICT: 409,
  AUTH_BASIS_EXISTS: 409,
  AUTH_LEGACY_IMPORT_REQUIRED: 409,
  AUTH_NOT_LEGACY_PAID: 409,
  AUTH_NO_PAYMENT_BASIS: 409,
  AUTH_ALREADY_REFUNDED: 409,
  AUTH_VOID_STATE_FORBIDDEN: 409,
  AUTH_REFUND_BASIS_INTEGRITY: 409,
  AUTH_VOID_REPLAY_INTEGRITY: 409,
};

// completeness: every recognized domain code is explicitly mapped
assert('no recognized domain code is unmapped', UNMAPPED_RECOGNIZED.length === 0, UNMAPPED_RECOGNIZED.join(','));
assert('EXPECT covers exactly the 23 recognized markers', RECOGNIZED_DOMAIN_CODES.length === Object.keys(EXPECT).length && RECOGNIZED_DOMAIN_CODES.every((c) => c in EXPECT));

// each recognized code → the expected class, exactly one
for (const code of RECOGNIZED_DOMAIN_CODES) {
  assert(`${code} → ${EXPECT[code]}`, statusForCode(code) === EXPECT[code], String(statusForCode(code)));
}

// service boundary codes
assert('FINANCIAL_UNAUTHENTICATED → 401', statusForCode(UNAUTHENTICATED) === 401);
assert('FINANCIAL_INVALID_REQUEST → 400', statusForCode(INVALID_REQUEST) === 400);
assert('FINANCIAL_INTERNAL_ERROR → 500', statusForCode(INTERNAL_ERROR_CODE) === 500);

// every mapped status is one of the allowed classes
const ALLOWED = new Set([400, 401, 403, 404, 409, 500]);
assert('all mapped statuses are in the allowed class set', Object.values(STATUS_BY_CODE).every((s) => ALLOWED.has(s)));

// unknown / unmapped / junk fail closed to 500
assert('unknown code → 500', statusForCode('TOTALLY_UNKNOWN') === 500);
assert('empty code → 500', statusForCode('') === 500);
assert('null code → 500', statusForCode(null) === 500);
assert('object code → 500', statusForCode({}) === 500);

// class buckets present (sanity: at least the required buckets are populated)
const byStatus = (s) => Object.keys(STATUS_BY_CODE).filter((c) => STATUS_BY_CODE[c] === s);
assert('has 401 bucket', byStatus(401).length >= 1);
assert('has 403 bucket', byStatus(403).length >= 1);
assert('has 404 bucket (order not found)', byStatus(404).includes('AUTH_ORDER_NOT_FOUND'));
assert('has 400 bucket', byStatus(400).length >= 5);
assert('has 409 bucket', byStatus(409).length >= 5);
assert('has 500 bucket', byStatus(500).includes(INTERNAL_ERROR_CODE));

// mapper source contains no SQL text / secrets
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/auth/financialHttpErrors.js'), 'utf8');
assert('mapper exposes no SQL/PostgREST text', !/SELECT |INSERT |UPDATE |pg_temp|search_path|rest\/v1|SUPABASE_KEY/i.test(src));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
