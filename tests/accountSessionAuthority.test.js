"use strict";
// S2-7C1 — canonical server-side account-session validation. Proves /api/account/me does not
// trust the JWT claims alone but confirms the CURRENT state of the subject against Supabase
// Auth (GoTrue admin API), and fails closed. Offline: an ephemeral EC P-256 key stands in for
// the Supabase JWKS; a fake adminGetUser stands in for the GoTrue admin endpoint; a real
// Express server exercises the mounted route end to end.
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");

const { createSupabaseTokenVerifier } = require("../src/account/supabaseToken");
const {
  createAccountAuthority,
  createSupabaseAdminUserProvider,
  AccountAuthorityError,
} = require("../src/account/supabaseAccountAuthority");
const { integrateAccountRoutes } = require("../src/account/accountHttpIntegration");
const jwtV2 = require("../src/auth/jwt");

const ISSUER = "https://proj.supabase.co/auth/v1";
const KID = "test-kid-1";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwkPub = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig", key_ops: ["verify"] };
const JWKS = { keys: [jwkPub] };
const jwksProvider = async () => JWKS;
const verify = createSupabaseTokenVerifier({ jwksProvider, issuer: ISSUER });

const b64u = (buf) => Buffer.from(buf).toString("base64url");
function signToken(payload, { alg = "ES256", kid = KID } = {}) {
  const header = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  if (alg === "none") return `${header}.${body}.`;
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64u(sig)}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const goodClaims = (over = {}) => ({ sub: "user-uuid-1", email: "owner@x.io", email_verified: true, aud: "authenticated", iss: ISSUER, exp: nowSec() + 3600, iat: nowSec(), ...over });

// A confirmed, enabled GoTrue user record.
const confirmedUser = (over = {}) => ({ id: "user-uuid-1", email: "owner@x.io", email_confirmed_at: "2026-07-23T10:00:00Z", banned_until: null, deleted_at: null, ...over });

// ── unit: the authority itself ──────────────────────────────────────────────
test("authority accepts a live, confirmed, enabled user", async () => {
  const authority = createAccountAuthority({ adminGetUser: async () => confirmedUser() });
  const out = await authority({ sub: "user-uuid-1", email: "owner@x.io" });
  assert.equal(out.id, "user-uuid-1");
  assert.equal(out.emailConfirmed, true);
});

test("authority rejects a user deleted after token issuance (USER_NOT_FOUND when absent)", async () => {
  const authority = createAccountAuthority({ adminGetUser: async () => null });
  await assert.rejects(() => authority({ sub: "user-uuid-1" }),
    (e) => e instanceof AccountAuthorityError && e.code === "USER_NOT_FOUND" && e.isReject);
});

test("authority rejects a soft-deleted user (deleted_at set)", async () => {
  const authority = createAccountAuthority({ adminGetUser: async () => confirmedUser({ deleted_at: "2026-07-23T11:00:00Z" }) });
  await assert.rejects(() => authority({ sub: "user-uuid-1" }),
    (e) => e instanceof AccountAuthorityError && e.code === "USER_DELETED");
});

test("authority rejects a banned/disabled user (banned_until in the future)", async () => {
  const future = new Date(Date.now() + 3600e3).toISOString();
  const authority = createAccountAuthority({ adminGetUser: async () => confirmedUser({ banned_until: future }) });
  await assert.rejects(() => authority({ sub: "user-uuid-1" }),
    (e) => e instanceof AccountAuthorityError && e.code === "USER_DISABLED");
});

test("authority ignores an expired ban (banned_until in the past)", async () => {
  const past = new Date(Date.now() - 3600e3).toISOString();
  const authority = createAccountAuthority({ adminGetUser: async () => confirmedUser({ banned_until: past }) });
  const out = await authority({ sub: "user-uuid-1" });
  assert.equal(out.id, "user-uuid-1");
});

test("authority rejects an unconfirmed email even if the token claimed verified", async () => {
  const authority = createAccountAuthority({ adminGetUser: async () => confirmedUser({ email_confirmed_at: null, confirmed_at: null }) });
  await assert.rejects(() => authority({ sub: "user-uuid-1" }),
    (e) => e instanceof AccountAuthorityError && e.code === "EMAIL_NOT_CONFIRMED");
});

test("authority treats Auth unavailability as fail-closed (AUTH_BACKEND_UNAVAILABLE), never a pass", async () => {
  const authority = createAccountAuthority({ adminGetUser: async () => { throw new Error("network down"); } });
  await assert.rejects(() => authority({ sub: "user-uuid-1" }),
    (e) => e instanceof AccountAuthorityError && e.isUnavailable);
});

test("authority rejects a record whose id disagrees with the token subject", async () => {
  const authority = createAccountAuthority({ adminGetUser: async () => confirmedUser({ id: "someone-else" }) });
  await assert.rejects(() => authority({ sub: "user-uuid-1" }),
    (e) => e instanceof AccountAuthorityError && e.code === "SESSION_REJECTED");
});

// ── the HTTP admin provider fails closed when unconfigured, and never leaks the key ──
test("admin provider is fail-closed when SUPABASE_URL/KEY are absent", async () => {
  const provider = createSupabaseAdminUserProvider({ supabaseUrl: "", serviceKey: "" });
  await assert.rejects(() => provider("user-uuid-1"));
});

