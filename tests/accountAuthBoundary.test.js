"use strict";
// S2-7C — account boundary: Supabase token verification, /api/account/me, and strict
// separation from Auth V2 / PIN. Offline: an ephemeral EC P-256 key stands in for the
// Supabase JWKS; a real Express server exercises the mounted route.
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");

const { createSupabaseTokenVerifier, AccountTokenError } = require("../src/account/supabaseToken");
const { createAccountService } = require("../src/account/accountService");
const { integrateAccountRoutes } = require("../src/account/accountHttpIntegration");
const jwtV2 = require("../src/auth/jwt");

const ISSUER = "https://proj.supabase.co/auth/v1";
const KID = "test-kid-1";

// ── EC P-256 keypair + JWKS ──
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwkPub = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig", key_ops: ["verify"] };
const JWKS = { keys: [jwkPub] };
const jwksProvider = async () => JWKS;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
function signToken(payload, { alg = "ES256", kid = KID } = {}) {
  const header = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  if (alg === "none") return `${header}.${body}.`;
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64u(sig)}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const goodClaims = (over = {}) => ({ sub: "user-uuid-1", email: "fix@x.io", email_verified: true, aud: "authenticated", iss: ISSUER, exp: nowSec() + 3600, iat: nowSec(), ...over });

const verify = createSupabaseTokenVerifier({ jwksProvider, issuer: ISSUER });

test("verifier accepts a valid ES256 token and returns safe claims", async () => {
  const c = await verify(signToken(goodClaims()));
  assert.equal(c.sub, "user-uuid-1");
  assert.equal(c.email, "fix@x.io");
  assert.equal(c.emailVerified, true);
});

test("verifier rejects: expired, bad issuer, bad audience, bad alg, tampered sig, missing", async () => {
  const reject = async (tok, code) => {
    await assert.rejects(() => verify(tok), (e) => e instanceof AccountTokenError && (!code || e.code === code), `expected ${code}`);
  };
  await reject(signToken(goodClaims({ exp: nowSec() - 3600 })), "EXPIRED");
  await reject(signToken(goodClaims({ iss: "https://evil.example/auth/v1" })), "BAD_ISSUER");
  await reject(signToken(goodClaims({ aud: "anon" })), "BAD_AUDIENCE");
  await reject(signToken(goodClaims(), { alg: "none" }), "BAD_ALG");
  await reject(signToken(goodClaims(), { kid: "unknown-kid" }), "UNKNOWN_KID");
  const t = signToken(goodClaims()); const parts = t.split(".");
  await reject(`${parts[0]}.${parts[1]}.${b64u("garbage-signature")}`, "BAD_SIGNATURE");
  await reject("", "MISSING_TOKEN");
  await reject("not.a.jwt.at.all", "MALFORMED_TOKEN");
});

test("verifier treats email as unverified unless explicitly signalled", async () => {
  const c = await verify(signToken(goodClaims({ email_verified: undefined })));
  assert.equal(c.emailVerified, false);
});

test("an Auth V2 PIN JWT is rejected by the account verifier (BAD_ALG, HS256)", async () => {
  // Build a real PIN JWT if the V2 secret is loadable; otherwise synthesize an HS256 token.
  let pinJwt = null;
  try {
    if (jwtV2.isReady()) pinJwt = jwtV2.signToken({ role: "admin", sub: "owner", sv: 1 });
  } catch (_) {}
  if (!pinJwt) {
    const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64u(JSON.stringify({ role: "admin", sub: "owner", sv: 1, v: 2, exp: nowSec() + 3600 }));
    pinJwt = `${header}.${body}.${b64u(crypto.createHmac("sha256", "x").update(`${header}.${body}`).digest())}`;
  }
  await assert.rejects(() => verify(pinJwt), (e) => e instanceof AccountTokenError);
});

test("account service returns safe fields and [] memberships, never leaks secrets", async () => {
  const svc = createAccountService({
    selectProfile: async (uid) => [{ id: uid, display_name: "Fixture", email: "leak@x.io", pin_hash: "scrypt$secret" }],
    selectMemberships: async () => [],
  });
  const out = await svc({ sub: "u1", email: "fix@x.io", emailVerified: true });
  assert.deepEqual(out.memberships, []);
  assert.deepEqual(out.workspaces, []);
  assert.equal(out.displayName, "Fixture");
  const s = JSON.stringify(out);
  assert.equal(/pin_hash|scrypt|password|refresh|service_role|token_digest/.test(s), false);
});

test("account service maps active memberships with workspace + role, drops non-active", async () => {
  const svc = createAccountService({
    selectProfile: async (uid) => [{ id: uid, display_name: "Owner" }],
    selectMemberships: async () => [
      { workspace_id: "w1", role: "workspace_owner", status: "active", workspaces: { slug: "la-dieci", display_name: "La Dieci", lifecycle_status: "active", commercial_status: "trial" } },
      { workspace_id: "w2", role: "workspace_admin", status: "removed", workspaces: { slug: "x", display_name: "X" } },
    ],
  });
  const out = await svc({ sub: "u1", emailVerified: true });
  assert.equal(out.memberships.length, 1);
  assert.equal(out.memberships[0].workspaceSlug, "la-dieci");
  assert.equal(out.memberships[0].role, "workspace_owner");
  assert.deepEqual(out.workspaces, ["w1"]);
});

// ── real Express server integration ──
async function withServer(deps, fn) {
  const app = express();
  app.use(express.json());
  integrateAccountRoutes(app, { env: { ACCOUNT_HTTP_ENABLED: "true" }, ...deps });
  // legacy proxy stand-in AFTER the account route, to prove account never falls through it
  app.use("/api", (req, res) => res.status(401).json({ error: "unauthorized_legacy" }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { server.close(); }
}

test("integration disabled by default is a strict no-op", () => {
  const app = express();
  const r = integrateAccountRoutes(app, { env: {} });
  assert.equal(r.enabled, false);
});

test("GET /api/account/me: 401 without token, 401 invalid, 200 with valid token", async () => {
  await withServer(
    {
      verify: (t) => verify(t),
      getAccountMe: async (c) => ({ userId: c.sub, email: c.email, emailVerified: c.emailVerified, displayName: null, memberships: [], workspaces: [] }),
    },
    async (base) => {
      const noTok = await fetch(`${base}/api/account/me`);
      assert.equal(noTok.status, 401);

      const bad = await fetch(`${base}/api/account/me`, { headers: { Authorization: "Bearer not.a.real.token" } });
      assert.equal(bad.status, 401);

      const good = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${signToken(goodClaims())}` } });
      assert.equal(good.status, 200);
      const body = await good.json();
      assert.equal(body.userId, "user-uuid-1");
      assert.deepEqual(body.memberships, []);
    }
  );
});

test("a PIN JWT presented to /api/account/me is rejected (401), never falls to legacy proxy", async () => {
  await withServer({ verify: (t) => verify(t) }, async (base) => {
    const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64u(JSON.stringify({ role: "admin", sub: "owner", sv: 1, v: 2, exp: nowSec() + 3600 }));
    const pinJwt = `${header}.${body}.${b64u(crypto.createHmac("sha256", "x").update(`${header}.${body}`).digest())}`;
    const res = await fetch(`${base}/api/account/me`, { headers: { Authorization: `Bearer ${pinJwt}` } });
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.notEqual(j.error, "unauthorized_legacy"); // handled by account route, not the proxy
  });
});
