'use strict';
// H1A/H1B — Security Foundation Block: hardened server-side Supabase/PostgREST transport.
//
// This module is the ONLY place in the backend allowed to call `fetch()` against
// Supabase. It does not decide business logic, does not choose tables dynamically
// from a client request, and does not carry any authorization/role decision — those
// stay exactly where they are today (legacyAuthGuard.js / legacyActionRoles.js).
//
// Callers pass a structured, internal-only request descriptor (resource, method,
// already-validated query string, body, prefer, timeoutMs, operation). Nothing here
// accepts a full URL, arbitrary headers, a service key, or unvalidated PostgREST
// query text from outside this backend.
//
// Credential: reads the SAME server-side credential already used by the rest of the
// backend (SUPABASE_KEY, service_role — see src/utils/supabase.js / src/auth/audit.js
// prior to H1A). No publishable/anon key fallback exists anywhere in this file.
//
// H1B additionally enforces the resource registry (src/utils/supabaseResourcePolicy.js):
// only a registered {resource, method} pair may reach the network, structural request
// shape is validated before any fetch is attempted, and an explicit timeoutMs above a
// resource's own ceiling is rejected rather than silently clamped.

const {
  getResourcePolicy,
  isMethodAllowed,
  isTimeoutAllowed,
} = require('./supabaseResourcePolicy');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

const ERROR_CODES = Object.freeze({
  CONFIG: 'SUPABASE_CONFIGURATION_ERROR',
  TIMEOUT: 'SUPABASE_TIMEOUT',
  NETWORK: 'SUPABASE_NETWORK_ERROR',
  UPSTREAM: 'SUPABASE_UPSTREAM_ERROR',
  INVALID_RESPONSE: 'SUPABASE_INVALID_RESPONSE',
  RESOURCE_NOT_ALLOWED: 'SUPABASE_RESOURCE_NOT_ALLOWED',
  METHOD_NOT_ALLOWED: 'SUPABASE_METHOD_NOT_ALLOWED',
  TIMEOUT_NOT_ALLOWED: 'SUPABASE_TIMEOUT_NOT_ALLOWED',
  REQUEST_INVALID: 'SUPABASE_REQUEST_INVALID',
});

// Only these caller-supplied keys are ever read from params — anything else
// (headers, url, key, apikey, serviceKey, or any publishable/anon credential
// field) is rejected outright rather than silently ignored, so a typo or a
// future careless caller can never smuggle an arbitrary header or override
// the credential.
const ALLOWED_PARAM_KEYS = Object.freeze([
  'resource', 'method', 'query', 'body', 'prefer', 'timeoutMs',
  'operation', 'correlationId', 'silent',
]);

// Methods that never carry a body today (verified against every real call site
// in src/utils/supabase.js and src/auth/audit.js at H1B audit time — see
// tests/supabaseResourcePolicy.test.js #14).
const METHODS_WITHOUT_BODY = Object.freeze(['GET', 'DELETE']);

const OPERATION_NAME_RE = /^[A-Za-z0-9_:./-]{1,200}$/;

// S3 — Runtime-instrumented resource parity (MESA_REMEDIATION_PLAN_FINAL_V2_1_2_
// 2026-08-15.md, slice S3). Test-mode-only observation hook: when set, records
// the {resource, method} pair of EVERY request attempt that reaches this
// function, before the registry check below runs -- so a test can drive real
// DAO entrypoints (whatever local select()/rpc() convention they use; this
// hook fires regardless, since every DAO ultimately funnels through this one
// transport) and observe exactly what the registry needs to cover, instead of
// guessing from a source-text regex that can only recognize specific literal
// call patterns (sbSelect(...), sbRpc(...), etc.) and is blind to any DAO that
// defines its own local wrapper -- see tests/supabaseResourcePolicy.test.js's
// runtime-reachability check for the harness that uses this.
// Never wired to anything outside test files; production code never calls
// setTestModeRecorder, so this is a no-op (_testModeRecorder stays null) on
// every real request path.
let _testModeRecorder = null;
function setTestModeRecorder(fn) {
  _testModeRecorder = typeof fn === 'function' ? fn : null;
}

