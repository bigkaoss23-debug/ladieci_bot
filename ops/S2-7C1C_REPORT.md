# S2-7C1C — Activate & verify the valid account-token path — REPORT

**Final status: `S2-7C1 PARTIAL — VALID ACCOUNT TOKEN PATH GREEN; REAL EMAIL CONFIRMATION AND RESET DELIVERY STILL REQUIRED`**

Reference date 2026-07-23. Repo `ladieci-s2-6a2-service-session-backend`, branch
`s2-7c1/account-auth-readiness`. Baseline `feature/s2-6a2-service-session-backend` unchanged at
`0222f04`. **No production touched, no real owner email, no git push.**

## 1. Public key provenance (value never shown)

The staging **anon/publishable** key was taken from the **staging frontend's generated public
env**: `…/ladieci-app33/netlify/functions/_publicEnvGenerated.js`, co-located with
`SUPABASE_URL=https://tdikhfeinufaahagmpjz.supabase.co`. Validated programmatically without
printing the value:

- project ref = **`tdikhfeinufaahagmpjz`** (staging), not production;
- format = **`sb_publishable_…`** (publishable prefix; `sb_secret_` prefix = false) — not a
  service-role key;
- works as the gateway `apikey` on `/auth/v1/user`: a controlled request with a bogus bearer
  returned **403 "invalid JWT"** (past the gateway) instead of **401 "No API key found"**,
  proving the key is accepted for this project.

The key value was never printed to terminal, commit, report, or log. Its identity was tracked
only by a truncated SHA-256 (`afb1d604`), which matched the value stored on Railway.

## 2. Railway configuration

- Set **`SUPABASE_ANON_KEY`** on service **`fearless-reverence`** only
  (`4e481c9b-04b7-4eec-9ba9-8878667f5dd4`) via `railway variables --set-from-stdin` (value piped
  from the generated env, never on the command line) with `--skip-deploys`. Stored value SHA-256
  prefix `afb1d604` matched source.
- Preserved: `ACCOUNT_HTTP_ENABLED=true`, `AUTH_V2_LEGACY_GUARD_ENABLED=true`,
  `DYNAMIC_MENU_SHADOW_ENABLED=false`, `DYNAMIC_MENU_SHADOW_DEBUG_ENABLED=false`.
- `ladieci_bot` and every other service untouched.

## 3. Deployment

- `railway up --service 4e481c9b… --detach` pinned to branch HEAD `ed12cbc` → build
  **`c1c180e9`** SUCCESS, now the live deployment. `/health` 200; `/version` 200. No frontend
  deploy.

## 4. Valid-token end-to-end smoke (against the live staging backend) — 13/13 PASS

One `.test` fixture user created via the **Admin API** (`email_confirm=true`, no email sent, no
workspace / membership / platform role / PIN actor; a `user_profiles` row is auto-created by the
S2-7C trigger). An access token was obtained through the normal **password grant**
(`/auth/v1/token?grant_type=password`) using the publishable key.

| check | result |
|---|---|
| fixture user created (Admin API) | ✅ 200 |
| access token via password grant | ✅ 200 |
| `GET /api/account/me` valid token | ✅ **200** |
| body `userId` == fixture id | ✅ |
| body `emailVerified === true` | ✅ (from GoTrue, not the claim) |
| body `displayName === null` | ✅ |
| body `memberships === []` | ✅ |
| body `workspaces === []` | ✅ |
| no secrets in body | ✅ |
| tampered token → 401 | ✅ |
| account token → PIN endpoint `/api/financial/mark-paid` → 401 | ✅ |
| PIN (HS256) token → `/api/account/me` → 401 | ✅ |
| **user deleted → same token → 401** (`account_auth_invalid`) | ✅ |

Access tokens, passwords, and keys were never printed.

## 5. Invalidation after cancellation

After the fixture user was **deleted via the Admin API**, the still-unexpired access token was
re-presented to `GET /api/account/me` and returned **401** — GoTrue `/auth/v1/user` no longer
resolves a deleted user, so the presented-token authority rejects it **immediately**. This is
the live proof of the S2-7C1B contract: delete/ban/unconfirm are caught at once.

- **Auth unavailable → 503** is covered by the offline suite (timeout / 5xx / network simulated
  locally; deterministic; part of the 149/149 green suite). A real Auth outage was not induced
  against live staging.
- **Logout / refresh revocation** still does NOT immediately invalidate an outstanding *access*
  token (stateless JWT); residual window = access-token TTL (`jwt_exp`). No immediate revocation
  claimed for that case.

## 6. GoTrue PRE/POST

**Still owner-login-gated.** The staging Supabase dashboard was reopened in the interactive
browser and shows the **Supabase sign-in screen (email/password + hCaptcha)** — not
authenticated. Per instruction the session stopped at the login screen; no credentials were
entered and the captcha was not touched. **Owner action required:** sign in personally in the
browser, after which the GoTrue read/config proceeds (required staging values, paths and
Management-API payloads are in `ops/S2-7C1_GOTRUE_READINESS.md`: Site URL staging-only, redirect
confirm/reset staging-only, no wildcard, email confirmation ON, refresh rotation, TTL documented,
password policy, leaked-password, rate limits/CAPTCHA, SMTP). No production URL to be entered.

## 7. Cleanup

- Fixture user **deleted** (Admin API 200). Verified live: `auth.users=0`, `user_profiles=0`
  (CASCADE), `workspaces / workspace_memberships / workspace_invitations / platform_roles /
  workspace_account_audit = 0`.
- Local temp probe/smoke scripts removed from the scratchpad. Fixture password and access token
  existed only in process memory — never written to disk, repo, or logs.

## 8. Fingerprint & operational data — invariant

- `auth_actors`: 4 actors, fingerprint **`846f135e1e0d443aa81b16ef246ce045`** — unchanged.
- `ordenes=2`, `storico=28`, `service_sessions=2` — pre-existing rows; this block performed **no
  writes** to them (the fixture flow only touched `auth.users` + its auto `user_profiles`, both
  now 0).
- Mutual PIN↔account exclusion proven live (both directions 401).

## 9. Email delivery — the single remaining blocker

The real owner email was **not** used. No authorized staging mailbox is available, so the
signup-confirmation and password-reset **email delivery** steps were not exercised. This does not
block the valid-token path (green above); it is the only outstanding item. **Owner must provide a
staging mailbox they can access** (and GoTrue email delivery configured per §6) to reach
`S2-7C1 COMPLETE`.

## Confirmation

No production service touched (`ladieci_bot` untouched); no real owner email; no owner
invitation; zero workspace/invitation/membership/platform-role rows; no git push; baseline branch
still at `0222f04`. The anon/publishable key value was never exposed.
