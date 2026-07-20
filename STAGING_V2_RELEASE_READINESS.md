# Staging V2 Release Readiness

Date: 2026-07-20

Scope: audit-only recovery record for the current La Dieci staging source. No App Shell was implemented in this pass. No runtime, deployment, environment, database, order, Supabase, Railway, Netlify, or production state was changed.

## Audit Area

Established audit area: repository root `/Users/bigart/Downloads/ladieci-bot-access-v2`.

Evidence:
- Current Git branch: `feature/access-control-v2-staging`.
- Current HEAD before this documentation pass: `8bf86ddae70d905a5868acff74693f64f851d0df`.
- Existing root audit records found here: `FRONTEND_CURRENT_AUDIT.md`, `FRONTEND_IMPLEMENTATION_PHASES.md`, `FRONTEND_PRODUCT_SKELETON.md`, `FRONTEND_REPOSITORY_NOT_FOUND.md`, `FRONTEND_REUSE_MATRIX.md`, `FRONTEND_STORE_READINESS.md`.
- No duplicate `STAGING_V2_RELEASE_READINESS.md`, `B7_AUTH_PIN_ROLES_FINANCIAL.md`, or `TRANSFER_INDEX.md` was found under the inspected Downloads/Desktop repositories before creation.

## Live / Staging Source Map

| Area | Path | Git state | Classification | Notes |
|---|---|---|---|---|
| Staging backend / B7 source | `/Users/bigart/Downloads/ladieci-bot-access-v2` | branch `feature/access-control-v2-staging`, HEAD `8bf86dd`, remote `bigkaoss23-debug/ladieci_bot.git` | Canonical staging audit source | Contains accepted B7 auth/financial source and V2 delivery/planner reports. |
| Live backend candidate | `/Users/bigart/Downloads/ladieci-bot` | branch `main`, HEAD `1d581d8`, same remote | Live backend checkout candidate | Clean local status when inspected; do not mutate for staging work. |
| Older live/backend candidate | `/Users/bigart/Downloads/LaDiecibotV2/ladieci-bot` | branch `main`, HEAD `2437b22`, same remote | Older candidate | Needs reconciliation before reuse. |
| Historical V2 mono/source candidate | `/Users/bigart/Downloads/LaDieciBotV2-github` | branch `fix/cocina-card-pixel-grid-localhost`, HEAD `410be33`, remote `LaDieciBotV2.git` | Historical frontend/backend worktree | Dirty worktree with Cocina/frontend/backend changes and many untracked reports; do not treat as clean deploy source. |
| Frontend app source candidate | `/Users/bigart/Downloads/ladieci-app33` | no `.git` repository | Unversioned frontend source candidate | React/CRA + Netlify config present; version not verifiable. Contains live-oriented Railway/Supabase references. |
| Future commercial core | `/Users/bigart/Downloads/food-ops-core` | branch `main`, HEAD `737b34f` | Separate future repo | Not connected to staging; no database, credentials, or runtime shared. |

## Capability Readiness

