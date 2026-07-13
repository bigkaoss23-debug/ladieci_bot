'use strict';
// Access Control V2 — Block B1: versioned scrypt PIN hashing.
// Pure node:crypto. No external / native deps. No database, no JWT, no logging.
// This module NEVER logs and NEVER prints. It returns a result or throws a
// generic error that does not include the PIN. Telemetry / rate-limit belong to
// B3, not here.
//
// Hash format:  scrypt$1$<N>$<r>$<p>$<saltB64url>$<hashB64url>
// Version 1 accepts ONLY the exact parameter set below — no arbitrary ranges.
// A future format version will carry its own explicit configuration.

const crypto = require('crypto');

// Immutable v1 configuration. Frozen so accidental mutation cannot weaken it.
const V1 = Object.freeze({
  version: 1,
  N: 32768,          // CPU/memory cost (2^15)
  r: 8,
  p: 1,
  keylen: 32,        // derived key length (bytes) == digest length
  saltLen: 16,       // random salt length (bytes)
  maxmem: 67108864,  // 64 MiB — explicit; the 32 MiB default is exactly at the
                     // scrypt requirement (128*N*r*p) and would throw.
});
const CURRENT = V1;

const MAX_PIN_BYTES = 128; // technical guard only; numeric policy (6-8 digits) is B3/B6.

// ── helpers ──────────────────────────────────────────────────────────────────
function scryptAsync(pin, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, keylen, opts, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

// Valid PIN for B1: a non-empty string, at most 128 UTF-8 bytes (counted in
// bytes, not code points). Numeric/length policy is enforced later (B3/B6).
function isValidPin(pin) {
  return typeof pin === 'string' && pin.length > 0 && Buffer.byteLength(pin, 'utf8') <= MAX_PIN_BYTES;
}

// Strict decimal integer (no leading zero, positive, bounded length).
function strInt(s) {
  if (!/^[1-9][0-9]{0,9}$/.test(s)) throw new Error('bad int');
  return Number(s);
}

// Strict base64url decode: alphabet-only, exact byte length, canonical round-trip.
// Rejects padding, '+'/'/', ignored/invalid chars and non-canonical encodings.
function decodeExact(b64url, expectedLen) {
  if (typeof b64url !== 'string' || b64url.length === 0) throw new Error('empty b64');
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) throw new Error('non-b64url alphabet');
  const buf = Buffer.from(b64url, 'base64url');
  if (buf.length !== expectedLen) throw new Error('bad length');
  if (buf.toString('base64url') !== b64url) throw new Error('non-canonical');
  return buf;
}

// Parse a stored hash. Throws on ANY deviation. v1: only the exact V1 params.
// Decodes salt/digest first (cheap) and validates params WITHOUT invoking scrypt.
function parse(stored) {
  if (typeof stored !== 'string') throw new Error('stored not a string');
  const parts = stored.split('$');
  if (parts.length !== 7) throw new Error('bad segment count');
  const [scheme, vStr, nStr, rStr, pStr, saltB, hashB] = parts;
  if (scheme !== 'scrypt') throw new Error('bad scheme');
  if (vStr !== '1') throw new Error('unknown version');
  const N = strInt(nStr), r = strInt(rStr), p = strInt(pStr);
  const digest = decodeExact(hashB, V1.keylen); // exactly 32 bytes
  const salt = decodeExact(saltB, V1.saltLen);  // exactly 16 bytes
  if (N !== V1.N || r !== V1.r || p !== V1.p) throw new Error('params off policy');
  return { version: 1, N, r, p, keylen: digest.length, salt, digest };
}

// ── public API ───────────────────────────────────────────────────────────────
async function hashPin(pin) {
  if (!isValidPin(pin)) throw new Error('invalid pin input'); // generic; no PIN inside
  const salt = crypto.randomBytes(V1.saltLen);
  const dk = await scryptAsync(pin, salt, V1.keylen, { N: V1.N, r: V1.r, p: V1.p, maxmem: V1.maxmem });
  return `scrypt$1$${V1.N}$${V1.r}$${V1.p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

// Fail-closed: returns false for any invalid input; NEVER throws; NEVER logs.
async function verifyPin(pin, stored) {
  try {
    if (!isValidPin(pin)) return false;
    const rec = parse(stored); // throws for malformed / unknown version / off-policy params
    const dk = await scryptAsync(pin, rec.salt, rec.keylen, { N: rec.N, r: rec.r, p: rec.p, maxmem: V1.maxmem });
    if (dk.length !== rec.digest.length) return false; // guard before timingSafeEqual
    return crypto.timingSafeEqual(dk, rec.digest);
  } catch (_) {
    return false;
  }
}

function isValidFormat(stored) {
  try { parse(stored); return true; } catch (_) { return false; }
}

function needsRehash(stored) {
  try {
    const rec = parse(stored);
    return !(rec.version === V1.version && rec.N === V1.N && rec.r === V1.r
             && rec.p === V1.p && rec.keylen === V1.keylen);
  } catch (_) {
    return true; // malformed / unknown version / off-policy params → rehash needed
  }
}

module.exports = { hashPin, verifyPin, needsRehash, isValidFormat, CURRENT };
