# S2-7C1 — Account-auth production-readiness gate (staging) — REPORT

**Final status: `S2-7C1 PARTIAL — TECHNICAL FIXES GREEN, OWNER-DASHBOARD OR EMAIL DELIVERY ACTION REQUIRED`**

Reference date 2026-07-23. Repo `ladieci-s2-6a2-service-session-backend`. Work branch
`s2-7c1/account-auth-readiness` @ `ef510e4`, cut from baseline `0222f04`. **No production, no
real owner email, no push.**

## Recorded baseline (verified before any change)

- branch `feature/s2-6a2-service-session-backend`, HEAD `0222f04` (account boundary S2-7C);
  `140c8cd` (workspace S2-7B) in ancestry; preserved commits `4ecf3e1`,`0cf9320`,`140c8cd`,`0222f04` all present.
- working tree clean except one **pre-existing, unrelated** untracked file
  `ops/backup/auth_actors_PRE_s2-6a3d_2026-07-23.md` — deliberately NOT included in this work.
- baseline branch remains at `0222f04` after the session (untouched; new branch used).

## 1. Migration reconciliation

- This project has **no Supabase CLI ledger** (`supabase/` dir / `schema_migrations` absent);
  migrations are applied manually and tracked by git + static tests.
- The two account/workspace migrations are date-prefixed **2026-07-24** but were committed
  **2026-07-23** (`140c8cd` 14:55, `0222f04` 15:20) → filenames one day in the future.
- **Two hazards found.** (a) Future-date prefix: cosmetic, still sorts last. (b) **Real reorder
  hazard:** both share the `2026-07-24` prefix and lexically `account_auth_boundary` sorts
  **before** `workspace_foundation`, the reverse of the dependency — S2-7C revokes/triggers on
  `public.user_profiles` and `workspace_account_audit`, which S2-7B creates. A filename-ordered
  replay would run S2-7C first and fail.
- **Adopted fix:** keep filenames as-is (no rename, no SQL re-run, no history wipe) and add
  `migrations/MIGRATION_MANIFEST.md` as the explicit replay authority pinning
  `apply_order` = workspace(29) → account(30), plus per-file source `sha256` and the
  introducing commit. Renaming was rejected because it would rewrite forbidden commits and
  diverge source from applied-history. `tests/migrationManifestOrder.test.js` locks the order,
  the dependency, and no-skip coverage. Full checksum/commit/order table is in the manifest.
- **Replay-safety proof:** driver keyed on the manifest cannot **skip** (every file listed),
  **duplicate** (checksum-gated), or **reorder** (ascending apply_order = commit/dependency
  order, overriding lexical filenames).
- **Residual (owner/tooling):** confirming the *registered* version in the live staging DB
  needs Management/DB access not available this session; when checked, the applied name must
  equal `2026-07-24_*` (do not rename afterward).

## 2. Token validation / revocation method

- **Before:** `/api/account/me` did only local ES256/JWKS verification (signature, issuer,
  audience, expiry, subject) and read `email_verified` from the token claim — no server-side
  confirmation of user/session state.
- **Now (two-stage, fail-closed):**
  1. local ES256/JWKS pre-filter (`supabaseToken.js`, unchanged);
  2. canonical server-side check (`supabaseAccountAuthority.js`) via the **GoTrue admin API**
     (`GET /auth/v1/admin/users/{sub}`, service-role): subject exists, `deleted_at` null,
     `banned_until` not in the future, `email_confirmed_at`/`confirmed_at` present;
  3. `401` on any invalid state; **`503`** on Auth unavailability/timeout (AbortController,
     4 s) — **never a permissive pass**; misconfigured URL/key → fail-closed unavailable;
  4. email-verified in the response comes from Auth, not the claim;
  5. service-role key travels only as request headers — never returned, never logged, never in
     the URL;
  6. PIN (HS256) JWTs are rejected at stage 1 (verifier requires ES256) and never reach the
     authority. Conversely the PIN/legacy verifier requires HS256, so an ES256 account token is
     rejected by PIN/legacy/financial APIs — mutual exclusion confirmed in code.
