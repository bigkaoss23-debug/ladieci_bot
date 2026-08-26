'use strict';

const assert = require('node:assert/strict');
const {
  BillingValidationError,
  nextEqualShare,
  splitEqual,
  computeOutstanding,
  aggregateByMethod,
} = require('../src/tables/billingMath');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (error) {
    process.stderr.write(`  FAIL  ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

test('50 euro / 5 covers is exactly 10 each', () => {
  assert.deepEqual(splitEqual(50, 5), [10, 10, 10, 10, 10]);
});

test('uneven cents are assigned deterministically and still sum exactly', () => {
  const shares = splitEqual(50, 3);
  assert.deepEqual(shares, [16.67, 16.67, 16.66]);
  assert.equal(shares.reduce((sum, value) => sum + Math.round(value * 100), 0), 5000);
});

test('early product payer updates both remaining bill and next Roman share', () => {
  const bill = computeOutstanding({ total: 50, payments: [12] });
  assert.equal(bill.outstanding, 38);
  assert.equal(nextEqualShare(bill.outstanding, 4), 9.5);
});

test('multiple partial payments and a refund are accumulated in cents', () => {
  assert.deepEqual(
    computeOutstanding({ total: 50, payments: [10, 12.35, 7.65], refunds: [5] }),
    { total: 50, paid: 30, refunded: 5, collected: 25, outstanding: 25, overCollected: 0 }
  );
});

// OVER-COLLECTED SLICE A — both sides of the equation are published together
// from the SAME raw difference; a caller must never see one clamp away and
// have to infer the other.
test('collected above total publishes overCollected, never a fake zero outstanding hiding it', () => {
  assert.deepEqual(
    computeOutstanding({ total: 20, payments: [30] }),
    { total: 20, paid: 30, refunded: 0, collected: 30, outstanding: 0, overCollected: 10 }
  );
});

test('collected below total publishes outstanding with overCollected at zero', () => {
  assert.deepEqual(
    computeOutstanding({ total: 30, payments: [20] }),
    { total: 30, paid: 20, refunded: 0, collected: 20, outstanding: 10, overCollected: 0 }
  );
});

test('mixed methods remain distinct in the cash result', () => {
  assert.deepEqual(
    { ...aggregateByMethod([
      { kind: 'payment', method: 'efectivo', amount: 10 },
      { kind: 'payment', method: 'tarjeta', amount: 22.5 },
      { kind: 'payment', method: 'bizum', amount: 17.5 },
      { kind: 'refund', method: 'tarjeta', amount: 2.5 },
    ]) },
    { efectivo: 10, tarjeta: 20, bizum: 17.5 }
  );
});

test('invalid covers fail closed', () => {
  assert.throws(() => splitEqual(10, 0), (error) =>
    error instanceof BillingValidationError && error.code === 'BILLING_INVALID_COVERS');
});

if (!process.exitCode) process.stdout.write(`\n=== RESULT: ${passed} passed, 0 failed ===\n`);