function validateRequestShape(params) {
  const badKeys = Object.keys(params).filter((k) => !ALLOWED_PARAM_KEYS.includes(k));
  if (badKeys.length > 0) {
    throw new SupabaseTransportError(ERROR_CODES.REQUEST_INVALID, 'unexpected request parameter');
  }

  const { resource, method = 'GET', query, body, timeoutMs, operation } = params;

  if (typeof resource !== 'string' || resource.length === 0) {
    throw new SupabaseTransportError(ERROR_CODES.REQUEST_INVALID, 'resource is required');
  }
  if (_testModeRecorder) {
    try { _testModeRecorder({ resource, method: String(method).toUpperCase() }); } catch (_) { /* never let a recorder bug break a real request */ }
  }
  // Absolute URL, protocol-relative, path traversal, duplicated "?", fragment,
  // CR/LF (header/response-splitting defense in depth) — resource must be a bare
  // PostgREST path segment like "ordenes" or "rpc/start_rider_trip", never a URL.
  if (
    resource.includes('://') ||
    resource.startsWith('/') ||
    resource.includes('..') ||
    resource.includes('?') ||
    resource.includes('#') ||
    /[\r\n]/.test(resource)
  ) {
    throw new SupabaseTransportError(ERROR_CODES.REQUEST_INVALID, 'resource is not a valid PostgREST path segment');
  }

  if (query !== undefined) {
    if (typeof query !== 'string') {
      throw new SupabaseTransportError(ERROR_CODES.REQUEST_INVALID, 'query must be a string');
    }
    if (query.includes('?') || query.includes('#') || /[\r\n]/.test(query)) {
      throw new SupabaseTransportError(ERROR_CODES.REQUEST_INVALID, 'query is not a valid PostgREST query string');
    }
  }

  const httpMethod = String(method).toUpperCase();
  if (body !== undefined && METHODS_WITHOUT_BODY.includes(httpMethod)) {
    throw new SupabaseTransportError(ERROR_CODES.REQUEST_INVALID, `${httpMethod} does not accept a body`);
  }

  if (operation !== undefined && !OPERATION_NAME_RE.test(String(operation))) {
    throw new SupabaseTransportError(ERROR_CODES.REQUEST_INVALID, 'operation name is not valid');
  }

  // ── resource policy enforcement (H1B) ──
  const policy = getResourcePolicy(resource);
  if (!policy) {
    throw new SupabaseTransportError(ERROR_CODES.RESOURCE_NOT_ALLOWED, 'resource is not registered');
  }
  if (!isMethodAllowed(resource, httpMethod)) {
    throw new SupabaseTransportError(ERROR_CODES.METHOD_NOT_ALLOWED, 'method is not allowed for this resource');
  }
  // Only an EXPLICITLY requested timeout is checked against the resource's own
  // ceiling — omitting timeoutMs (every real call site today) always uses the
  // resource's default and can never hit this branch.
  if (timeoutMs !== undefined && !isTimeoutAllowed(resource, timeoutMs)) {
    throw new SupabaseTransportError(ERROR_CODES.TIMEOUT_NOT_ALLOWED, 'requested timeout exceeds the resource ceiling');
  }

  return { policy, httpMethod };
}

class SupabaseTransportError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SupabaseTransportError';
    this.code = code;
  }
}

// Only these two extra headers are ever allowed through — never an arbitrary
// caller-supplied header object, never Authorization/apikey from a caller (those
// are always derived here from the server-side credential, never overridable).
const ALLOWED_EXTRA_HEADERS = Object.freeze(['Content-Type', 'Prefer']);

function loadConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (typeof url !== 'string' || url.length === 0 || typeof key !== 'string' || key.length === 0) {
    throw new SupabaseTransportError(ERROR_CODES.CONFIG, 'supabase transport not configured');
  }
  return { url, key };
}

function buildHeaders(key, prefer, hasBody) {
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  return headers;
}

// Logging is intentionally minimal and structural — never the request/response
// body, never the query string (it may carry telefono/wa_id/fecha filters), never
// headers, never a URL (it would carry SUPABASE_URL + the resource path). Only
// shape/outcome/timing, matching the discipline already used in orderStateLogger.js
// and src/auth/audit.js's PII scrubbing for auth_audit.meta.
function logResult({ operation, resource, method, status, durationMs, timedOut, errorCode, correlationId }) {
  const line = {
    at: 'supabaseTransport',
    operation: operation || 'unknown',
    resource: typeof resource === 'string' ? resource.split('?')[0] : 'unknown',
    method,
    status: status === undefined ? null : status,
    durationMs,
    timedOut: !!timedOut,
    errorCode: errorCode || null,
  };
  if (correlationId) line.correlationId = correlationId;
  if (errorCode) {
    console.warn('[supabaseTransport]', JSON.stringify(line));
  } else {
    console.log('[supabaseTransport]', JSON.stringify(line));
  }
}