| Capability | Source evidence | Staging readiness | Transfer class | Notes |
|---|---|---|---|---|
| Health/version/status endpoints | `index.js`, `FRONTEND_CURRENT_AUDIT.md` | Functional backend pattern | Reuse with adaptation | Useful for support/about/status UI. |
| PIN login v2 | `src/auth/login*.js`, B7 docs | Functionally accepted on staging with flags | Reuse with adaptation | Actor/role model is fixed to La Dieci actors. |
| JWT session freshness | `src/auth/jwt.js`, financial middleware, B7 verification | Functional for B7 financial routes | Reuse | Stale session returns 401. |
| Auth actor storage / scrypt PIN | `src/auth/dao.js`, `scrypt.js`, migrations | Functional staging foundation | Reuse with adaptation | No plaintext PIN is retained in docs. |
| Role matrix | `src/auth/authorizationContract.js`, `docs/access-control/B4_AUTHORIZATION_CONTRACT.md` | Contract complete, not fully wired to legacy runtime | Reuse as capability map | Backend enforcement must remain authoritative. |
| Routine admin PIN/session management | `src/auth/adminAccess*`, B6 contract | Source exists; UI/HTTP route still future | Reuse with adaptation | Prior staging E2E validated B7 owner session behavior, but product UI is absent. |
| Financial ledger / payment basis | B7 migrations and tests | Functional and accepted on staging after replay fix | Reuse with adaptation | Admin/owner-sensitive capability; UI not built. |
| Refund / void | B7 financial source and tests | Functional backend boundary | Reuse with adaptation | Needs commercial UX and permission wording. |
| Historical payment replay | `docs/access-control/B7A2E_PAYMENT_BASIS_REPLAY_AUDIT.md`, `8bf86dd` | Fixed in source and verified on staging | Reuse | Immutable basis replay is required invariant. |
| Legacy operational reads | `index.js`, `src/utils/readActions.js` | Functional legacy backend | Adapt | Needs typed route/API layer before commercial transfer. |
| Order creation/edit/idempotency | `src/agents/agentOrdini.js`, frontend audit docs | Functional legacy flow | Adapt | Pizza/delivery/La Dieci assumptions remain. |
| Order state machine | `src/utils/orderStateMachine.js`, state reports | Functional | Reuse with mapping | Mixed Spanish/Italian status names need i18n/domain mapping. |
| Servicio / Pedidos | legacy API + frontend candidate | Functional in historical app, not in this backend repo | Adapt | Regression not rerun in this doc-only pass. |
| Cocina | historical frontend/backend reports | Partly implemented in historical worktrees | Adapt / reconcile | Freeze/card/header work exists outside clean staging B7 verification. |
| Entregas | legacy API/front-end candidate | Functional candidate, not audited here end-to-end | Adapt | Must be retested after any shell/navigation work. |
| Repartidor | legacy API/front-end candidate | Functional candidate, not audited here end-to-end | Adapt | Rider predicates require backend enforcement wiring. |
| Dynamic menu | branch/history and `FRONTEND_REUSE_MATRIX.md` | Backend adapter work exists | Adapt | Product CRUD menu still missing. |
| Extras / notes | commits `eabea33`, `4a1dbd1`, `6fd8899` | Snapshot fixes present in history | Reuse with adaptation | Needs frontend/menu normalization. |
| Printing | no accepted staging backend evidence found | Future structure only | Future | Requires explicit design/test source before transfer. |
| Realtime | frontend candidate references Supabase realtime | Not verified | Future | Requires versioned frontend and backend policy. |
| Privacy/account deletion/export | frontend readiness docs | Not implemented | Future | Must be legal/product design plus reversible staging structure first. |
| Offline/sync | idempotency pattern only | Partial pattern | Future | Needs client queue, conflict handling, IndexedDB/service worker. |

## Recovered Pending Work

Recovered pending/deferred work records: 36.

