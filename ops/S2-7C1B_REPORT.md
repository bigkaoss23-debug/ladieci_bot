# S2-7C1B — Correct token authority + complete live staging gate — REPORT

**Final status: `S2-7C1 PARTIAL — LIVE AUTH/DEPLOY GREEN, REAL EMAIL DELIVERY TEST STILL BLOCKED`**

Reference date 2026-07-23. Repo `ladieci-s2-6a2-service-session-backend`, branch
`s2-7c1/account-auth-readiness`. Baseline `feature/s2-6a2-service-session-backend` unchanged at
`0222f04`. **No production frontend, no real owner email, no git push.**

## Commits (local only, above 376edeb)

| commit | purpose |
|---|---|
| `0222f04` | baseline (S2-7C account boundary) |
| `ef510e4` | S2-7C1 authority + migration manifest |
| `376edeb` | S2-7C1 report |
| **`ede209a`** | **S2-7C1B — validate the PRESENTED bearer via `/auth/v1/user`** |
| (this report) | S2-7C1B report |

No upstream configured on the branch → nothing pushed.

## 1. Definitive bearer-verification method

`/api/account/me` now runs a two-stage contract:

1. **Local ES256/JWKS pre-filter** (`supabaseToken.js`): signature, issuer, audience, expiry,
   subject — cheap rejection of garbage / expired / wrong-alg / PIN (HS256) tokens.
2. **Canonical presented-token check** (`supabaseAccountAuthority.js`): sends the **same bearer
   the client presented** to Supabase Auth `GET /auth/v1/user`, with the **public anon key as
   the gateway apikey — the service-role key is NOT used for the normal bearer check**. GoTrue
   validates the token itself and returns the canonical user.
   - GoTrue answer is the **authority** (not the JWT claims, not an admin lookup by `sub`).
   - local `sub` must equal the returned `user.id` (else `SUBJECT_MISMATCH`).
   - email must be confirmed (`email_confirmed_at`/`confirmed_at`); account usable
     (not `deleted_at`, not `banned_until` in the future).
   - **Fail closed:** GoTrue `401/403` → HTTP **401** `account_auth_invalid`;
     timeout / 5xx / network / missing config → HTTP **503** `account_auth_unavailable`,
     **never a pass**. No permissive fallback.
3. Response `emailVerified` comes from GoTrue, not the token claim.

**Env requirement:** the boundary needs `SUPABASE_ANON_KEY` (public) for the gateway apikey.
It is **not yet set** on the staging service, so a valid Supabase token currently fail-closes
to 503 (correct, safe). The no-token and PIN-token paths return 401 *before* this step, so they
work regardless. Setting `SUPABASE_ANON_KEY` is the one config action to make the endpoint fully
functional (see §4/§7).

The service-role key was never printed or exposed; the Supabase gateway requirement (apikey
mandatory even on `/auth/v1/user`, JWKS public) was verified empirically against staging.

## 2. Logout / revocation behaviour and real TTL

A Supabase access token is a **stateless JWT**. Logout / refresh-token revocation invalidate the
**refresh** token; an already-issued **access** token stays valid until `exp`. Therefore:

- **delete / ban / email-unconfirm** → caught **immediately** (GoTrue refuses the token or
  returns an unusable record on the very next `/api/account/me`).
- **logout / refresh revocation** → **not** immediately effective for an outstanding access
  token. **Maximum residual window = access-token TTL (`jwt_exp`).** No immediate revocation is
  claimed for that case. Recommended `jwt_exp=3600` (≤ 1 h) to bound it; the exact live TTL must
  be read/confirmed in the GoTrue dashboard (owner action, §4).

## 3. Tests

- Full offline suite **149/149, 0 failed** (`node --test tests/*.test.js`).
- Rewritten `tests/accountSessionAuthority.test.js` (presented-token matrix): valid bearer;
  bad signature/issuer/audience/expiry (pre-filter); GoTrue-refused token (deleted/revoked →
  SESSION_REJECTED); `sub` mismatch; email unconfirmed; banned (and expired-ban ignored);
  soft-deleted; Auth unavailable / timeout / 5xx / network → 503; unconfigured anon key →
  fail-closed; anon apikey used and **service-role key never in the outgoing request**; token in
  header not URL; PIN JWT always 401 and authority never consulted; the same presented bearer is
  forwarded verbatim to the authority.
- Migration order guard `tests/migrationManifestOrder.test.js` retained (4 tests).

## 4. Railway / Supabase access

