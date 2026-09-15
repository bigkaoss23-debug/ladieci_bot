'use strict';
// W6.0 — Giro Projection Transport Restoration (standalone hotfix regression).
//
// Proves the REAL transport/policy chain for the canonical Giro Authority
// projection read boundary (core/delivery/giroProjectionReader.js), not just
// a source-text grep: readGiroProjection() calls the injected `rpc` alias
// (default sbRpc), which funnels through supabaseTransport's H1B resource
// registry gate (src/utils/supabaseResourcePolicy.js). Before this hotfix,
// rpc/giro_projection_v1 was absent from that registry, so every real Node
// call failed closed with SUPABASE_RESOURCE_NOT_ALLOWED before any network
// request — degrading every canonical consumer (riderReads.js,
// manualGiroReads.js) to PROJECTION_MISSING even though the DB function
// itself (migration 130, Planner W3) was live and healthy.
//
// Run: node tests/giroProjectionTransportReachability.test.js
// OFFLINE: global.fetch is stubbed — no network, no DB.

const path = require('path');

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role-giro-projection';

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
};
async function captureErr(fn) { try { await fn(); return null; } catch (e) { return e; } }

delete require.cache[require.resolve('../src/utils/supabaseResourcePolicy')];
delete require.cache[require.resolve('../src/utils/supabaseTransport')];
delete require.cache[require.resolve('../src/core/delivery/giroProjectionReader')];
const policy = require('../src/utils/supabaseResourcePolicy');
const transport = require('../src/utils/supabaseTransport');
const { readGiroProjection } = require('../src/core/delivery/giroProjectionReader');

const RESOURCE = 'rpc/giro_projection_v1';

// A real read-only probe of public.giro_projection_v1 on staging (2026-09-15,
// business_date 2026-09-12) returned exactly this shape — used here as the
// realistic success-path fixture, not invented.
const REAL_PROJECTION_SHAPE = Object.freeze({
  scope_valid: true,
  degraded: false,
  trip_facts_available: true,
  giros: [],
  orders: [],
  intents: [],
  reasons: [],
});

let fetchCalls = [];
function installFetchStub(handler) {
  fetchCalls = [];
  global.fetch = async (url, init) => {
    const call = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body };
    fetchCalls.push(call);
    return handler(call);
  };
}
function uninstallFetchStub() { delete global.fetch; }