test("admin provider sends the service key only as headers and maps 404 to null", async () => {
  let seenUrl = null, seenHeaders = null;
  const fetchImpl = async (url, opts) => { seenUrl = url; seenHeaders = opts.headers; return { status: 404, ok: false, json: async () => ({}) }; };
  const provider = createSupabaseAdminUserProvider({ supabaseUrl: "https://proj.supabase.co", serviceKey: "SRV-SECRET", fetchImpl });
  const out = await provider("user-uuid-1");
  assert.equal(out, null);
  assert.match(seenUrl, /\/auth\/v1\/admin\/users\/user-uuid-1$/);
  assert.equal(seenHeaders.apikey, "SRV-SECRET");
  assert.equal(seenHeaders.Authorization, "Bearer SRV-SECRET");
  assert.equal(seenUrl.includes("SRV-SECRET"), false); // key never travels in the URL
});

test("admin provider aborts on timeout → treated as unavailable by the authority", async () => {
  const fetchImpl = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const provider = createSupabaseAdminUserProvider({ supabaseUrl: "https://proj.supabase.co", serviceKey: "k", fetchImpl, timeoutMs: 20 });
  const authority = createAccountAuthority({ adminGetUser: provider });
  await assert.rejects(() => authority({ sub: "user-uuid-1" }),
    (e) => e instanceof AccountAuthorityError && e.isUnavailable);
});

// ── end-to-end through the mounted route ────────────────────────────────────
async function withServer(deps, fn) {
  const app = express();
  app.use(express.json());
  integrateAccountRoutes(app, { env: { ACCOUNT_HTTP_ENABLED: "true" }, verify: (t) => verify(t), ...deps });
  app.use("/api", (req, res) => res.status(401).json({ error: "unauthorized_legacy" }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { server.close(); }
}
const meBody = (c) => ({ userId: c.sub, email: c.email, emailVerified: c.emailVerified, displayName: null, memberships: [], workspaces: [] });

test("E2E: valid token + live confirmed user → 200 and Auth-derived emailVerified", async () => {
  await withServer(
    { assertAccountSession: async (c) => ({ id: c.sub, email: c.email, emailConfirmed: true }), getAccountMe: async (c) => meBody(c) },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.userId, "user-uuid-1");
      assert.equal(body.emailVerified, true);
    }
  );
});

test("E2E: token claims email_verified but Auth says unconfirmed → 401 (claims never trusted)", async () => {
  await withServer(
    { assertAccountSession: async () => { throw new AccountAuthorityError("EMAIL_NOT_CONFIRMED"); }, getAccountMe: async (c) => meBody(c) },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims({ email_verified: true }))}` } });
      assert.equal(res.status, 401);
      const j = await res.json();
      assert.equal(j.error, "account_auth_invalid");
    }
  );
});

test("E2E: user deleted after issuance → 401, never falls to legacy proxy", async () => {
  await withServer(
    { assertAccountSession: async () => { throw new AccountAuthorityError("USER_NOT_FOUND"); } },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
      assert.equal(res.status, 401);
      const j = await res.json();
      assert.notEqual(j.error, "unauthorized_legacy");
    }
  );
});

test("E2E: banned user → 401", async () => {
  await withServer(
    { assertAccountSession: async () => { throw new AccountAuthorityError("USER_DISABLED"); } },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
      assert.equal(res.status, 401);
    }
  );
});

test("E2E: Supabase Auth unavailable → 503 (fail-closed), NOT 200", async () => {
  await withServer(
    { assertAccountSession: async () => { throw new AccountAuthorityError("AUTH_BACKEND_UNAVAILABLE"); }, getAccountMe: async (c) => meBody(c) },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
      assert.equal(res.status, 503);
      const j = await res.json();
      assert.equal(j.error, "account_auth_unavailable");
    }
  );
});

test("E2E: an unexpected (non-typed) authority throw is still fail-closed → 503", async () => {
  await withServer(
    { assertAccountSession: async () => { throw new Error("boom"); }, getAccountMe: async (c) => meBody(c) },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
      assert.equal(res.status, 503);
    }
  );
});

test("E2E: expired token is rejected at the local pre-filter, authority never consulted", async () => {
  let authorityCalled = false;
  await withServer(
    { assertAccountSession: async () => { authorityCalled = true; return { id: "x", emailConfirmed: true }; } },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims({ exp: nowSec() - 3600 }))}` } });
      assert.equal(res.status, 401);
      assert.equal(authorityCalled, false);
    }
  );
});

test("E2E: bad issuer / bad audience rejected before the authority", async () => {
  await withServer({ assertAccountSession: async () => ({ id: "x", emailConfirmed: true }) }, async (base) => {
    for (const claims of [goodClaims({ iss: "https://evil/auth/v1" }), goodClaims({ aud: "anon" })]) {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(claims)}` } });
      assert.equal(res.status, 401);
    }
  });
});

test("E2E: a PIN JWT is always rejected (401) and never reaches the authority", async () => {
  let authorityCalled = false;
  await withServer({ assertAccountSession: async () => { authorityCalled = true; return { id: "x", emailConfirmed: true }; } }, async (base) => {
    let pinJwt = null;
    try { if (jwtV2.isReady()) pinJwt = jwtV2.signToken({ role: "admin", sub: "owner", sv: 1 }); } catch (_) {}
    if (!pinJwt) {
      const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const body = b64u(JSON.stringify({ role: "admin", sub: "owner", sv: 1, v: 2, exp: nowSec() + 3600 }));
      pinJwt = `${header}.${body}.${b64u(crypto.createHmac("sha256", "x").update(`${header}.${body}`).digest())}`;
    }
    const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${pinJwt}` } });
    assert.equal(res.status, 401);
    assert.equal(authorityCalled, false);
    const j = await res.json();
    assert.notEqual(j.error, "unauthorized_legacy");
  });
});
