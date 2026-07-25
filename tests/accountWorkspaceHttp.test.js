'use strict';
// S2-7D — account workspace/PIN HTTP boundary tests. A real Express app is mounted with
// injected auth + owner-service deps (no Supabase, no DB) and exercised over real HTTP.
// Proves: unauthenticated rejected, invalid/non-account token rejected, unverified email
// rejected, bootstrap guarded (flag + allowlist, fail closed), admin-pin ownership path,
// and that no plaintext PIN is echoed. Run: node tests/accountWorkspaceHttp.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');

const { integrateAccountRoutes } = require('../src/account/accountHttpIntegration');
const { AccountTokenError } = require('../src/account/supabaseToken');
const { AccountAuthorityError } = require('../src/account/supabaseAccountAuthority');

const OWNER_UID = '11111111-1111-4111-8111-111111111111';
const OTHER_UID = '99999999-9999-4999-8999-999999999999';
const WID = '22222222-2222-4222-8222-222222222222';

// Injected auth: token 'ACCOUNT' → verified confirmed owner; 'UNVERIFIED' → confirmed:false;
// 'OTHER' → a different verified account; 'PIN' → AccountTokenError (operational token);
// 'DOWN' → authority unavailable.
function makeDeps(envOverrides = {}) {
  const calls = { claim: [], setPin: [] };
  const verify = async (t) => {
    if (t === 'PIN' || t === 'BAD') throw new AccountTokenError('invalid');
    if (t === 'ACCOUNT' || t === 'UNVERIFIED') return { sub: OWNER_UID, email: 'o@x.io' };
    if (t === 'OTHER') return { sub: OTHER_UID, email: 'z@x.io' };
    if (t === 'DOWN') return { sub: OWNER_UID, email: 'o@x.io' };
    throw new AccountTokenError('invalid');
  };
  const assertAccountSession = async (claims, token) => {
    if (token === 'DOWN') { const e = new AccountAuthorityError('unavailable'); e.isUnavailable = true; throw e; }
    return { emailConfirmed: token !== 'UNVERIFIED' };
  };
  const getAccountMe = async (claims) => ({ userId: claims.sub, adminPinSetupRequired: true, memberships: [], workspaces: [] });
  const ownerService = {
    async claimWorkspace(a) { calls.claim.push(a); return { ok: true, workspaceId: WID, created: true, adminPinRequired: true }; },
    async setOwnerPin(a) {
      calls.setPin.push(a);
      // model SQL ownership: only OWNER_UID owns WID
      if (a.userId !== OWNER_UID || a.workspaceId !== WID) return { ok: false, error: 'account_action_failed' };
      if (a.newPin === 'DUPLICATE') return { ok: false, error: 'pin_duplicate' };
      if (!a.newPin || !/^\d{6}$/.test(a.newPin)) return { ok: false, error: 'account_action_failed' };
      return { ok: true, actor: 'owner', event: 'pin_set', sessionVersion: 2 };
    },
  };
  const env = Object.assign({
    ACCOUNT_HTTP_ENABLED: 'true',
    ACCOUNT_OWNER_BOOTSTRAP_ENABLED: 'true',
    LA_DIECI_OWNER_BOOTSTRAP_USER_ID: OWNER_UID,
  }, envOverrides);
  return { verify, assertAccountSession, getAccountMe, ownerService, env, calls, logger: { error() {} } };
}

async function withServer(deps, fn) {
  const app = express();
  app.use(express.json());
  integrateAccountRoutes(app, deps);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try { return await fn(port); }
  finally { await new Promise((r) => server.close(r)); }
}

function req(port, method, path, { token, body } = {}) {
  return withFetch(port, method, path, token, body);
}
async function withFetch(port, method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = {}; try { j = await res.json(); } catch (_) { j = {}; }
  return { status: res.status, body: j };
}

test('bootstrap: no bearer → 401', async () => {
  await withServer(makeDeps(), async (p) => {
    const r = await req(p, 'POST', '/api/account/workspaces/bootstrap');
    assert.equal(r.status, 401);
  });
});

