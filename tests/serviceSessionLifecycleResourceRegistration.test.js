'use strict';
// ===============================================================
// Every RPC the service-session lifecycle wrapper can call MUST be registered
// in the transport resource policy.
//
// WHY THIS EXISTS. src/utils/supabaseTransport.js enforces the registry
// BEFORE the network:
//
//     const policy = getResourcePolicy(resource);
//     if (!policy) throw new SupabaseTransportError(RESOURCE_NOT_ALLOWED, ...);
//
// So an unregistered RPC does not fail at the database, or slowly, or with a
// useful message -- it throws synchronously, no request is ever made, no
// transport log line is emitted, and whatever wraps the call turns it into a
// generic 500. From the outside it looks like an internal error with no cause.
//
// THIS IS NOT HYPOTHETICAL. rpc/resolve_order_intake_context_v1 was
// deliberately left out of the registry, with a comment asserting it was only
// ever called from inside the service_session_assign_order() DB trigger. The
// Mesa first-seating stale-service guard (ledger 95) then gave it a JS caller
// -- serviceSessionLifecycle.js's resolveOperationalContext() -- and nothing
// noticed, because that caller only ran on the forgotten-close recovery-retry
// path, which never executed in production. G-1 (ledger 96) made the same
// call the normal route for the first table seating after a Finalizar, and it
// failed on the very first real attempt with MESA_INTERNAL_ERROR.
//
// A unit test could not have caught it: every Mesa test injects a stubbed
// lifecycle, so the real transport is never reached. This test closes the gap
// at the only place both facts are visible -- the wrapper's source and the
// registry -- and it is deliberately source-driven so a NEW rpc() call added
// to the wrapper is covered the day it is written, without anyone remembering
// to extend a hand-maintained list.
//
// Run: node --test tests/serviceSessionLifecycleResourceRegistration.test.js
// ===============================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { getResourcePolicy, isMethodAllowed } = require('../src/utils/supabaseResourcePolicy');

const WRAPPER = path.join(__dirname, '..', 'src', 'serviceSessions', 'serviceSessionLifecycle.js');
const SOURCE = fs.readFileSync(WRAPPER, 'utf8');

// Strip comments first: the wrapper's header legitimately NAMES RPCs it does
// not call (e.g. to explain why openOperational is used instead of another).
const CODE = SOURCE
  .split(/\r?\n/)
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Every `rpc("name"` / `rpc('name'` the wrapper actually executes.
const CALLED = [...new Set([...CODE.matchAll(/\brpc\(\s*["']([a-z0-9_]+)["']/gi)].map((m) => m[1]))].sort();

test('the wrapper was parsed and really does call RPCs (guards against a broken scan)', () => {
  assert.ok(CALLED.length >= 5, `expected several rpc() call sites, found ${CALLED.length}: ${CALLED.join(', ')}`);
  // Anchors: if these ever stop being detected the regex has drifted.
  for (const anchor of ['ensure_service_session', 'get_current_service_closeout_session',
                        'open_operational_service_v1', 'resolve_order_intake_context_v1']) {
    assert.ok(CALLED.includes(anchor), `${anchor} should be detected as a call site`);
  }
});

test('every RPC the wrapper can call is registered in the transport resource policy', () => {
  const unregistered = CALLED.filter((fn) => !getResourcePolicy(`rpc/${fn}`));
  assert.deepEqual(unregistered, [],
    'unregistered RPCs would throw RESOURCE_NOT_ALLOWED before the network, with no transport log and a generic 500: '
    + unregistered.join(', '));
});

test('every one of them allows POST — PostgREST invokes functions by POST', () => {
  const wrongMethod = CALLED.filter((fn) => !isMethodAllowed(`rpc/${fn}`, 'POST'));
  assert.deepEqual(wrongMethod, [], wrongMethod.join(', '));
});

test('the resolver specifically is registered — the exact gap that broke the first real G-1 seating', () => {
  const policy = getResourcePolicy('rpc/resolve_order_intake_context_v1');
  assert.ok(policy, 'rpc/resolve_order_intake_context_v1 must be registered');
  assert.deepEqual([...policy.allowedMethods], ['POST']);
  assert.equal(policy.kind, 'rpc');
  // Its provenance must name a real caller, not the retired "trigger only" claim.
  assert.match(String(policy.provenance || ''), /serviceSessionLifecycle\.js/);
});

test('the retired "no registry entry by design" claim is gone from the registry source', () => {
  const registry = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'supabaseResourcePolicy.js'), 'utf8');
  assert.doesNotMatch(registry, /deliberately has no registry entry here/,
    'that comment described resolve_order_intake_context_v1 and is no longer true');
});
