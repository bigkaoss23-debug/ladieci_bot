'use strict';
// Access Control V3 -- Block V3-H.2: locks the corrected canonical CORS policy in
// index.js (adds Authorization to Access-Control-Allow-Headers and PATCH/PUT/DELETE to
// Access-Control-Allow-Methods, for the nine V3 access-management routes) without
// weakening any pre-existing legacy behavior. Drives the REAL index.js app via
// in-memory HTTP injection (same technique as financialHttpIntegration.test.js) --
// NO network port, NO DB.
// Run: node tests/corsAuthorizationHeaderV3H2.test.js

process.env.AUTH_V3_ACCESS_MANAGEMENT_HTTP_ENABLED = 'true';
process.env.AUTH_JWT_SECRET_B64URL = require('crypto').randomBytes(32).toString('base64url');

const http = require('http');
const { Socket } = require('net');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { app } = require('../index.js');

function inject(method, url, headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = new http.IncomingMessage(new Socket());
    req.method = method; req.url = url; req.headers = {};
    for (const k of Object.keys(headers)) req.headers[k.toLowerCase()] = headers[k];
    if (body != null && req.headers['content-length'] === undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (c) => { if (c) chunks.push(Buffer.from(c)); return true; };
    res.end = (c) => { if (c) chunks.push(Buffer.from(c)); const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) { /* non-json */ } resolve({ status: res.statusCode, headers: res.getHeaders ? res.getHeaders() : res._headers || {}, text, json }); };
    app(req, res);
    if (body != null) req.push(Buffer.from(body));
    req.push(null);
  });
}

(async () => {
  // ═══ PRE-EXISTING BEHAVIOR PRESERVED ═══
  {
    const r = await inject('OPTIONS', '/api/auth/v3/access-users', {
      origin: 'https://ladieci-v1-staging.netlify.app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type, x-api-key',
    });
    const allowHeaders = String(r.headers['access-control-allow-headers'] || '');
    assert('Content-Type remains an allowed request header', /content-type/i.test(allowHeaders));
    assert('X-Api-Key remains an allowed request header', /x-api-key/i.test(allowHeaders));
  }
  {
    const r = await inject('GET', '/health');
    assert('health endpoint unchanged (200, ok:true)', r.status === 200 && r.json && r.json.ok === true);
  }
  {
    // legacy /api dispatcher (single POST endpoint) still reachable/unaffected.
    const r = await inject('OPTIONS', '/api', { origin: 'https://ladieci-v1-staging.netlify.app' });
    assert('legacy /api OPTIONS still returns 204 without reaching business logic', r.status === 204);
  }
  {
    const r = await inject('OPTIONS', '/api/auth/v3/access-users', { origin: 'https://ladieci-v1-staging.netlify.app', 'access-control-request-method': 'GET' });
    assert('OPTIONS never reaches the V3 auth/business middleware (no ok/code field, no 401 body)', r.status === 204 && r.text === '');
  }

  // ═══ AUTHORIZATION HEADER NOW ALLOWED ═══
  {
    const r = await inject('OPTIONS', '/api/auth/v3/access-users', {
      origin: 'https://ladieci-v1-staging.netlify.app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    });
    const allowHeaders = String(r.headers['access-control-allow-headers'] || '');
    assert('Authorization is present in Access-Control-Allow-Headers (case-insensitive)', /authorization/i.test(allowHeaders));
    assert('GET preflight succeeds (204)', r.status === 204);
    const allowMethods = String(r.headers['access-control-allow-methods'] || '');
    assert('GET present in Access-Control-Allow-Methods', /\bGET\b/.test(allowMethods));
  }
  // Browsers send whatever case the app requested; the response allow-list is what
  // actually gates the real request -- prove a mixed-case request header is still
  // answered by the same (case-insensitive-matched) allow-list.
  {
    const r = await inject('OPTIONS', '/api/auth/v3/access-users', {
      origin: 'https://ladieci-v1-staging.netlify.app',
      'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'Authorization, Content-Type',
    });
    const allowHeaders = String(r.headers['access-control-allow-headers'] || '');
    assert('mixed-case requested header list still answered with Authorization present', /authorization/i.test(allowHeaders) && r.status === 204);
  }
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const r = await inject('OPTIONS', '/api/auth/v3/access-users/dyn_actor/role', {
      origin: 'https://ladieci-v1-staging.netlify.app',
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization, content-type',
    });
    const allowMethods = String(r.headers['access-control-allow-methods'] || '');
    assert(`${method} preflight succeeds and ${method} is present in Access-Control-Allow-Methods`, r.status === 204 && new RegExp(`\\b${method}\\b`).test(allowMethods));
  }
  {
    // A disallowed/unrelated internal header must NOT be silently echoed/expanded --
    // the response allow-list stays the fixed canonical string, not a reflection of
    // whatever was requested.
    const r = await inject('OPTIONS', '/api/auth/v3/access-users', {
      origin: 'https://ladieci-v1-staging.netlify.app',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-some-random-internal-header',
    });
    const allowHeaders = String(r.headers['access-control-allow-headers'] || '');
    assert('unrelated requested header is not silently added to the allow-list', !/x-some-random-internal-header/i.test(allowHeaders));
    assert('allow-list is still exactly the canonical 3-header set', allowHeaders === 'Content-Type, X-Api-Key, Authorization');
  }

  // ═══ ORIGIN SAFETY ═══
  {
    const r1 = await inject('OPTIONS', '/api/auth/v3/access-users', { origin: 'https://ladieci-v1-staging.netlify.app', 'access-control-request-method': 'GET' });
    assert('accepted staging origin gets Access-Control-Allow-Origin', r1.headers['access-control-allow-origin'] === '*');
    const r2 = await inject('OPTIONS', '/api/auth/v3/access-users', { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' });
    assert('an unknown origin receives the SAME policy as before (wildcard, unchanged) -- no broader/narrower grant introduced', r2.headers['access-control-allow-origin'] === '*' && r2.status === 204);
  }
  {
    const r = await inject('OPTIONS', '/api/auth/v3/access-users', { origin: 'https://ladieci-v1-staging.netlify.app', 'access-control-request-method': 'GET' });
    assert('Access-Control-Allow-Credentials is never set (bearer-token transport does not need browser credential mode; static wildcard + credentials would be unsafe)', r.headers['access-control-allow-credentials'] === undefined);
    // Vary: Origin is deliberately NOT required here: the response is a STATIC wildcard
    // ('*'), not an echoed/reflected origin -- the response body never varies by Origin,
    // so adding Vary: Origin would be inaccurate, not a safety improvement.
    assert('origin policy remains the pre-existing static wildcard (not a per-origin reflection)', r.headers['access-control-allow-origin'] === '*');
  }

  // ═══ V3 AUTH UNCHANGED BY THE CORS FIX ═══
  {
    const r = await inject('GET', '/api/auth/v3/access-users');
    assert('unauthenticated actual GET still returns 401 AUTH_UNAUTHENTICATED', r.status === 401 && r.json && r.json.code === 'AUTH_UNAUTHENTICATED');
  }
  {
    const r = await inject('GET', '/api/auth/v3/access-users', { authorization: 'Bearer not-a-real-token' });
    assert('malformed bearer still safely rejected (401 AUTH_UNAUTHENTICATED, CORS change does not bypass auth)', r.status === 401 && r.json && r.json.code === 'AUTH_UNAUTHENTICATED');
  }
  {
    const r = await inject('GET', '/api/auth/v3/access-users', { authorization: 'Bearer not-a-real-token' });
    assert('no staff data returned without valid authorization', !r.json || !Array.isArray(r.json.users));
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
