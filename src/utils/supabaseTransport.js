'use strict';
// H1A — Security Foundation Block: hardened server-side Supabase/PostgREST transport.
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

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

const ERROR_CODES = Object.freeze({
  CONFIG: 'SUPABASE_CONFIGURATION_ERROR',
  TIMEOUT: 'SUPABASE_TIMEOUT',
  NETWORK: 'SUPABASE_NETWORK_ERROR',
  UPSTREAM: 'SUPABASE_UPSTREAM_ERROR',
  INVALID_RESPONSE: 'SUPABASE_INVALID_RESPONSE',
});

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
  const {
    resource,
    method = 'GET',
    query,
    body,
    prefer,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    operation,
    correlationId,
    silent = false,
  } = params;
  const emit = silent ? () => {} : logResult;

  if (typeof resource !== 'string' || resource.length === 0) {
    throw new SupabaseTransportError(ERROR_CODES.CONFIG, 'resource is required');
  }

  const { url: base, key } = loadConfig();

  const effectiveTimeout = Math.min(
    Math.max(1, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS
  );

  let url = `${base}/rest/v1/${resource}`;
  if (query) url += '?' + query;

  const hasBody = body !== undefined;
  const headers = buildHeaders(key, prefer, hasBody);
  const httpMethod = String(method).toUpperCase();

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
  // exported for tests only — not used by production wrappers
  _internal: { loadConfig, buildHeaders },
};
