# Transfer Index

Date: 2026-07-20

Purpose: single index for reusable capability transfer records recovered from the La Dieci staging source. This is documentation only; it does not connect staging to `food-ops-core`, does not share databases, credentials, or runtime, and does not authorize deployment.

## Completed Transfer Records

| ID | Capability | Source record | Source state | Transfer status | Notes |
|---|---|---|---|---|---|
| B7 | Auth/PIN/roles/financial ledger | `B7_AUTH_PIN_ROLES_FINANCIAL.md` | branch `feature/access-control-v2-staging`, accepted source `8bf86dd` | Completed backend capability record | Reusable as backend nucleus; not a commercial shell or multi-tenant account system. |

## Readiness Records

| Record | Purpose |
|---|---|
| `STAGING_V2_RELEASE_READINESS.md` | Staging V2 readiness, blockers, recovered pending work, live/staging source map. |
| `B7_AUTH_PIN_ROLES_FINANCIAL.md` | Accepted B7 auth/PIN/roles/financial baseline and transfer constraints. |

## Strategy

- Keep staging La Dieci as a real laboratory for operational patterns, but isolate it from `food-ops-core`.
- Transfer capability patterns, contracts, tests, and invariants; do not transfer secrets, live refs, hardcoded actors, or deployment state.
- Treat B7 as the first completed capability transfer because it has a verified backend boundary and clear security invariants.
- Treat frontend, App Shell, device sessions, privacy, onboarding, billing, dynamic menu CRUD, printing, offline sync, and multi-tenant structure as future product work.
- Before any App Shell implementation, reconcile the unversioned frontend source and decide the authoritative staging frontend branch/source.

## Non-Transferable Current Assumptions

- La Dieci production Supabase ref `wnswassgfuuivmfwjxsf`.
- Staging Supabase ref `tdikhfeinufaahagmpjz`.
- Railway service/project/environment identifiers.
- Hardcoded actor names.
- Hardcoded menu/local configuration.
- WhatsApp-first operational flow.
- Emergency owner recovery as a user-facing account flow.

## Next Transfer Candidates

| Candidate | Condition before transfer |
|---|---|
| Delivery planner/shadow preview | Run authenticated read-only staging smoke, collect real manual giro/semi-frozen samples, settle rider-count policy. |
| Order state machine | Normalize status names and prove backend authorization on each route. |
| Dynamic menu | Confirm clean staging source and define CRUD/API contract. |
| Frontend operational flows | Put `/Users/bigart/Downloads/ladieci-app33` or replacement frontend into clean Git control and map to live/staging. |
| Account/security UI | Build only after backend route enforcement, session revoke, device/session model, and privacy deletion/export policy are defined. |