(async () => {
  // ── 1) resource policy shape ─────────────────────────────────────────────
  {
    const p = policy.getResourcePolicy(RESOURCE);
    assert('1. getResourcePolicy(rpc/giro_projection_v1) exists', p !== null);
    assert('2. kind === KIND.RPC', !!p && p.kind === policy.KIND.RPC);
    assert('3. allowedMethods is exactly ["POST"]', !!p && p.allowedMethods.length === 1 && p.allowedMethods[0] === 'POST');
    assert('4. sensitivity === INTERNAL_OPERATIONAL', !!p && p.sensitivity === policy.SENSITIVITY.INTERNAL_OPERATIONAL);
  }

  // ── 2) GET is denied ──────────────────────────────────────────────────────
  {
    installFetchStub(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    const err = await captureErr(() => transport.supabaseRequest({ resource: RESOURCE, method: 'GET', operation: 'test' }));
    assert('5. GET is denied by the transport (METHOD_NOT_ALLOWED)',
      err && err.code === transport.ERROR_CODES.METHOD_NOT_ALLOWED);
    assert('5b. the denied GET never reached fetch (fail-closed before any network call)', fetchCalls.length === 0);
    uninstallFetchStub();
  }

  // ── 3) readGiroProjection: real success path through the real transport/policy gate ──
  {
    installFetchStub(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(REAL_PROJECTION_SHAPE) }));
    const result = await readGiroProjection({ getOperationalSessionIds: async () => ['mock-session-1'] });
    assert('6. readGiroProjection() with a valid injected scope reaches the real sbRpc/transport gate and does not throw',
      result !== undefined);
    assert('7. exactly one fetch call was made', fetchCalls.length === 1);
    assert('8. the call targeted exactly rpc/giro_projection_v1 (POST, /rest/v1/rpc/ path, no other segment)',
      fetchCalls[0] && fetchCalls[0].method === 'POST' && fetchCalls[0].url === 'http://mock.local/rest/v1/rpc/giro_projection_v1');
    assert('9. transport success returns the projection body unchanged (pure I/O, no re-derivation)',
      JSON.stringify(result) === JSON.stringify(REAL_PROJECTION_SHAPE));
    uninstallFetchStub();
  }

  // ── 4) transport/resource failure still fails closed to null ────────────
  {
    // 4a — upstream HTTP failure (non-2xx / non-JSON body -> sbRpc's ok:false)
    installFetchStub(async () => ({ ok: false, status: 500, text: async () => 'internal error' }));
    const result = await readGiroProjection({ getOperationalSessionIds: async () => ['mock-session-1'] });
    assert('10. an upstream transport failure (HTTP 500) makes readGiroProjection return null, never a partial/guessed body',
      result === null);
    uninstallFetchStub();
  }
  {
    // 4b — the rpc() call itself throwing (exactly the SupabaseTransportError
    // shape the real transport raises for a rejected/unregistered resource —
    // the pre-fix W6.0 regression) is caught by readGiroProjection's own
    // fail-closed catch, never surfaced to the caller. `rpc` is one of
    // readGiroProjection's real injectable dependencies (default sbRpc);
    // overriding it targets that exact catch branch directly, without
    // needing to defeat the module-identity destructured-import bindings
    // chained across supabaseResourcePolicy -> supabaseTransport ->
    // supabase.js -> giroProjectionReader.js (each captures its dependency
    // by value at its own require() time, so mutating the policy module's
    // exported function after the fact would not reach any of them).
    const thrown = new transport.SupabaseTransportError(transport.ERROR_CODES.RESOURCE_NOT_ALLOWED, 'resource is not registered');
    const result = await readGiroProjection({
      getOperationalSessionIds: async () => ['mock-session-1'],
      rpc: async () => { throw thrown; },
    });
    assert('11. a thrown SupabaseTransportError from rpc() (RESOURCE_NOT_ALLOWED — exactly what an unregistered resource raises) is caught and returns null, never surfaced to the caller',
      result === null);
  }

  // ── 5) empty/unavailable scope still returns null ────────────────────────
  {
    installFetchStub(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(REAL_PROJECTION_SHAPE) }));
    const resultEmpty = await readGiroProjection({ getOperationalSessionIds: async () => [] });
    assert('12. an empty operational scope returns null without ever calling the RPC', resultEmpty === null && fetchCalls.length === 0);
    const resultThrow = await readGiroProjection({ getOperationalSessionIds: async () => { throw new Error('scope_unavailable'); } });
    assert('13. a scope-resolution failure returns null without ever calling the RPC', resultThrow === null && fetchCalls.length === 0);
    uninstallFetchStub();
  }

  // ── 6) no raw Giro fallback is introduced ────────────────────────────────
  {
    const fs = require('fs');
    const readerSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'delivery', 'giroProjectionReader.js'), 'utf8'
    );
    // Strip comments first — the module's own header comment names these
    // fields to DISCLAIM reading them ("never a raw ordenes.manual_giro_id /
    // manual_giros / ... fallback. This module reads none of those."), so a
    // naive substring search over the raw source would false-positive on the
    // very sentence proving the invariant holds.
    const readerCode = readerSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const forbidden = ['manual_giro_id', 'manual_giros', 'salida_ref', 'dissolved_at'];
    const present = forbidden.filter((token) => readerCode.includes(token));
    assert('14. giroProjectionReader.js reads none of the raw Giro fallback fields/tables (manual_giro_id, manual_giros, salida_ref, dissolved_at)',
      present.length === 0, present.join(', '));

    installFetchStub(async () => ({ ok: false, status: 500, text: async () => 'internal error' }));
    const result = await readGiroProjection({ getOperationalSessionIds: async () => ['mock-session-1'] });
    assert('15. on failure the return value is exactly null (no synthesized empty-giros object standing in for the real projection)',
      result === null);
    uninstallFetchStub();
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FATAL  ' + (e && e.stack || e));
  uninstallFetchStub();
  process.exit(1);
});
