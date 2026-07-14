'use strict';
// Access Control V2 — Block B3: IP normalization, HMAC ip_hash, and a secondary
// in-memory rate limiter. node:crypto only. No plaintext IP is ever logged or
// returned. HMAC (not plain SHA-256) prevents enumeration of common IPs.
// Secret from AUTH_IP_HASH_SECRET_B64URL (canonical base64url, ≥32 bytes). If
// missing/invalid → ip hashing + limiter are DISABLED (fail-open for IP only);
// the DB actor lock (B2) remains the authoritative defense.

const crypto = require('crypto');

const IP_HASH_HEX_LEN = 32; // 128-bit truncation (documented)

function b64urlDecodeStrict(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (buf.length === 0 || buf.toString('base64url') !== s) return null;
  return buf;
}
function loadSecret() {
  const buf = b64urlDecodeStrict(process.env.AUTH_IP_HASH_SECRET_B64URL || '');
  if (!buf || buf.length < 32) return null;
  return buf;
}
const IP_SECRET = loadSecret();
function isIpHashEnabled() { return IP_SECRET !== null; }

// Normalize IPv4 / IPv6 / IPv4-mapped; strip brackets, port, zone id. Returns
// the canonical-ish string or null.
function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  let s = ip.trim().toLowerCase();
  if (!s) return null;
  // bracketed IPv6 with optional port: [::1]:443
  const br = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (br) s = br[1];
  // strip IPv6 zone id
  s = s.replace(/%[^%]*$/, '');
  // IPv4-mapped IPv6 → IPv4
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) s = mapped[1];
  // bare IPv4 with port a.b.c.d:port
  const v4p = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4p) s = v4p[1];
  return s || null;
}

// HMAC-SHA256(secret, normalizedIp) truncated. Returns null if disabled or bad IP.
function ipHash(ip) {
  if (!IP_SECRET) return null;
  const norm = normalizeIp(ip);
  if (!norm) return null;
  return crypto.createHmac('sha256', IP_SECRET).update(norm).digest('hex').slice(0, IP_HASH_HEX_LEN);
}

// Secondary in-memory limiter, keyed by ip_hash. NOT primary security.
// Limits: resets on process restart; per-instance (multi-instance → effective
// limit multiplies by the number of instances). Documented; do not rely on it.
function createIpLimiter({ maxFails = 20, windowMs = 10 * 60 * 1000, blockMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // ipHash → { count, windowStart, blockedUntil }

  function check(h) {
    if (!h) return { blocked: false, retryAfterSec: 0 };
    const e = map.get(h);
    const t = now();
    if (e && e.blockedUntil && t < e.blockedUntil) {
      return { blocked: true, retryAfterSec: Math.ceil((e.blockedUntil - t) / 1000) };
    }
    return { blocked: false, retryAfterSec: 0 };
  }

  function recordFailure(h) {
    if (!h) return;
    const t = now();
    let e = map.get(h);
    if (!e || (t - e.windowStart) > windowMs) e = { count: 0, windowStart: t, blockedUntil: 0 };
    e.count += 1;
    if (e.count >= maxFails) { e.blockedUntil = t + blockMs; }
    map.set(h, e);
  }

  function reset(h) { if (h) map.delete(h); }
  function _size() { return map.size; }

  return { check, recordFailure, reset, _size };
}

module.exports = { normalizeIp, ipHash, isIpHashEnabled, createIpLimiter, IP_HASH_HEX_LEN };
