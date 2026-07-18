# B7A4 — Staging-Gated Financial Route Integration (Contract)

**Status:** B7A4 integrates the accepted B7A3 financial HTTP boundary into the real
Express application, **disabled by default**. No deployment performed; production untouched.

```
Flag disabled (default)
    → application behaves exactly as before (no financial routes, no middleware side effect)

Flag enabled (staging only)
    → four exact JWT financial routes are mounted BEFORE the legacy /api proxy
    → all other /api traffic remains on the legacy X-Api-Key path, unchanged
```

## Feature flag
- Name: **`AUTH_V2_FINANCIAL_HTTP_ENABLED`**
- Accepted true value: **exactly `"true"`** (string). Absent / empty / any other value
  (`1`, `TRUE`, `yes`, ` true`, …) → **disabled**.
- No hostname / branch / `NODE_ENV` / Supabase-URL fallback; no automatic production
  enablement. Not enabled in this phase. Secret env files were not modified.

## Exact routes (four, POST only)
`POST /api/financial/mark-paid` · `POST /api/financial/import-legacy-payment` ·
`POST /api/financial/refund` · `POST /api/financial/void`. No generic
`/api/financial/:action` route; route names are static; each registered once.

## Mount location & middleware order (index.js)
`integrateFinancialRoutes(app, { env: process.env, logger: console })` is called **after**
`express.json()` + CORS and **before** the legacy `app.use("/api", X-Api-Key guard)`, so a
POST to the four static paths enters its JWT chain first (never reaching the key guard),
while every other `/api/*` path continues to the legacy proxy. Effective order when enabled:
```
CORS / OPTIONS → express.json() (100kb) → financial-scoped JSON error sanitizer
→ Bearer JWT verify (jwt.verifyToken) → DB actor/session freshness (dao.getActor, under-lock guard in SQL)
→ trusted context attach (DB role + session_version) → financial handler → service → DAO → one guarded RPC
```
`app.listen` + schedulers are guarded by `require.main === module`; `module.exports = { app }`
lets tests construct the real app with no port and no scheduled DB work.

## JWT vs X-Api-Key separation
Financial routes authenticate with **Bearer JWT only** — they neither require nor accept the
legacy `X-Api-Key`, and a valid JWT works without it. `X-Api-Key` alone (no JWT) on a
financial path → 401. All non-financial `/api` paths keep the legacy `X-Api-Key` behavior
byte-for-byte. Only the four exact routes bypass the proxy (no generic `/api/financial/*`
exception).

## Parser / error / CORS ownership
The global `express.json()` (default 100kb) is reused (no second parser). A **financial-
scoped** sanitizing error middleware (registered only when enabled, after the routes) turns
parser errors on financial paths into `{ok:false, code}` (malformed → 400
`FINANCIAL_INVALID_REQUEST`, oversize → 413 `FINANCIAL_PAYLOAD_TOO_LARGE`; no stack/raw
body) and passes every other path's parser error through unchanged. CORS/OPTIONS stay with
the existing app-level middleware (OPTIONS → 204).

## Response / error contract (unchanged from B7A3/B7A2D)
200 fresh + 200 replay (`idempotent=true`, same event id); 401 missing/invalid/expired JWT,
actor missing, **stale session (`AUTH_SESSION_STALE`)**; 403 inactive/role mismatch; 404
order missing; 400 client validation; 409 financial/state conflict; sanitized 500 for
ambiguous authority/internal failures. No retry. No stack/JWT/service-key/SQL/session/IP/
metadata/digest leakage.

## Session freshness: preflight + SQL atomic guard
The B7A3 middleware performs the DB-authoritative preflight (role/active/session_version);
the B7A2D guarded RPCs re-check `p_session_version` against the locked
`auth_actors.session_version` inside the mutation transaction. Every security-sensitive
actor mutation invalidates existing JWTs: PIN change, explicit revoke, and deactivation all
bump `session_version` (B2 + B6 RPCs); recovery bumps it; reactivation never restores an old
token (deactivation already bumped). Actor **role is structurally immutable** — fixed by the
`auth_actors` `(actor, role)` CHECK constraint with no mutation path — so role-change token
invalidation is moot.

## Login HTTP prerequisite
The Auth V2 login handler (`src/auth/login.js`) exists only as an offline module; **no login
HTTP endpoint is wired** into the application. Real staging E2E of these financial routes
therefore requires wiring an Auth V2 login endpoint (to obtain the JWT) as a prerequisite —
**out of scope for B7A4** and not added here.

## Artifacts
- Integration + flag + harness: `src/auth/financialHttpIntegration.js`
- Real-app wiring: `index.js` (flag-gated mount; `require.main` guard; `module.exports = { app }`)
- Tests: `tests/financialHttpIntegration.test.js`, `tests/financialHttpIntegrationGuards.test.js`
- Reused (unchanged): `src/auth/financialHttpHandlers.js`, `financialHttpErrors.js`, `financialService.js`, `financialDao.js`, `jwt.js`, `dao.js`, `ipSecurity.js`

## Not done in this phase
No deploy; flag left disabled; no login endpoint added; no SQL/frontend/Netlify/production change.
