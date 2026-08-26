'use strict';

class BillingValidationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'BillingValidationError';
    this.code = code;
  }
}

function toCents(value, field = 'amount') {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BillingValidationError('BILLING_INVALID_AMOUNT', `${field} must be non-negative`);
  }
  return Math.round((n + Number.EPSILON) * 100);
}

function fromCents(value) {
  if (!Number.isInteger(value)) {
    throw new BillingValidationError('BILLING_INVALID_CENTS', 'cents must be an integer');
  }
  return value / 100;
}

function positiveInteger(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new BillingValidationError('BILLING_INVALID_COVERS', `${field} must be a positive integer`);
  }
  return n;
}

// Deterministic sequential Roman split. Extra cents are collected first, so
// 50 / 3 becomes 16.67, 16.67, 16.66 and the table always closes at exactly zero.
function nextEqualShare(outstanding, remainingCovers) {
  const cents = toCents(outstanding, 'outstanding');
  const covers = positiveInteger(remainingCovers, 'remainingCovers');
  if (cents === 0) return 0;
  return fromCents(Math.ceil(cents / covers));
}

function splitEqual(total, covers) {
  const coverCount = positiveInteger(covers, 'covers');
  let outstandingCents = toCents(total, 'total');
  const shares = [];
  for (let remaining = coverCount; remaining > 0; remaining -= 1) {
    const share = Math.ceil(outstandingCents / remaining);
    shares.push(fromCents(share));
    outstandingCents -= share;
  }
  return Object.freeze(shares);
}

function computeOutstanding({ total, payments = [], refunds = [] } = {}) {
  const totalCents = toCents(total, 'total');
  const paidCents = payments.reduce((sum, value) => sum + toCents(value, 'payment'), 0);
  const refundedCents = refunds.reduce((sum, value) => sum + toCents(value, 'refund'), 0);
  const collectedCents = Math.max(0, paidCents - refundedCents);
  return Object.freeze({
    total: fromCents(totalCents),
    paid: fromCents(paidCents),
    refunded: fromCents(refundedCents),
    collected: fromCents(collectedCents),
    outstanding: fromCents(Math.max(0, totalCents - collectedCents)),
    // OVER-COLLECTED SLICE A — the published complement of outstanding, from
    // the SAME raw difference before either side is clamped away. A caller
    // that only reads `outstanding` must never be able to observe
    // collected > total as a false zero (over-collected audit §7/frozen §2).
    overCollected: fromCents(Math.max(0, collectedCents - totalCents)),
  });
}

function aggregateByMethod(transactions = []) {
  const totals = Object.create(null);
  for (const tx of transactions) {
    if (!tx || tx.status === 'reversed') continue;
    const method = String(tx.method || '').trim().toLowerCase();
    if (!method) throw new BillingValidationError('BILLING_INVALID_METHOD', 'method is required');
    const sign = String(tx.kind || 'payment').toLowerCase() === 'refund' ? -1 : 1;
    totals[method] = (totals[method] || 0) + sign * toCents(tx.amount, 'transaction amount');
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(totals).map(([method, cents]) => [method, fromCents(cents)])
  ));
}

module.exports = {
  BillingValidationError,
  toCents,
  fromCents,
  nextEqualShare,
  splitEqual,
  computeOutstanding,
  aggregateByMethod,
};
