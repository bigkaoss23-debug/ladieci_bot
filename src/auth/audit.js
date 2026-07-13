'use strict';
// Access Control V2 — Block B2: auth audit writer/reader + meta sanitization +
// a small self-contained REST helper (sbRest) shared with dao.js.
// service_role only (backend). auth_audit is append-only BY CONTRACT: this
// module exposes NO update/delete. Never logs. Never prints secrets.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

class AuthDaoError extends Error {
  constructor(code, message) { super(message || code); this.name = 'AuthDaoError'; this.code = code; }
}

// ── minimal REST helper (does NOT force select=*; returns {ok,status,body}) ───
async function sbRest(method, resource, { query, body, prefer } = {}) {
  const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers['Prefer'] = prefer;
  let url = `${SUPABASE_URL}/rest/v1/${resource}`;
  if (query) url += '?' + query;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (_) {
    return { ok: false, status: 0, body: null };
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  return { ok: res.ok, status: res.status, body: parsed };
}

const ALLOWED_EVENTS = Object.freeze([
  'login_ok', 'login_fail', 'locked', 'pin_set', 'pin_change', 'revoke', 'bootstrap', 'recovery',
]);

// Sensitive keys in NORMALIZED form: lowercased, separators (_ - space) removed.
// 'auth_method' → 'authmethod' (allowed). 'authorization' → blocked. The generic
// key 'auth' is NOT banned.
const SENSITIVE_NORMALIZED = Object.freeze(new Set([
  'pin', 'password', 'token', 'accesstoken', 'refreshtoken', 'jwt', 'secret',
  'recoverysecret', 'authorization', 'apikey', 'bearer', 'cookie',
]));

const LIMITS = Object.freeze({ maxDepth: 4, maxKeys: 32, maxBytes: 2048 });

function normalizeKey(k) { return String(k).toLowerCase().replace(/[_\-\s]/g, ''); }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Deep-validate meta. Throws AuthDaoError('VALIDATION') on any violation.
// Returns the meta unchanged when clean (reject, not strip).
function sanitizeMeta(meta) {
  if (meta === undefined || meta === null) return {};
  if (!isPlainObject(meta)) throw new AuthDaoError('VALIDATION', 'meta must be a plain object');
  let keyCount = 0;
  const walk = (node, depth) => {
    if (depth > LIMITS.maxDepth) throw new AuthDaoError('VALIDATION', 'meta too deep');
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        keyCount++;
        if (keyCount > LIMITS.maxKeys) throw new AuthDaoError('VALIDATION', 'meta too many keys');
        if (SENSITIVE_NORMALIZED.has(normalizeKey(key))) throw new AuthDaoError('VALIDATION', 'meta sensitive key');
        walk(node[key], depth + 1);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else {
      const t = typeof node;
      if (!(t === 'string' || t === 'number' || t === 'boolean' || node === null)) {
        throw new AuthDaoError('VALIDATION', 'meta non-JSON value');
      }
      if (t === 'number' && !Number.isFinite(node)) throw new AuthDaoError('VALIDATION', 'meta non-finite number');
    }
  };
  walk(meta, 1);
  let serialized;
  try { serialized = JSON.stringify(meta); } catch (_) { throw new AuthDaoError('VALIDATION', 'meta not serializable'); }
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.maxBytes) throw new AuthDaoError('VALIDATION', 'meta too large');
  return meta;
}

function assertEvent(event) {
  if (!ALLOWED_EVENTS.includes(event)) throw new AuthDaoError('VALIDATION', 'event not allowed');
}

// Append-only insert. Throws AuthDaoError on invalid input / DB failure.
async function writeAuthAudit({ event, targetActor = null, byActor = null, ipHash = null, meta = {} } = {}) {
  assertEvent(event);
  const clean = sanitizeMeta(meta);
  const r = await sbRest('POST', 'auth_audit', {
    body: { event, target_actor: targetActor, by_actor: byActor, ip_hash: ipHash, meta: clean },
    prefer: 'return=minimal',
  });
  if (!r.ok) throw new AuthDaoError('DB_ERROR', 'audit write failed');
  return { ok: true };
}

// In-memory diagnostic counter (NON-persistent, reset on boot). Best-effort
// audit failures are swallowed and counted here so B3 can expose an aggregate.
let _auditWriteErrors = 0;
function getAuditWriteErrorCount() { return _auditWriteErrors; }

async function writeAuthAuditBestEffort(rec) {
  try { return await writeAuthAudit(rec); }
  catch (_) { _auditWriteErrors++; return { ok: false }; }
}

// Stable cursor pagination: order ts DESC, id DESC. Optional before = {ts, id}.
async function listAuthAudit({ limit = 50, before = null, actor = null } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const parts = ['select=id,ts,event,target_actor,by_actor,ip_hash,meta', 'order=ts.desc,id.desc', `limit=${lim}`];
  if (actor) parts.push(`target_actor=eq.${encodeURIComponent(actor)}`);
  if (before && before.ts != null && before.id != null) {
    const ts = encodeURIComponent(before.ts);
    parts.push(`or=(ts.lt.${ts},and(ts.eq.${ts},id.lt.${Number(before.id)}))`);
  }
  const r = await sbRest('GET', 'auth_audit', { query: parts.join('&') });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('DB_ERROR', 'audit read failed');
  return r.body;
}

module.exports = {
  AuthDaoError, ALLOWED_EVENTS, sbRest, sanitizeMeta,
  writeAuthAudit, writeAuthAuditBestEffort, getAuditWriteErrorCount, listAuthAudit,
};
