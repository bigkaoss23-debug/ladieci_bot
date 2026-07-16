# B7A3 — Protected Financial HTTP Boundary (Contract)

**Status:** B7A3 (Node HTTP) implemented, **UNWIRED**. Not imported by `index.js`; the
legacy `/api` X-Api-Key proxy and all existing routes are untouched. Offline only — no
DB/staging access. Builds on the accepted B7A2 SQL RPCs and the B7A2C financial
DAO/service; adds **no** business logic and **no** second JWT verifier.

## Boundary
```
Authenticated HTTP route (POST, prefix /api/financial)
    ↓ verified B3 auth context (jwt.verifyToken → req.authContext {role, sub, sv})
Financial HTTP handler   (src/auth/financialHttpHandlers.js)
    ↓ operation-specific sanitized body (actor from context, never body)
Financial service        (src/auth/financialService.js)
    ↓ trusted actor + validated input
Financial DAO            (src/auth/financialDao.js)
    ↓ exactly one RPC
PostgreSQL financial RPC — authoritative business mutation
```

Explicitly:
- **Handlers never call the DAO or Supabase directly.** They call exactly one financial
  **service** method per request.
- **SQL remains the financial authority** (authorization, role, amount/basis, state,
  idempotency, replay, eligibility).
- **No automatic retry** at the HTTP layer; the idempotency key is forwarded once.
- **Replay returns HTTP 200** — same as a fresh mutation; **no `201` inference** (the SQL
  result may be a replay; the handler never assumes an insertion).
- **No generic event/action endpoint**; route names are static, never client-supplied.
- **No caller-controlled actor/role/session/sub/digest/state/pay-state/amount** (refund/
  void). Import legitimately carries `amount` + `confirmation` per its SQL signature.
- **No frontend wiring** in B7A3.

**Route-layer decision:** the repository had no existing HTTP JWT middleware (the whole
Auth V2 stack is unwired offline modules). Per the handoff's "smallest convention-
compatible boundary" clause, B7A3 adds a JWT auth-context middleware that **reuses**
`jwt.verifyToken` (no second verifier) plus an additive `registerFinancialRoutes(app, deps)`.
It is **not** wired into `index.js` (consistent with B7A2C being unwired), so no existing
route behavior changes; a later wiring phase mounts it behind the accepted transport.

## Routes (exactly four, POST only)
| Operation | Method + path | Service method |
|---|---|---|
| Mark paid | `POST /api/financial/mark-paid` | `service.markPaid` |
| Import legacy payment | `POST /api/financial/import-legacy-payment` | `service.importLegacyPayment` |
| Refund | `POST /api/financial/refund` | `service.refund` |
| Void | `POST /api/financial/void` | `service.voidOrder` |

Each route chain is `[authContextMiddleware, handler]` — auth runs first, so no route is
reachable unauthenticated. No GET/PUT/PATCH/DELETE mutation route; no query-string
mutation params. OPTIONS/CORS stays with the existing app-level convention.

## Authentication / context
`Authorization: Bearer <JWT>` → `jwt.verifyToken` → `req.authContext = {role, sub, sv}`
(frozen). Missing/invalid/non-Bearer/unverifiable → sanitized **401** `{ok:false, code:
FINANCIAL_UNAUTHENTICATED}`; the handler is never reached. The trusted actor passed to the
service is `authContext.sub`. Body `actor / by_actor / role / session_version / sub /
digest / event_type / prev_estado / new_estado / prev_pay_state / new_pay_state` are never
read and can never override context. PIN / token / service key in the body are ignored.

## Request fields (operation-specific)
- **mark-paid**: `orderId, paymentMethod, reason, idempotencyKey, metadata?` — **no amount**.
- **import-legacy-payment**: `orderId, amount, paymentMethod, reason, confirmation, idempotencyKey, metadata?`.
- **refund**: `orderId, reason, idempotencyKey, metadata?` — **no amount, no method**.
- **void**: `orderId, reason, idempotencyKey, metadata?` — **no state/pay-state/amount/method/giro**.

Client IP is taken from the server-managed `req.ip` (accepted proxy model), never a
body-supplied IP / ip_hash / forwarded-for chain. Hashing/validation stay in the accepted
service + B3 `ipSecurity` layer; raw IP / ip_hash are never logged or returned.

## Success envelope
`200` `{ ok:true, result }` for any successful RPC execution (fresh **or** idempotent
replay). The handler preserves the service result verbatim (event id, `idempotent`, state);
it never recomputes state/amount, renames the event type, manufactures ids, or drops
replay identity. No secret/transport material is emitted.

## Error → HTTP mapping (centralized: `src/auth/financialHttpErrors.js`)
One table keyed off the B7A2C-exported codes; unknown/unmapped → **500** (fail closed).
- **401**: `FINANCIAL_UNAUTHENTICATED`, `AUTH_ACTOR_NOT_FOUND` (stale/unusable identity)
- **403**: `AUTH_FORBIDDEN_ROLE`, `AUTH_INITIATOR_INACTIVE`
- **404**: `AUTH_ORDER_NOT_FOUND`
- **400**: `FINANCIAL_INVALID_REQUEST`, `AUTH_AMOUNT_INVALID`, `AUTH_CONFIRMATION_REQUIRED`,
  `AUTH_IDEM_KEY_INVALID`, `AUTH_METHOD_INVALID`, `AUTH_REASON_BLANK`, `AUTH_META_INVALID`,
  `AUTH_META_TOO_LARGE`, `AUTH_META_SENSITIVE_KEY`, `AUTH_IP_HASH_REQUIRED`, `AUTH_IP_HASH_TOO_LONG`
- **409**: `AUTH_IDEMPOTENCY_CONFLICT`, `AUTH_BASIS_EXISTS`, `AUTH_LEGACY_IMPORT_REQUIRED`,
  `AUTH_NOT_LEGACY_PAID`, `AUTH_NO_PAYMENT_BASIS`, `AUTH_ALREADY_REFUNDED`,
  `AUTH_VOID_STATE_FORBIDDEN`, `AUTH_REFUND_BASIS_INTEGRITY`, `AUTH_VOID_REPLAY_INTEGRITY`
- **500**: `FINANCIAL_INTERNAL_ERROR`, any unknown code

## Error envelope
`{ ok:false, code }` only. Never SQL message/detail/hint, stack, RPC path, DB host,
function source, payload digest, service-role info, raw metadata, raw IP, IP hash, JWT
claims, actor internals, or confirmation value. `AUTH_IDEMPOTENCY_CONFLICT` maps to a
409 failure — never success.

## Artifacts
- Handlers + auth middleware + registration: `src/auth/financialHttpHandlers.js`
- Error mapping: `src/auth/financialHttpErrors.js`
- Tests: `tests/financialHttpHandlers.test.js`, `tests/financialHttpErrorMapping.test.js`, `tests/financialHttpRoutes.test.js`
- Depends on (unchanged): `src/auth/financialService.js`, `src/auth/financialDao.js`, `src/auth/jwt.js`
