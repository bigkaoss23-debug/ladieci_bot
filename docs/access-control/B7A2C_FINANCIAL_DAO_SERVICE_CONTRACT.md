# B7A2C — Financial DAO + Service Boundary (Contract)

**Status:** B7A2C (Node) implemented, **UNWIRED**. Not imported by `index.js`; no
Express route; no HTTP status mapping (that is B7A3). Offline only — no DB/staging
access in this phase. Builds on the accepted B7A2 SQL RPCs; adds **no** business logic.

## Boundary
```
HTTP handler — future B7A3
    ↓ trusted authenticated context (verified JWT claims {role, sub, sv})
Financial service — B7A2C  (src/auth/financialService.js)
    ↓ validated application input (actor = context.sub; SQL-derived fields never from body)
Financial DAO — B7A2C      (src/auth/financialDao.js)
    ↓ one exact RPC invocation (audit.sbRest service_role transport)
PostgreSQL financial RPC — authoritative business mutation
```

Explicitly:
- **SQL is the source of truth** for authorization, actor role, amount/basis, state &
  pay-state, method validation, legacy-import confirmation, idempotency digest, replay,
  refund/void eligibility, immutable event insertion, and order-mirror mutation.
- **Node does not write the ledger directly** (never `order_financial_events`, never a
  direct `ordenes` financial write, never a generic event writer).
- **Node does not calculate financial state** (no amount derivation, no digest, no
  pay-state/state decision).
- **Node does not map to HTTP yet.**
- **No automatic mutation retry** (one RPC call per action).

## RPC contract (exact committed argument names)
| Node method | SQL RPC | RPC parameter keys | SQL-authoritative | Node-validated (shape/normalize) |
|---|---|---|---|---|
| `dao.markOrderPaid` / `svc.markPaid` | `order_mark_paid` | `p_order_id, p_payment_method, p_reason, p_by_actor, p_ip_hash, p_meta, p_idem_scope_key` | amount (from `totale`), role, basis/idempotency, state | order_id, payment_method (presence), reason (trim/opt), idem key (presence), meta, ip hash; **actor = context.sub** |
| `dao.importLegacyPayment` / `svc.importLegacyPayment` | `order_import_legacy_payment` | `p_order_id, p_amount, p_payment_method, p_reason, p_by_actor, p_ip_hash, p_meta, p_idem_scope_key, p_confirm` | role (admin), confirmation exactness, basis/idempotency, legacy evidence | order_id, amount (finite number), method, reason (mandatory→SQL), confirm (verbatim), idem key, meta, ip hash; **actor = context.sub** |
| `dao.refundOrder` / `svc.refund` | `order_refund` | `p_order_id, p_reason, p_by_actor, p_ip_hash, p_meta, p_idem_scope_key` | amount & method (from basis), role (admin), already-refunded, idempotency | order_id, reason, idem key, meta, ip hash; **actor = context.sub** |
| `dao.voidOrder` / `svc.voidOrder` | `order_void` | `p_order_id, p_reason, p_by_actor, p_ip_hash, p_meta, p_idem_scope_key` | amount 0 / method NULL, source-state, pay-state, replay integrity | order_id, reason, idem key, meta, ip hash; **actor = context.sub** |

Node **never** sends `p_amount` for mark-paid/refund/void, never a payload digest, never
a role/state/pay-state/event-type/refund-marker. Only legacy-import carries `p_amount` +
`p_confirm`, per its committed signature.

## Error contract
Recognized SQL domain markers stay **distinguishable** (preserved on `FinancialDaoError.code`
/ service `{ok:false, code}`); the future handler maps them. Any unknown DB/transport
failure becomes one sanitized `FINANCIAL_INTERNAL_ERROR` (no SQL text, host, body, digest,
ip, or metadata). Service boundary rejections: `FINANCIAL_UNAUTHENTICATED` (bad/absent
context), `FINANCIAL_INVALID_REQUEST` (malformed shape / unresolvable ip / sensitive meta).

Recognized codes (exact, from the three migrations):
`AUTH_ACTOR_NOT_FOUND, AUTH_ALREADY_REFUNDED, AUTH_AMOUNT_INVALID, AUTH_BASIS_EXISTS,
AUTH_CONFIRMATION_REQUIRED, AUTH_FORBIDDEN_ROLE, AUTH_IDEMPOTENCY_CONFLICT,
AUTH_IDEM_KEY_INVALID, AUTH_INITIATOR_INACTIVE, AUTH_IP_HASH_REQUIRED, AUTH_IP_HASH_TOO_LONG,
AUTH_LEGACY_IMPORT_REQUIRED, AUTH_META_INVALID, AUTH_META_SENSITIVE_KEY, AUTH_META_TOO_LARGE,
AUTH_METHOD_INVALID, AUTH_NOT_LEGACY_PAID, AUTH_NO_PAYMENT_BASIS, AUTH_ORDER_NOT_FOUND,
AUTH_REASON_BLANK, AUTH_REFUND_BASIS_INTEGRITY, AUTH_VOID_REPLAY_INTEGRITY,
AUTH_VOID_STATE_FORBIDDEN`.

## Idempotency
Node passes the caller idempotency key to SQL and never generates a digest, compares prior
requests, caches results as authority, retries after an ambiguous failure, or silently
re-issues with a new key. A same-key SQL replay is returned intact (with its SQL-provided
`idempotent` flag and event identity). `AUTH_IDEMPOTENCY_CONFLICT` is always a failure.

## Security / logging
Actor identity comes only from the trusted context; the request body can never supply
actor/role/session-version/digest/event-type/state/pay-state/refund-marker/cancellation-ts.
Optional logging emits only `{op, order_id, by_actor, outcome, code}` — never PIN, token,
service key, metadata body, raw IP, IP hash, digest, confirmation value, reason, or amount.

## Artifacts
- DAO: `src/auth/financialDao.js`
- Service: `src/auth/financialService.js`
- Tests: `tests/financialDao.test.js`, `tests/financialService.test.js`, `tests/financialBoundaryArchitecture.test.js`
- SQL authority (unchanged this phase): `migrations/2026-07-15_b7_payment_basis_rpcs.sql`,
  `migrations/2026-07-15_b7_refund_void_rpcs.sql`, `migrations/2026-07-16_b7_void_digest_replay_fix.sql`