- **Tests (offline, `tests/accountSessionAuthority.test.js`, 20):** valid token; expired; bad
  signature/issuer/audience/alg; user deleted-after-issuance; soft-deleted; banned (and expired
  ban ignored); email unconfirmed despite a "verified" claim; Auth unavailable → 503; timeout →
  503; unconfigured provider fail-closed; 404→null; key-never-in-URL; PIN JWT always rejected
  and authority not consulted.

## 3. Behavior proven after delete / logout (revocation reality)

- **Delete / ban / email-unconfirm:** detected **immediately** — the admin check reads current
  DB truth on every request.
- **Logout / refresh revocation:** a Supabase access token is a **stateless JWT**; logout
  revokes the refresh token but an already-issued access token stays signature-valid until
  `exp`. **No immediate revocation is claimed for this case.** Maximum residual window =
  access-token TTL (`jwt_exp`; recommended `3600` s ≤ 1 h). Documented in the GoTrue checklist.

## 4. GoTrue configuration PRE/POST

- **PRE not captured / POST not applied in this session** — no Supabase Management token or
  dashboard access here. `ops/S2-7C1_GOTRUE_READINESS.md` contains the exact required staging
  values, dashboard paths, Management-API fields and payloads, and blocking/recommended class
  for: Site URL (staging only), redirect allow-list (staging callbacks, no wildcard, no prod),
  email confirmation ON, refresh-token rotation ON, access-token TTL documented, password
  policy, leaked-password protection, rate limits, CAPTCHA, SMTP decision, templates. Blocking
  rows: 1,2,3,5,7,8,14. **Owner/privileged-session action.**

## 5. Real email confirm/reset cycle

**BLOCKED.** Requires (a) a live staging signup path against GoTrue and (b) an **authorized
staging mailbox** (never the owner's email). Neither Supabase access nor a staging mailbox was
available this session. **Owner must provide:** an authorized staging test mailbox address, and
either a Supabase Management token (or dashboard operator) to run signup→confirm→login→reset
against `tdikhfeinufaahagmpjz` with the GoTrue config from §4 applied. Passwords/tokens/full
links must never be logged.

## 6. PIN / account regression

- 4 PIN actors login path, Auth V2 JWT, financial, legacy guard, service-session, account:
  **51/51** in the targeted subset; **full suite 152/152, 0 failed** (baseline was 128 before
  the +24 new account/manifest tests).
- Mutual exclusion confirmed in code (HS256 PIN ↔ ES256 account).
- **Change scope (git diff vs `0222f04`):** only `src/account/*` + account/manifest tests +
  two docs. **auth_actors, ledger, orders, storico, service sessions, and all existing
  migration SQL: untouched** (verified by name-only diff). No data inserted anywhere.

## Cleanup

No staging writes were performed (no DB access), so no fixtures to clean. The unrelated
`auth_actors_PRE_s2-6a3d` backup was left untracked and untouched.

## Fingerprint & operational counts

- No change touches `auth_actors`; the S2-6A3D PRE fingerprint `1155228afaf81d8fb5eff593f653cb26`
  (from the pre-existing backup) is unaffected by this work. Live re-verification of the
  fingerprint and of the zero-workspace/zero-invite/zero-membership counts requires DB access
  not available this session; **this change performs no INSERT/UPDATE/DELETE against any table.**

## Commit / deploy

- Commit `ef510e4` on local branch `s2-7c1/account-auth-readiness` (from `0222f04`). No upstream
  configured → **nothing pushed.**
- **Deploy NOT performed.** No Railway staging access in this session; the only Railway URL in
  the repo is the production-adjacent `fearless-reverence-*`, which must not be touched. Deploy
  of the staging backend service (baseline `165df01c`) with `ACCOUNT_HTTP_ENABLED` preserved is
  an **owner action**; verify `/health` and `/version` 200 and flags after deploy.

## Confirmation

No production touched. No real owner email used. No workspace/invite/membership/PIN created. No
git push. Baseline branch `feature/s2-6a2-service-session-backend` still at `0222f04`.
