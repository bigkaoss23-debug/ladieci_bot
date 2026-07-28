"use strict";
// S2-7C1B — canonical account-session validation by PRESENTED TOKEN. Proves /api/account/me
// sends the client's own bearer to Supabase Auth (/auth/v1/user) and treats GoTrue's answer
// as the authority — not the JWT claims, not an admin lookup by sub, and never the
// service-role key. Fails closed. Offline: an ephemeral EC P-256 key stands in for the
// Supabase JWKS; a fake /auth/v1/user stands in for GoTrue; a real Express server exercises
// the mounted route end to end.
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");

const { createSupabaseTokenVerifier } = require("../src/account/supabaseToken");
const {
  createAccountAuthority,
  createSupabaseUserTokenValidator,
  AccountAuthorityError,
} = require("../src/account/supabaseAccountAuthority");
const { integrateAccountRoutes } = require("../src/account/accountHttpIntegration");
const jwtV2 = require("../src/auth/jwt");

const ISSUER = "https://proj.supabase.co/auth/v1";
const KID = "test-kid-1";
const ANON = "ANON-PUBLIC-KEY";
const SERVICE = "SERVICE-ROLE-SECRET"; // must never appear in an outgoing bearer request

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
const goTrueUser = (over = {}) => ({ id: "user-uuid-1", email: "owner@x.io", email_confirmed_at: "2026-07-23T10:00:00Z", banned_until: null, deleted_at: null, ...over });

// ── the HTTP validator: presented token → /auth/v1/user, anon apikey, never service key ──
test("validator sends the client's bearer + anon apikey, never the service key, token in header only", async () => {
  let seenUrl = null, seenHeaders = null;
  const fetchImpl = async (url, opts) => { seenUrl = url; seenHeaders = opts.headers; return { status: 200, ok: true, json: async () => goTrueUser() }; };
  const getUser = createSupabaseUserTokenValidator({ supabaseUrl: "https://proj.supabase.co", anonKey: ANON, fetchImpl });
  const user = await getUser("THE-ACCESS-TOKEN");
  assert.equal(user.id, "user-uuid-1");
  assert.match(seenUrl, /\/auth\/v1\/user$/);
  assert.equal(seenHeaders.apikey, ANON);
  assert.equal(seenHeaders.Authorization, "Bearer THE-ACCESS-TOKEN");
  const blob = seenUrl + JSON.stringify(seenHeaders);
  assert.equal(blob.includes(SERVICE), false);      // service-role key never used
  assert.equal(seenUrl.includes("THE-ACCESS-TOKEN"), false); // token never in the URL
});

test("validator maps GoTrue 401 and 403 to SESSION_REJECTED (token not accepted)", async () => {
  for (const status of [401, 403]) {
    const getUser = createSupabaseUserTokenValidator({ supabaseUrl: "https://p", anonKey: ANON, fetchImpl: async () => ({ status, ok: false, json: async () => ({}) }) });
    await assert.rejects(() => getUser("t"), (e) => e instanceof AccountAuthorityError && e.code === "SESSION_REJECTED" && e.isReject);
  }
});

