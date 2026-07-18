# B7A5 — Staging-Gated Auth V2 Login Route Integration (Contract)

**Status:** wires the accepted B3 login boundary into the real Express application,
**disabled by default**. No deployment; production untouched. Independent of the B7A4
financial flag.

```
Login flag disabled (default)
    → no Auth V2 login route (request follows the previous legacy behaviour)

Login flag enabled (staging only)
    → exact POST /api/auth/v2/login, mounted BEFORE the legacy /api proxy
    → accepted B3 login handler / atomic auth RPC authority
    → JWT returned through the accepted B3 success envelope

Financial flag independently enabled
    → four JWT financial routes (B7A4); login flag never enables them, and vice-versa
```

## Feature flag
- Name: **`AUTH_V2_LOGIN_HTTP_ENABLED`**; accepted true value **exactly `"true"`**. Absent /
  empty / any other value (`1`, `TRUE`, `yes`, ` true`) → disabled. No host / branch /
  `NODE_ENV` / Supabase-URL fallback; no production default; **no coupling to
  `AUTH_V2_FINANCIAL_HTTP_ENABLED`** — the two flags are independently controllable. Not
  enabled in this phase; no secret env files modified.

## Login path (exactly one)
`POST /api/auth/v2/login`. No GET login, no query/path PIN, no `/api/auth/:action`, no
role-specific / financial / compatibility login aliases.

## Mount order (index.js)
`integrateLoginRoute(app, { env: process.env, logger: console })` is called **after**
`express.json()` + CORS and **before** the legacy `app.use("/api", X-Api-Key guard)`
(alongside, and independent of, the financial integration). When enabled:
```
CORS / OPTIONS → express.json() (100kb) → login-scoped parser-error sanitizer
→ POST /api/auth/v2/login → accepted B3 login handler → atomic auth RPC
```
The login route is **unauthenticated** — it neither requires nor accepts a Bearer JWT or the
legacy `X-Api-Key`, and never falls through to the legacy proxy. All other `/api` paths keep
the legacy `X-Api-Key` behavior unchanged.

## Request contract (accepted B3, exact)
Body fields consumed: `role` (`admin`|`operator`|`rider`), `pin` (string, **passed
verbatim** — no trim/normalize/log), `actor` (operator only: `operator_primary`|
`operator_backup`; admin→owner, rider→rider auto-resolved). Client IP is taken from the
server-owned request context (`extractClientIp(req)`, the accepted B3/B7A4 boundary), never
a body-supplied IP / ip-hash / forwarded-for chain. Caller authority over
role/session/expiry/claims/active/failed-count/lockout/PIN-hash/audit-role/service-key is
never accepted. No credentials via query/path/headers/metadata.

## Success contract
Derived entirely from the accepted B3 result: **HTTP 200** `{ token, role, actor, expiresIn,
tokenVersion: 2 }`. The integration reconstructs no claims and manufactures no
token/role/actor/session/expiry. The token appears only in the response body — never in
logs, URLs, redirects, headers, or cookies.

## Error mapping (accepted B3 semantics; transport additions)
The B3 handler returns `{status, body}`; the integration passes it through:
- **400** malformed / invalid shape (`solicitud inválida`)
- **401** invalid credentials, and — by design — inactive actor and non-existent (valid-shape)
  actor (`credenciales incorrectas`); a single scrypt derivation per attempt (real or decoy)
  and the normalized 401 avoid an actor-enumeration channel
- **429** locked / rate-limited (`temporalmente bloqueado`, `retryAfterSec`)
- **503** auth service unavailable (JWT not ready / reset transient)
- **413** oversized body · **400** malformed JSON (login-scoped parser sanitizer)
- **500** unexpected handler failure (fail-closed, sanitized)
Client-visible failures never expose PIN-hash existence, SQL text, failed-count internals,
lockout implementation, session-version, JWT secret, stack, raw IP, IP hash, metadata, or
the supplied PIN.

## Rate-limit / lockout ownership
Owned entirely by the accepted B3 handler + DAO: DB lock pre-check (`getLockState`), atomic
`recordFailedAttempt` (authoritative lockout), and a secondary in-memory IP limiter
(non-primary, per-instance). The integration adds none of this and performs no retry.

## Parser / CORS ownership
Reuses the global `express.json()` (default 100kb; no second parser). A **login-scoped**
sanitizing error middleware (registered only when enabled, after the route) handles parser
errors for the login path **only**; every other path's parser error passes through
unchanged. CORS/OPTIONS remain app-level (OPTIONS → 204). GET/PUT/PATCH/DELETE cannot invoke
login (POST-only).

## Runtime-entrypoint proof
Start command is `package.json` `start: "node index.js"` (`main: index.js`); no
Procfile/railway/nixpacks/Dockerfile override exists. `index.js` is therefore the runtime
main module, so `require.main === module` is true → `app.listen` and all three schedulers
(`schedula2340`, `schedula2350`, `catchUpChiusura`) run once; requiring `index.js` in tests
stays side-effect-free (no port, no scheduled DB work). The B7A4 guard remains compatible;
no startup correction was needed.

## Login HTTP prerequisite — now satisfied (gated)
This closes the B7A4-noted prerequisite: an Auth V2 login endpoint exists (flag-gated) to
issue the JWT the financial middleware consumes. Real staging HTTP E2E can enable both flags
in staging configuration.

## Artifacts
- Integration + flag + combined harness: `src/auth/loginHttpIntegration.js`
- Real-app wiring: `index.js` (flag-gated mount before the legacy proxy)
- Tests: `tests/loginHttpIntegration.test.js`, `tests/loginHttpIntegrationGuards.test.js`
- Reused (unchanged): `src/auth/login.js`, `dao.js`, `jwt.js`, `pinPolicy.js`, `scrypt.js`, `ipSecurity.js`, `audit.js`, `financialHttpHandlers.js` (IP boundary), `financialHttpIntegration.js` (harness)

## Not done in this phase
No deploy; both flags left disabled; no SQL/crypto/PIN-hashing/financial-semantics change;
no frontend/Netlify/production change.
