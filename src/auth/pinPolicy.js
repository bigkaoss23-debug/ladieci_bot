'use strict';
// Access Control V2 — Block B3: shared PIN format policy (reused by B6).
// Pure functions, no env, no I/O, no logging. Numeric PIN policy only — scrypt
// hashing is B1, verification is the login flow. `reason` is for internal/B6 use;
// the login endpoint must map any failure to a GENERIC external error.

// Role → allowed digit length [min, max].
const ROLE_PIN_RULES = Object.freeze({
  admin:    { min: 8, max: 12 },
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

module.exports = { ROLE_PIN_RULES, validatePinFormat, isAllSame, isSequential, isRepeatedBlock };
