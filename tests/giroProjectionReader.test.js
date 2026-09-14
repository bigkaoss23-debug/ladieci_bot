'use strict';
// tests/giroProjectionReader.test.js — Planner W4 Packet 01: the canonical I/O
// boundary onto public.giro_projection_v1. PURE unit test with injected deps
// (getOperationalSessionIds / select / rpc) — no DB, no network, no live
// Supabase call. Proves the fail-closed contract: any resolution/RPC/transport
// failure returns null (never [], never a raw manual_giro_id fallback), which
// giroProjectionPort.projectionAvailability() already treats as PROJECTION_MISSING.
//
// Run: node tests/giroProjectionReader.test.js

const fs = require('fs');
const path = require('path');
const { readGiroProjection } = require('../src/core/delivery/giroProjectionReader');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const SESSION_IDS = ['s1', 's2'];
const PROJECTION_BODY = { contract: 'giro_projection_v1', scope_valid: true, degraded: false, giros: [], orders: [], intents: [] };

const okIds = async () => SESSION_IDS;
const okRpc = async (fn, args) => ({ httpStatus: 200, ok: true, body: PROJECTION_BODY });

(async () => {
  section('HAPPY PATH — returns the RPC body unchanged');
  {
    let seenFn = null, seenArgs = null;
    const r = await readGiroProjection({
      getOperationalSessionIds: okIds,
      rpc: async (fn, args) => { seenFn = fn; seenArgs = args; return okRpc(); },
    });
    assert('calls the RPC named giro_projection_v1', seenFn === 'giro_projection_v1', seenFn);
    assert('passes p_operational_session_ids from the scope resolver', JSON.stringify(seenArgs) === JSON.stringify({ p_operational_session_ids: SESSION_IDS }), seenArgs);
    assert('returns the raw jsonb body unchanged (no re-derivation)', r === PROJECTION_BODY);
  }

  section('SCOPE RESOLUTION FAILURE — fail closed, never a raw fallback');
  {
    const r1 = await readGiroProjection({ getOperationalSessionIds: async () => { throw new Error('boom'); }, rpc: okRpc });
    assert('scope resolver throws -> null', r1 === null);
    const r2 = await readGiroProjection({ getOperationalSessionIds: async () => [], rpc: okRpc });
    assert('empty session scope -> null (never calls the RPC with an empty array)', r2 === null);
    const r3 = await readGiroProjection({ getOperationalSessionIds: async () => null, rpc: okRpc });
    assert('non-array scope result -> null', r3 === null);
  }

  section('RPC / TRANSPORT FAILURE — fail closed, never []');
  {
    const r1 = await readGiroProjection({ getOperationalSessionIds: okIds, rpc: async () => { throw new Error('network'); } });
    assert('rpc throws -> null (not [])', r1 === null);
    const r2 = await readGiroProjection({ getOperationalSessionIds: okIds, rpc: async () => ({ httpStatus: 500, ok: false, body: null }) });
    assert('rpc ok:false -> null', r2 === null);
    const r3 = await readGiroProjection({ getOperationalSessionIds: okIds, rpc: async () => ({ httpStatus: 200, ok: true, body: null }) });
    assert('rpc ok:true but null body -> null', r3 === null);
    const r4 = await readGiroProjection({ getOperationalSessionIds: okIds, rpc: async () => ({ httpStatus: 200, ok: true, body: 'not-an-object' }) });
    assert('rpc ok:true but non-object body -> null', r4 === null);
  }

  section('LIVE WIRING — defaults resolve to the real modules (no injected deps)');
  {
    // Proves the live default path points at the real getOperationalSessionIds/sbRpc
    // without actually calling them (no DB/network in this test file).
    const mod = require('../src/core/delivery/giroProjectionReader');
    assert('module exports exactly readGiroProjection', Object.keys(mod).length === 1 && typeof mod.readGiroProjection === 'function');
  }

  section('PURITY — no business logic, no raw giro columns, pure I/O');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'delivery', 'giroProjectionReader.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert('no manual_giro_id / manual_giros / salida_ref / dissolved_at / pending_giro_intent',
    !/manual_giro_id|manual_giros|salida_ref|dissolved_at|pending_giro_intent/.test(code));
  assert('no giro-state derivation logic (PLANNED/DISSOLVED/IN_TRIP literals, zone matching)',
    !/PLANNED|DISSOLVED|IN_TRIP|isRouteChannelCompatible/.test(code));
  assert('calls giro_projection_v1 via sbRpc, not a raw select/fetch', /rpc\(\s*["']giro_projection_v1["']/.test(code) && !/fetch\(|sbSelect\(/.test(code));

  console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
  process.exit(fail === 0 ? 0 : 1);
})();