// supabaseRequest(params) -> { ok, status, text, body, bodyIsJson }
//
// params:
//   resource     REQUIRED string — PostgREST path after /rest/v1/, e.g. "ordenes"
//                or "rpc/start_rider_trip". Never accepted from an HTTP request
//                body/query verbatim by design — callers pass a literal or a value
//                already validated against a closed allow-list upstream.
//   method       default "GET"
//   query        OPTIONAL already-built/validated query string (no leading "?")
//   body         OPTIONAL plain JS value, JSON-serialized here
//   prefer       OPTIONAL PostgREST Prefer header value
//   timeoutMs    OPTIONAL, default DEFAULT_TIMEOUT_MS, clamped to MAX_TIMEOUT_MS
//   operation    OPTIONAL string name used only for logging/error correlation
//   correlationId OPTIONAL string, logged if present, never required
//   silent       OPTIONAL boolean, default false. Some pre-existing domains (the
//                PIN/session auth domain behind src/auth/audit.js) have a
//                deliberate, tested zero-console-output contract that predates
//                H1A. Passing silent:true suppresses logResult() entirely for
//                that call, preserving that contract; every other domain keeps
//                the new structured operation/resource/status/duration logging
//                by default.
//
// Throws SupabaseTransportError with one of ERROR_CODES on:
//   - missing/empty config (CONFIG)
//   - abort due to timeout (TIMEOUT)
//   - any other fetch-level failure, e.g. DNS/connection (NETWORK)
// Never throws on a non-2xx HTTP response — that is reported via `ok`/`status`,
// exactly like the pre-H1A helpers this replaces (callers decide what a non-2xx
// status means for their own contract).
async function supabaseRequest(params = {}) {
  const { policy, httpMethod: validatedMethod } = validateRequestShape(params);
  const {
    resource,
    query,
    body,
    prefer,
    timeoutMs,
    operation,
    correlationId,
    silent = false,
  } = params;
  const emit = silent ? () => {} : logResult;

  const { url: base, key } = loadConfig();

  const requestedTimeout = timeoutMs !== undefined ? Number(timeoutMs) : policy.defaultTimeoutMs;
  const effectiveTimeout = Math.min(
    Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_TIMEOUT_MS),
    policy.maxTimeoutMs
  );

  let url = `${base}/rest/v1/${resource}`;
  if (query) url += '?' + query;

  const hasBody = body !== undefined;
  const headers = buildHeaders(key, prefer, hasBody);
  const httpMethod = validatedMethod;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(url, {
      method: httpMethod,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err && err.name === 'AbortError') {
      emit({ operation, resource, method: httpMethod, status: undefined, durationMs, timedOut: true, errorCode: ERROR_CODES.TIMEOUT, correlationId });
      throw new SupabaseTransportError(ERROR_CODES.TIMEOUT, 'supabase request timed out');
    }
    emit({ operation, resource, method: httpMethod, status: undefined, durationMs, timedOut: false, errorCode: ERROR_CODES.NETWORK, correlationId });
    throw new SupabaseTransportError(ERROR_CODES.NETWORK, 'supabase request failed');
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;

  let text;
  try {
    text = await res.text();
  } catch (_) {
    emit({ operation, resource, method: httpMethod, status: res.status, durationMs, timedOut: false, errorCode: ERROR_CODES.INVALID_RESPONSE, correlationId });
    throw new SupabaseTransportError(ERROR_CODES.INVALID_RESPONSE, 'supabase response could not be read');
  }

  let bodyIsJson = false;
  let parsed;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
      bodyIsJson = true;
    } catch (_) {
      bodyIsJson = false;
    }
  }

  emit({
    operation, resource, method: httpMethod, status: res.status, durationMs, timedOut: false,
    errorCode: res.ok ? null : ERROR_CODES.UPSTREAM, correlationId,
  });

  return { ok: res.ok, status: res.status, text, body: bodyIsJson ? parsed : undefined, bodyIsJson };
}

module.exports = {
  supabaseRequest,
  SupabaseTransportError,
  ERROR_CODES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  ALLOWED_EXTRA_HEADERS,
  // S3 — test-mode-only resource-reachability recorder. Never called by any
  // production wrapper; see the comment at its definition above.
  setTestModeRecorder,
  // exported for tests only — not used by production wrappers
  _internal: { loadConfig, buildHeaders },
};