test("validator maps 5xx / network / timeout to AUTH_BACKEND_UNAVAILABLE (fail closed)", async () => {
  const g5 = createSupabaseUserTokenValidator({ supabaseUrl: "https://p", anonKey: ANON, fetchImpl: async () => ({ status: 500, ok: false, json: async () => ({}) }) });
  await assert.rejects(() => g5("t"), (e) => e instanceof AccountAuthorityError && e.isUnavailable);
  const gNet = createSupabaseUserTokenValidator({ supabaseUrl: "https://p", anonKey: ANON, fetchImpl: async () => { throw new Error("down"); } });
  await assert.rejects(() => gNet("t"), (e) => e instanceof AccountAuthorityError && e.isUnavailable);
  const gTimeout = createSupabaseUserTokenValidator({
    supabaseUrl: "https://p", anonKey: ANON, timeoutMs: 20,
    fetchImpl: (url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  await assert.rejects(() => gTimeout("t"), (e) => e instanceof AccountAuthorityError && e.isUnavailable);
});

test("validator is fail-closed when SUPABASE_URL / anon key absent", async () => {
  const getUser = createSupabaseUserTokenValidator({ supabaseUrl: "", anonKey: "" });
  await assert.rejects(() => getUser("t"), (e) => e instanceof AccountAuthorityError && e.isUnavailable);
});

// ── the authority: canonical identity from GoTrue, sub match, usable state ──
test("authority accepts a token GoTrue accepts for a confirmed, enabled user", async () => {
  const authority = createAccountAuthority({ getUserByToken: async () => goTrueUser() });
  const out = await authority(goodClaims(), "tok");
  assert.equal(out.id, "user-uuid-1");
  assert.equal(out.emailConfirmed, true);
});

test("authority rejects when GoTrue refuses the token (deleted/revoked user)", async () => {
  const authority = createAccountAuthority({ getUserByToken: async () => { throw new AccountAuthorityError("SESSION_REJECTED"); } });
  await assert.rejects(() => authority(goodClaims(), "tok"), (e) => e.code === "SESSION_REJECTED");
});

test("authority rejects a sub that disagrees with the GoTrue user id", async () => {
  const authority = createAccountAuthority({ getUserByToken: async () => goTrueUser({ id: "someone-else" }) });
  await assert.rejects(() => authority(goodClaims(), "tok"), (e) => e.code === "SUBJECT_MISMATCH" && e.isReject);
});

test("authority rejects an unconfirmed email even if the token claimed verified", async () => {
  const authority = createAccountAuthority({ getUserByToken: async () => goTrueUser({ email_confirmed_at: null, confirmed_at: null }) });
  await assert.rejects(() => authority(goodClaims({ email_verified: true }), "tok"), (e) => e.code === "EMAIL_NOT_CONFIRMED");
});

test("authority rejects a banned user and ignores an expired ban", async () => {
  const banned = createAccountAuthority({ getUserByToken: async () => goTrueUser({ banned_until: new Date(Date.now() + 3600e3).toISOString() }) });
  await assert.rejects(() => banned(goodClaims(), "tok"), (e) => e.code === "USER_DISABLED");
  const expired = createAccountAuthority({ getUserByToken: async () => goTrueUser({ banned_until: new Date(Date.now() - 3600e3).toISOString() }) });
  assert.equal((await expired(goodClaims(), "tok")).id, "user-uuid-1");
});

test("authority rejects a soft-deleted user record", async () => {
  const authority = createAccountAuthority({ getUserByToken: async () => goTrueUser({ deleted_at: "2026-07-23T11:00:00Z" }) });
  await assert.rejects(() => authority(goodClaims(), "tok"), (e) => e.code === "USER_DELETED");
});

test("authority is fail-closed on unavailability and on a missing token", async () => {
  const authority = createAccountAuthority({ getUserByToken: async () => { throw new AccountAuthorityError("AUTH_BACKEND_UNAVAILABLE"); } });
  await assert.rejects(() => authority(goodClaims(), "tok"), (e) => e.isUnavailable);
  const ok = createAccountAuthority({ getUserByToken: async () => goTrueUser() });
  await assert.rejects(() => ok(goodClaims(), ""), (e) => e.code === "SESSION_REJECTED");
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

test("E2E: the presented token is forwarded to the authority verbatim", async () => {
  let seenToken = null;
  const tok = signToken(goodClaims());
  await withServer(
    { assertAccountSession: async (c, t) => { seenToken = t; return { id: c.sub, email: c.email, emailConfirmed: true }; }, getAccountMe: async (c) => meBody(c) },
    async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${tok}` } });
      assert.equal(res.status, 200);
      assert.equal(seenToken, tok); // the SAME bearer the client presented reaches GoTrue
      const body = await res.json();
      assert.equal(body.emailVerified, true);
    }
  );
});

test("E2E: GoTrue rejects the token (deleted/revoked) → 401, never the legacy proxy", async () => {
  await withServer({ assertAccountSession: async () => { throw new AccountAuthorityError("SESSION_REJECTED"); } }, async (base) => {
    const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
    assert.equal(res.status, 401);
    assert.notEqual((await res.json()).error, "unauthorized_legacy");
  });
});

test("E2E: sub mismatch and unconfirmed email → 401", async () => {
  for (const code of ["SUBJECT_MISMATCH", "EMAIL_NOT_CONFIRMED"]) {
    await withServer({ assertAccountSession: async () => { throw new AccountAuthorityError(code); }, getAccountMe: async (c) => meBody(c) }, async (base) => {
      const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
      assert.equal(res.status, 401);
    });
  }
});

test("E2E: Supabase Auth unavailable → 503 (fail closed), and an untyped throw is also 503", async () => {
  await withServer({ assertAccountSession: async () => { throw new AccountAuthorityError("AUTH_BACKEND_UNAVAILABLE"); }, getAccountMe: async (c) => meBody(c) }, async (base) => {
    assert.equal((await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } })).status, 503);
  });
  await withServer({ assertAccountSession: async () => { throw new Error("boom"); }, getAccountMe: async (c) => meBody(c) }, async (base) => {
    assert.equal((await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } })).status, 503);
  });
});

test("E2E: expired / bad issuer / bad audience rejected at the pre-filter, authority never consulted", async () => {
  let called = false;
  await withServer({ assertAccountSession: async () => { called = true; return { id: "x", emailConfirmed: true }; } }, async (base) => {
    for (const claims of [goodClaims({ exp: nowSec() - 3600 }), goodClaims({ iss: "https://evil/auth/v1" }), goodClaims({ aud: "anon" })]) {
      assert.equal((await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(claims)}` } })).status, 401);
    }
    assert.equal(called, false);
  });
});

test("E2E: a PIN JWT is always rejected (401) and never reaches the authority", async () => {
  let called = false;
  await withServer({ assertAccountSession: async () => { called = true; return { id: "x", emailConfirmed: true }; } }, async (base) => {
    let pinJwt = null;
    try { if (jwtV2.isReady()) pinJwt = jwtV2.signToken({ role: "admin", sub: "owner", sv: 1, authMethod: jwtV2.AUTH_METHOD_ACTOR_PIN }); } catch (_) {}
    if (!pinJwt) {
      const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const body = b64u(JSON.stringify({ role: "admin", sub: "owner", sv: 1, v: 2, exp: nowSec() + 3600 }));
      pinJwt = `${header}.${body}.${b64u(crypto.createHmac("sha256", "x").update(`${header}.${body}`).digest())}`;
    }
    const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${pinJwt}` } });
    assert.equal(res.status, 401);
    assert.equal(called, false);
    assert.notEqual((await res.json()).error, "unauthorized_legacy");
  });
});
