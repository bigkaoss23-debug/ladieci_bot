'use strict';
// Access Control V2 — Block B3: shared PIN format policy (reused by B6).
// Pure functions, no env, no I/O, no logging. Numeric PIN policy only — scrypt
// hashing is B1, verification is the login flow. `reason` is for internal/B6 use;
// the login endpoint must map any failure to a GENERIC external error.

// Role → allowed digit length [min, max]. Admin 9–12 / operator·rider 6–8 are
// disjoint by design (owner PIN can never collide with an operational PIN).
const ROLE_PIN_RULES = Object.freeze({
  admin:    { min: 9, max: 12 },
  operator: { min: 6, max: 8 },
  rider:    { min: 6, max: 8 },
});

// Explicit weak PINs (any length) — never allowed.
const WEAK_PINS = Object.freeze(new Set([
  '000000', '111111', '123456', '654321', '12345678', '87654321',
  '00000000', '11111111', '112233', '123321', '696969', '000000000',
]));

function isAllSame(pin) { return /^(\d)\1*$/.test(pin); }

// Full ascending or descending run of consecutive digits (e.g., 123456, 654321).
function isSequential(pin) {
  let asc = true, desc = true;
  for (let i = 1; i < pin.length; i++) {
    const d = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

// Trivial repeated block, e.g. 121212 ("12"×3), 123123 ("123"×2), 0000 ("0"×n).
function isRepeatedBlock(pin) {
  const n = pin.length;
  for (let b = 1; b <= Math.floor(n / 2); b++) {
    if (n % b !== 0) continue;
    const block = pin.slice(0, b);
    if (block.repeat(n / b) === pin) return true;
  }
  return false;
}

// Returns { ok, reason }. reason is NEVER surfaced to the login client.
function validatePinFormat(pin, role) {
  const rule = ROLE_PIN_RULES[role];
  if (!rule) return { ok: false, reason: 'unknown_role' };
  if (typeof pin !== 'string' || !/^\d+$/.test(pin)) return { ok: false, reason: 'not_digits' };
  if (pin.length < rule.min || pin.length > rule.max) return { ok: false, reason: 'bad_length' };
  if (isAllSame(pin)) return { ok: false, reason: 'all_same' };
  if (isSequential(pin)) return { ok: false, reason: 'sequential' };
  if (isRepeatedBlock(pin)) return { ok: false, reason: 'repeated_block' };
  if (WEAK_PINS.has(pin)) return { ok: false, reason: 'known_weak' };
  return { ok: true };
}

// ── S2-7D2: policy for NEW / rotated operational PINs — exactly 6 digits ─────
// Applies to EVERY role (owner/admin included — no bypass). Deliberately SEPARATE from the
// two login validators below/above: those must keep accepting the legacy lengths until all
// four actors have actually been rotated, because login checks the format BEFORE verifying
// the hash — tightening it there would reject a legacy 7-12 digit PIN outright and lock its
// actor out. Weak-PIN rules still apply: a 6-digit PIN must not be trivial.
const NEW_PIN_LENGTH = 6;

function validateNewPinFormat(pin) {
  if (typeof pin !== 'string' || !/^\d+$/.test(pin)) return { ok: false, reason: 'not_digits' };
  if (pin.length !== NEW_PIN_LENGTH) return { ok: false, reason: 'bad_length' };
  if (isAllSame(pin)) return { ok: false, reason: 'all_same' };
  if (isSequential(pin)) return { ok: false, reason: 'sequential' };
  if (isRepeatedBlock(pin)) return { ok: false, reason: 'repeated_block' };
  if (WEAK_PINS.has(pin)) return { ok: false, reason: 'known_weak' };
  return { ok: true };
}

function validateUniversalPinFormat(pin) {
  if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) return { ok: false, reason: 'invalid_format' };
  if (isAllSame(pin) || isSequential(pin) || isRepeatedBlock(pin) || WEAK_PINS.has(pin)) return { ok: false, reason: 'weak' };
  return { ok: true };
}

module.exports = {
  ROLE_PIN_RULES, NEW_PIN_LENGTH,
  validatePinFormat, validateNewPinFormat, validateUniversalPinFormat,
  isAllSame, isSequential, isRepeatedBlock,
};