- **Railway CLI:** authenticated (`bigkaoss23@gmail.com`). Linked project
  `surprising-tenderness` / env "production" / service **fearless-reverence**
  (`4e481c9b-04b7-4eec-9ba9-8878667f5dd4`). The env is *named* "production" but is the
  **authorized staging** service per owner instruction; corroborated by
  `SUPABASE_URL=https://tdikhfeinufaahagmpjz.supabase.co` (staging DB). The real production
  backend in the same project is the separate `ladieci_bot` service — **not touched**.
- **Supabase dashboard (in-app browser):** **NOT authenticated** — the project URL redirected to
  the sign-in page. Credentials were not entered (prohibited). GoTrue read/config and reading the
  anon key are therefore **owner/dashboard actions**; the exact required values, paths and
  Management-API payloads are in `ops/S2-7C1_GOTRUE_READINESS.md`.

## 5. Deployment (staging)

- `railway up --service 4e481c9b… --detach` from `ede209a` → build `cbed50e7` **SUCCESS**, now
  the live deployment (previous `bc08db36`; the task baseline `165df01c` appears in the same
  service history, confirming the target).
- 4 flags **preserved**: `ACCOUNT_HTTP_ENABLED=true`, `AUTH_V2_LEGACY_GUARD_ENABLED=true`,
  `DYNAMIC_MENU_SHADOW_ENABLED=false`, `DYNAMIC_MENU_SHADOW_DEBUG_ENABLED=false`. No env variation
  was needed (already correct); none changed.
- **Live smoke:** `/health` 200; `/version` 200 (deploymentId `cbed50e7`);
  `/api/account/me` no token → **401** `account_auth_required`; PIN HS256 JWT → **401**
  `account_auth_invalid`. **No frontend deploy.**

## 6. Migration reconciliation (staging-verified)

- Manifest + guard test retained; **no rename, no SQL re-run**.
- Live staging read (service-role via `railway run`, key never printed): all six tables exist —
  `user_profiles`, `workspaces`, `workspace_memberships`, `workspace_invitations`,
  `platform_roles`, `workspace_account_audit` — **HTTP 200, count 0** each. S2-7B columns
  (`slug`, `lifecycle_status`, `commercial_status`, `invitation_kind`, `event`) resolve, so both
  structures are applied and match the manifest; the logical order **workspace foundation →
  account boundary** is proven (S2-7C's REVOKE/triggers on `user_profiles` could only apply after
  S2-7B created it). No duplicate SQL (single set of tables, zero rows).
- Trigger/function bodies (`user_profiles_guard`, append-only audit, `handle_new_auth_user`) are
  not REST-visible and were not re-verified live; their presence is implied by successful
  application. **The manifest — not filename alphabetical order — is the replay-order authority.**

## 7. GoTrue PRE/POST

- **PRE not readable / POST not applied** this session (dashboard not authenticated). Required
  staging values, dashboard paths, and Management-API payloads: `ops/S2-7C1_GOTRUE_READINESS.md`.
  Blocking items: Site URL (staging only), redirect allow-list (staging confirm/reset, no
  wildcard, no prod), email confirmation ON, refresh-token rotation ON, access-token TTL
  documented, password policy, SMTP decision. Plus **provision `SUPABASE_ANON_KEY`** on the
  staging service (read anon key from dashboard → API, set via
  `railway variables --set SUPABASE_ANON_KEY=… --skip-deploys` then redeploy).

## 8. Email delivery gate — the single remaining blocker

**BLOCKED.** No authorized staging mailbox exists. Per instruction: the owner's email was not
used, no temporary/disposable email service was used, and no address was invented. The
signup → confirm → login → reset → invalidation cycle cannot be exercised without (a) a
controlled, authorized staging mailbox and (b) GoTrue email delivery configured (§7). This is the
**only** item keeping the block at PARTIAL.

## 9. Fingerprint & operational data — invariant

- `auth_actors` live (safe columns only, no `pin_hash`): `owner/admin/sv14`,
  `operator_primary/operator/sv10`, `operator_backup/operator/sv4`, `rider/rider/sv2`; count 4;
  fingerprint `846f135e1e0d443aa81b16ef246ce045` — matches the documented post-activation state
  (the backup's `1155228…` was the *pre*-activation fingerprint). Unchanged by this block.
- This block performed **no INSERT/UPDATE/DELETE** on any table; the deploy adds a read-only
  endpoint. Ledger, orders, storico, service sessions untouched (git diff scope: `src/account/*`
  + account/manifest tests + docs).
- Mutual exclusion confirmed in code and live: PIN (HS256) ↔ account (ES256) tokens reject each
  other.

## Confirmation

No production frontend touched; the `ladieci_bot` prod service was not touched. No real owner
email used, no owner invitation created. No workspace / invitation / membership / platform-role
rows created (all count 0). No git push. Baseline branch still at `0222f04`.
