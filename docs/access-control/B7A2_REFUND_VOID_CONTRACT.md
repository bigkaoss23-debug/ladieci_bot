# B7A2B — Refund & Void SQL RPCs (Contract)

**Status:** B7A2B (SQL) implemented, **unwired**. Migration
`migrations/2026-07-15_b7_refund_void_rpcs.sql` is **NOT APPLIED**. No Node
DAO/service, no router/HTTP wiring, no handler/state-machine change. Staging-only
(`tdikhfeinufaahagmpjz`); production untouched. Builds on the B7A1 ledger and the
B7A2A payment-basis contract; does not edit or contradict either.

## 1. Phase boundary
- B7A2B implements **only** `order_refund` and `order_void`.
- `order_rider_deliver` → **B7A3** (not B7A2C).
- Prepaid creation is atomic inside the future `order_create` (no
  `order_create → order_mark_paid` sequence).
- Fresh-auth (JWT) enforcement for refund is a **later Node/router** concern —
  **not** implemented in this SQL.

## 2. Exact RPC signatures
```
public.order_refund(
  p_order_id text, p_reason text, p_by_actor text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text
) RETURNS jsonb

public.order_void(
  p_order_id text, p_reason text, p_by_actor text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text
) RETURNS jsonb
```
Both `SECURITY INVOKER`, `SET search_path = public, pg_temp`, no dynamic SQL,
fully-qualified refs, digest via native `pg_catalog.sha256`. EXECUTE revoked from
PUBLIC/anon/authenticated; granted to `service_role` (owner retains). No caller
amount/method/state/giro-snapshot/pay-state/digest parameter.

## 3. Role policy
- `order_refund`: stored role **exactly `admin`**, `active=true`; operator + rider denied.
- `order_void`: stored role `admin` **or** `operator`, `active=true`; rider denied.
Role is read from `auth_actors` under lock; caller-supplied role is never trusted.

## 4. Ledger authority
Ledger rows are the sole authority. Basis existence, refund existence, and void
pay-state all derive from `order_financial_events`. `ordenes.refunded` is written
as a convenience mirror but **never consulted** as authority; mutable
`ya_pagado`/`cobrado`/`metodo_pago` never determine pay state. The target order row
is the serialization lock. Financial-ledger rows are immutable and are read with
plain `SELECT` without row-locking clauses. No hidden repair.

## 5. Refund — basis & amount/method
Finds exactly one immutable basis event (`payment` or `payment_imported`) with a
plain ledger `SELECT` and derives `basis_event_id`, `amount`, `payment_method` from
it. Amount/method are **never** derived from `ordenes.totale`, `descuento_*`,
`cobrado`, `ya_pagado`, or request input. No basis → `AUTH_NO_PAYMENT_BASIS`
(mutable flags are not a substitute). A second refund under a different key is
detected with a plain ledger `SELECT`, then rejected with `AUTH_ALREADY_REFUNDED`
(ledger, not `ordenes.refunded`).

## 6. Void — source states & pay-state
New void allowed only from `POR_CONFIRMAR`, `EN_COCINA`, `LISTO`, `EN_ENTREGA`
(rejected from `RETIRADO`/`COMPLETADO`/`COMPLETATO`/`CANCELADO`/`ANULADO`/unknown →
`AUTH_VOID_STATE_FORBIDDEN`). Pay state derives from plain ledger reads:
`refunded` if a refund event exists, else `paid` if a basis exists, else `unpaid`;
`prev_pay_state = new_pay_state = <that value>`. No auto-refund; a paid order
stays refundable; a previously-refunded active order may be voided
(`refunded → refunded`).

## 7. Snapshots
- Refund: `prev_estado = new_estado = order.estado`, `paid → refunded`,
  `legacy=false`, `original_giro_id=NULL`.
- Void: `prev_estado = current active state`, `new_estado='ANULADO'`, `amount=0`,
  `payment_method=NULL`, `legacy=false`, `original_giro_id = ordenes.manual_giro_id`
  (snapshot, incl. NULL; no FK).

## 8. Canonical digest fields (server-generated; never caller-supplied)
`lower(encode(sha256(convert_to(<canonical_jsonb>::text,'UTF8')),'hex'))`. Common:
`order_id, type, idem_scope_key, by_actor, by_role, reason, prev_estado, new_estado,
prev_pay_state, new_pay_state`. Refund adds `basis_event_id, amount,
payment_method, legacy=false`. Void adds `amount=0, payment_method=NULL,
original_giro_id, legacy=false`.
Excluded: `ip_hash`, `meta`, `created_at`, mutable order total, mutable payment flags.
Reason is included in the digest (never returned; never auto-copied into metadata).

### 8a. Void amount canonicalization (corrective — `2026-07-16`)
A void's amount is a **fixed business constant of exactly zero**, and its
canonical digest value is always the **JSON number literal `0`** (`{"amount": 0}`).
The ledger column `order_financial_events.amount` is `numeric(10,2)`; the database
may **display/serialize** the stored value as `0.00`, but digest generation must
**never inherit that database numeric display scale**. Both the fresh-insert canon
and the same-scope replay-reconstruction canon serialize the void amount as literal
`0` (and method as literal `NULL`, `legacy` as literal `false`) so the two SHA-256
digests are byte-identical; using `v_existing.amount` (which renders `0.00`) in the
replay canon is forbidden. Before returning an existing-event replay the function
**fails closed** (`AUTH_VOID_REPLAY_INTEGRITY`) unless the stored row is a genuine
void shape: `type='void'`, `amount=0`, `payment_method IS NULL`, `legacy=false`,
`new_estado='ANULADO'`, `prev_pay_state = new_pay_state`. The refund/payment digest
contract is unchanged (their non-zero `numeric(10,2)` amounts are built identically
on both paths and are unaffected).