| # | Area | Recovered item | Status / risk |
|---:|---|---|---|
| 1 | App Shell | App Shell V1/menu was requested earlier but explicitly deferred by latest instruction. | Do not implement in this pass. |
| 2 | Frontend source | `/Users/bigart/Downloads/ladieci-app33` is complete React source but not Git-versioned. | Must be versioned/reconciled before release work. |
| 3 | Frontend live mapping | Frontend local bundle hash differs from documented live bundle. | Live/staging equivalence unproven. |
| 4 | Backend source drift | Multiple backend checkouts share similar remotes with different HEADs. | Use only named staging checkout for B7 audit. |
| 5 | Historical dirty worktree | `LaDieciBotV2-github` contains dirty Cocina/frontend/backend changes. | Needs separate recovery before reuse. |
| 6 | Authorization | B4 role/capability matrix is executable but described as unwired. | Backend route enforcement gap remains for legacy actions. |
| 7 | Rider predicates | B4 stores seven rider predicate IDs but does not evaluate them. | Must fail closed when wired. |
| 8 | Admin access UI | Routine admin PIN/session APIs are not product UI. | Future Account/Security work. |
| 9 | Device sessions | No device/session screen or device model was found. | Future. |
| 10 | Session revoke UX | Backend session-version invalidation exists; product UX missing. | Future UI/route work. |
| 11 | Owner recovery UX | Bootstrap/recovery is technical, not a public owner flow. | Do not expose directly as commercial UX. |
| 12 | Financial UI | B7 financial backend is accepted; Economia UI is not built in staging source. | Future admin-only UX. |
| 13 | Payment replay | Historical replay bug was fixed and accepted. | Preserve as non-negotiable invariant. |
| 14 | Financial E2E runner | Prior B7A6D batched calls after first failure. | Future runners must be sequential/stop-aware. |
| 15 | Shadow preview endpoint | Read-only endpoint exists but earlier report says not deployed/smoked live. | Needs authenticated staging/local smoke before use. |
| 16 | Shadow live SELECT | Live read-only runner skipped because env was absent. | Needs read-only environment run. |
| 17 | Planner architecture | Spec says single coordinator/commit writer is target. | Current legacy still has multiple derivation points. |
| 18 | Manual giro real A/B | Reports found zero real manual giros in four historical snapshots. | Needs real data before confidence. |
| 19 | Semi-frozen orders | Historical snapshots lacked semi-frozen/open states. | Needs staging/live shadow sample. |
| 20 | Single vs multi-rider | Reports keep single-rider as V1 choice but product decision remains open. | Planner risk for Q5-heavy nights. |
| 21 | Soft oven threshold | 5/4 pizza soft overload needs operator confirmation. | Product decision. |
| 22 | Hard overload shift | +10 minute hard-shift needs operator confirmation. | Product decision. |
| 23 | Slot-10 promise | Precise vs 10-minute promise window remains to confirm. | Product decision. |
| 24 | Q1/Q2 dirty geo | Report suggests optional calibration for nearby zones. | Future tuning. |
| 25 | Rider-return recovery | Reports prefer real `rider_returned` observability over immediate multi-rider. | Future event/UI integration. |
| 26 | Pending giro intent | Branch/history include anchor intent validation and giro-aware warnings. | Needs reconciliation with current staging source/UI. |
| 27 | Manual giro cleanup | Orphan/delete and salida ref proxy commits exist in history. | Needs targeted regression before release. |
| 28 | Combined deliveries | Aggregation/giro sharing validated in planner tests but UI/commit path needs care. | Regression required. |
| 29 | Cocina freeze | Planner Cocina freeze metadata exists in backup branch/history. | Not part of accepted B7 verification. |
| 30 | Cocina card/header work | Historical frontend worktree has dirty Cocina card/header files. | Separate frontend recovery needed. |
| 31 | Entregas regression | Not executed in this doc-only pass. | Required before release. |
| 32 | Repartidor regression | Not executed in this doc-only pass. | Required before release. |
| 33 | Tables/open orders | Frontend audit lists ordini aperti as adaptable legacy read. | Needs typed API/auth/capability layer. |
| 34 | Dynamic menu CRUD | Backend dynamic catalogue adapter exists, but CRUD product menu is missing. | Future management feature. |
| 35 | Printing | No accepted staging V2 printing implementation found. | Future discovery/design. |
| 36 | Staging test plan | Owner/operator/rider visibility, direct unauthorized routes, logout, revoke, PIN rotation, tablet/phone viewports were not run here. | Required before App Shell/release. |

## Blockers Before Commercial Transfer

- No versioned, clean frontend release source has been confirmed.
- Legacy action authorization is not proven fully enforced across all operational routes.
- App Shell/menu/Account/Security/Device sessions are not implemented.
- Planner still carries product decisions around rider count, manual routes, semi-frozen orders, and overload policy.
- Live/staging deployment mapping is split across several local sources and must remain explicit before any deploy.

## Untested In This Pass

No HTTP, UI, DB, Supabase, Railway, Netlify, order, PIN, financial, or deploy test was run in this audit-only pass. Verification was limited to local source/document/git inspection and later markdown/diff checks.

## Final State

Staging source accepted for B7 auth/PIN/roles/financial replay documentation, not release-ready for App Shell or commercial transfer without the blockers above.