test('bootstrap: operational PIN token (verify throws) → 401, no claim', async () => {
  const d = makeDeps();
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', '/api/account/workspaces/bootstrap', { token: 'PIN' });
    assert.equal(r.status, 401); assert.equal(d.calls.claim.length, 0);
  });
});

test('bootstrap: unverified email → 403', async () => {
  await withServer(makeDeps(), async (p) => {
    const r = await req(p, 'POST', '/api/account/workspaces/bootstrap', { token: 'UNVERIFIED' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'email_not_verified');
  });
});

test('bootstrap: flag disabled → 404 (fail closed)', async () => {
  const d = makeDeps({ ACCOUNT_OWNER_BOOTSTRAP_ENABLED: 'false' });
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', '/api/account/workspaces/bootstrap', { token: 'ACCOUNT' });
    assert.equal(r.status, 404); assert.equal(d.calls.claim.length, 0);
  });
});

test('bootstrap: non-allowlisted account → 403, no claim', async () => {
  const d = makeDeps();
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', '/api/account/workspaces/bootstrap', { token: 'OTHER' });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'account_not_authorized');
    assert.equal(d.calls.claim.length, 0);
  });
});

test('bootstrap: allowlist env unset → 403 (fail closed)', async () => {
  const d = makeDeps({ LA_DIECI_OWNER_BOOTSTRAP_USER_ID: '' });
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', '/api/account/workspaces/bootstrap', { token: 'ACCOUNT' });
    assert.equal(r.status, 403);
  });
});

test('bootstrap: allowlisted owner → 200, claim called with token sub (not body)', async () => {
  const d = makeDeps();
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', '/api/account/workspaces/bootstrap', { token: 'ACCOUNT', body: { userId: OTHER_UID } });
    assert.equal(r.status, 200); assert.equal(r.body.workspaceId, WID);
    assert.equal(d.calls.claim.length, 1);
    assert.equal(d.calls.claim[0].userId, OWNER_UID); // token sub, body ignored
  });
});

test('admin-pin: no bearer → 401', async () => {
  await withServer(makeDeps(), async (p) => {
    const r = await req(p, 'POST', `/api/account/workspaces/${WID}/admin-pin`, { body: { pin: '482915' } });
    assert.equal(r.status, 401);
  });
});

test('admin-pin: owner sets PIN → 200 pin_set; plaintext not echoed', async () => {
  const d = makeDeps();
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', `/api/account/workspaces/${WID}/admin-pin`, { token: 'ACCOUNT', body: { pin: '482915' } });
    assert.equal(r.status, 200); assert.equal(r.body.event, 'pin_set');
    assert.ok(!JSON.stringify(r.body).includes('482915'));
    assert.equal(d.calls.setPin[0].userId, OWNER_UID);
    assert.equal(d.calls.setPin[0].workspaceId, WID);
  });
});

test('admin-pin: non-owner account for that workspace → 400 generic', async () => {
  const d = makeDeps();
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', `/api/account/workspaces/${WID}/admin-pin`, { token: 'OTHER', body: { pin: '482915' } });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'admin_pin_rejected');
  });
});

test('admin-pin: authority unavailable → 503', async () => {
  await withServer(makeDeps(), async (p) => {
    const r = await req(p, 'POST', `/api/account/workspaces/${WID}/admin-pin`, { token: 'DOWN', body: { pin: '482915' } });
    assert.equal(r.status, 503);
  });
});

test('me: still returns server-derived adminPinSetupRequired', async () => {
  await withServer(makeDeps(), async (p) => {
    const r = await req(p, 'GET', '/api/account/me', { token: 'ACCOUNT' });
    assert.equal(r.status, 200); assert.equal(r.body.adminPinSetupRequired, true);
  });
});

test('admin-pin: a duplicate PIN maps to 409 admin_pin_duplicate (neutral)', async () => {
  const d = makeDeps();
  await withServer(d, async (p) => {
    const r = await req(p, 'POST', `/api/account/workspaces/${WID}/admin-pin`, { token: 'ACCOUNT', body: { pin: 'DUPLICATE' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'admin_pin_duplicate');
    assert.ok(!JSON.stringify(r.body).match(/operator|rider|owner/), 'must not name any actor');
  });
});