## 9. Replay-after-mutation design (critical)
Both operations mutate the state their original digest was built from. On a
same-scope hit `(order_id, type, idem_scope_key)`, the candidate digest is
**reconstructed from the EXISTING event's immutable snapshots** (`prev_estado`,
`new_estado`, `prev_pay_state`, `new_pay_state`, `original_giro_id`) plus the
current normalized `reason`/`by_actor`/`by_role`. For refund replay, the same-scope branch first resolves the immutable
payment basis with a plain ledger `SELECT`, verifies its amount/method match the
existing refund event, and includes that basis event UUID in the replay digest. It
is **never** recomputed from the already-mutated current order state and never uses
metadata, request input, or mutable order fields as the basis identity. Same digest
→ return the existing event (`idempotent=true`, no insert/update); different digest
→ `AUTH_IDEMPOTENCY_CONFLICT`. Missing or mismatched basis during replay fails
closed with `AUTH_REFUND_BASIS_INTEGRITY`. The same-scope branch runs **before**
already-refunded (refund) and before the state rejection (void), so a committed
void replays even though the order is already `ANULADO`.

## 10. Locking / concurrency
Consistent lock order (shared with B7A2A): (1) initiating actor row, (2) target
order row. The order `FOR UPDATE` lock serializes all financial operations on that
order. Relevant immutable ledger rows (basis, same-scope event, existing refund
row, void pay-state row) are read afterward with plain `SELECT`: one concurrent
refund wins, the other becomes idempotent replay or `AUTH_ALREADY_REFUNDED`;
concurrent voids yield at most one real void; void and refund serialize. Partial
unique indexes are the final integrity backstop. No automatic retry; no split mutation.

## 11. Atomic order updates
- Refund: `UPDATE ordenes SET refunded=true` — estado, `ya_pagado`/`cobrado`,
  `metodo_pago`, `manual_giro_id`, pricing, and cancellation timestamps preserved.
  Refund does not reopen/complete/cancel/void.
- Void: `UPDATE ordenes SET estado='ANULADO', cancelado_at=now()` — `manual_giro_id`,
  payment flags, `metodo_pago`, `refunded`, pricing, delivery data retained.
Event insert + order update are one transaction (commit/rollback together).

## 12. Sanitized output
`{event_id, order_id, type, amount, payment_method, prev_estado, new_estado,
prev_pay_state, new_pay_state, legacy, original_giro_id, idempotent, created_at}`.
Never returns reason, payload_digest, ip_hash, meta, actor role, basis payload, or
raw order. Refund's `original_giro_id` is NULL. Idempotent replay returns the same
event identity + original snapshots.

## 13. Errors (sanitized markers)
`AUTH_ACTOR_NOT_FOUND`, `AUTH_INITIATOR_INACTIVE`, `AUTH_FORBIDDEN_ROLE`,
`AUTH_ORDER_NOT_FOUND`, `AUTH_REASON_BLANK`, `AUTH_IP_HASH_REQUIRED`,
`AUTH_IP_HASH_TOO_LONG`, `AUTH_META_INVALID`, `AUTH_META_TOO_LARGE`,
`AUTH_META_SENSITIVE_KEY`, `AUTH_IDEM_KEY_INVALID`, `AUTH_NO_PAYMENT_BASIS`,
`AUTH_REFUND_BASIS_INTEGRITY`, `AUTH_ALREADY_REFUNDED`,
`AUTH_VOID_STATE_FORBIDDEN`, `AUTH_IDEMPOTENCY_CONFLICT`. The future Node boundary
maps these to a generic error; PostgreSQL rows/secrets are never leaked.

## 14. Rollback boundary
`…ROLLBACK.sql` drops only the two RPCs and refuses (`ROLLBACK REFUSED`) if any
`refund`/`void` event exists. Never deletes evidence, resets `refunded`, rewrites
`ANULADO`, clears cancellation timestamps, or touches B7A1/B7A2A/auth/giro objects
or ledger grants.

## 15. Status
Unwired; migration not applied. No business RPC beyond the two above; no generic
`order_insert_financial_event(...)`; no order_create/rider-deliver/payment/import.

### Artifacts
- Forward: `migrations/2026-07-15_b7_refund_void_rpcs.sql`
- Rollback: `migrations/2026-07-15_b7_refund_void_rpcs.ROLLBACK.sql`
- Static tests: `tests/b7RefundVoidRpcsMigration.test.js`

### Corrective artifacts — order_void replay digest fix (`2026-07-16`)
The original B7A2B migration above is **not edited or reapplied**; the `order_void`
replay-digest fix (§8a) ships as a separate `CREATE OR REPLACE` corrective:
- Forward: `migrations/2026-07-16_b7_void_digest_replay_fix.sql`
- Rollback: `migrations/2026-07-16_b7_void_digest_replay_fix.ROLLBACK.sql` (refuses while any `void` event exists)
- Static tests: `tests/b7VoidDigestReplayFixMigration.test.js`
