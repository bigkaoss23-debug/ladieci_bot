# B7 Auth, PIN, Roles, Financial Record

Date: 2026-07-20

Scope: reusable B7 capability record for the staging La Dieci source. This file records accepted state and transfer value only. It does not contain plaintext PINs, JWTs, service keys, Supabase keys, recovery secrets, or deploy credentials.

## Accepted Staging Source

- Repository: `/Users/bigart/Downloads/ladieci-bot-access-v2`.
- Branch: `feature/access-control-v2-staging`.
- Accepted source chain: `d75dcb79` -> `2ec52466` -> `8bf86dd`.
- Current accepted HEAD before this documentation pass: `8bf86ddae70d905a5868acff74693f64f851d0df`.
- Railway staging service recorded by prior verification: `fearless-reverence`, service id `4e481c9b-04b7-4eec-9ba9-8878667f5dd4`, project id `5f76bdfb-2012-4b92-ac38-5e3bde352a3b`, environment id `6ef499eb-033b-42e7-a188-6197d51bbeb3`.
- Staging domain recorded by prior verification: `https://fearless-reverence-production-80bc.up.railway.app`.
- Staging Supabase ref recorded by prior verification: `tdikhfeinufaahagmpjz`.
- Forbidden production Supabase ref: `wnswassgfuuivmfwjxsf`.
- Final staging deployment recorded by prior verification: `8f0c6944-a4a9-45be-b960-110e6e6de768`.
- Feature flags recorded as enabled on staging in prior verification: `AUTH_V2_LOGIN_HTTP_ENABLED=true`, `AUTH_V2_FINANCIAL_HTTP_ENABLED=true`.

## Auth / PIN / Roles

Functional state recorded from prior B7 closure:
- Owner/admin actor active.
- `session_version=13` after owner PIN/session work.
- `failed_count=0`, unlocked.
- `pin_hash` present.
- No known plaintext owner PIN or active JWT retained in this repo/report.

Reusable parts:
- Versioned scrypt PIN hashing and PIN policy.
- Login v2 handler and `POST /api/auth/v2/login` feature-flag wiring.
- JWT v2 issuance with role, actor, expiry, and session version.
- DB-authoritative session freshness checks.
- Session-version invalidation for stale tokens.
- Admin access service/DAO pattern for PIN rotation, revoke, active state, and unlock.
- Authorization contract metadata for admin/operator/rider/service capabilities.

Boundaries and caveats:
- Actors are fixed (`owner`, `operator_primary`, `operator_backup`, `rider`) and must not be treated as commercial multi-tenant users.
- B4 authorization contract is a reliable capability map, but legacy route enforcement is not globally proven in this record.
- B6 admin access is a backend/service pattern, not a complete account/device/session UI.
- Recovery/bootstrap is operational emergency tooling, not public owner onboarding.

## Financial

Functional state recorded from prior B7 closure:
- Financial HTTP boundary exposes four exact POST routes when the flag is enabled:
  - `/api/financial/mark-paid`
  - `/api/financial/import-legacy-payment`
  - `/api/financial/refund`
  - `/api/financial/void`
- Bearer JWT is required; legacy `X-Api-Key` alone is rejected on financial paths.
- Middleware verifies token, DB actor role/active/session freshness, and passes trusted context to service.
- SQL RPCs re-check session version under lock.
- Payment/refund/void operations are idempotency-scoped and ledger-backed.

Final financial evidence recorded from prior HTTP verification:
- Exactly 3 financial HTTP calls were made in the final minimal verification:
  - Fixture A replay returned 200/idempotent.
  - Fixture B replay returned 200/idempotent.
  - Stale JWT returned 401.
- Zero new events, zero order mutations, and zero event rewrites were observed during that final verification.
- Financial event total remained 7.

Fixture ledger state recorded:
- Fixture A: payment/refund/void, order `ANULADO`, replay original `e1bd3c05-a0cb-4bd0-bd55-30ff893de8ff`.
- Fixture B: imported payment/refund/no void, order `EN_COCINA`, paid/refunded true, replay original `8717131c-d4e6-4742-a893-4bb59cf945ad`.
- Fixture C: payment/void, order `ANULADO`, refunded false.

Historical replay invariant:
- Same-scope payment-basis replay must compare against immutable basis event snapshots, not mutable current `ordenes` state.
- Source fix: `migrations/2026-07-19_b7_payment_basis_historical_replay_fix.sql`.
- Guard hardening source: `migrations/2026-07-19_b7_payment_basis_historical_replay_fix.ROLLBACK.sql`.
- Accepted source commit: `8bf86dd`.

## Transfer Value

Use B7 as the first completed security/financial capability transfer record for a future app because it provides:
- PIN login suitable for operational roles.
- Role and capability vocabulary for future navigation.
- Session revoke/stale-token semantics.
- Admin-sensitive financial mutation boundary.
- Ledger/idempotency model for payment/refund/void correctness.
- A pattern of staging-gated rollout via exact flags.

Do not transfer directly without adaptation:
- Hardcoded actors.
- La Dieci-specific operational assumptions.
- Production/staging credentials or refs.
- Emergency recovery semantics as user-facing onboarding.
- Financial UI copy, permissions, or business workflows, which are not built here.

## Verification Status

Accepted before this documentation pass:
- B7 source accepted on staging.
- Payment-basis historical replay fixed and verified.
- Stale JWT financial rejection verified.
- Owner/admin final baseline recorded.

Not executed in this documentation pass:
- No login.
- No PIN rotation.
- No session revoke call.
- No financial HTTP call.
- No SQL apply.
- No deploy.
- No order mutation.
- No frontend/UI test.

## Reuse Summary

B7 is functionally reusable as a backend security/financial nucleus. It is not a reusable commercial app shell, user management UI, device-session product, or multi-tenant account system.
