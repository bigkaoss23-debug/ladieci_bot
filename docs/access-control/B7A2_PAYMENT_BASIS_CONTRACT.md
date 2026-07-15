# B7A2 — Payment-Basis SQL RPCs (Contract)

**Status:** B7A2A (SQL) implemented, **unwired**. Migration
`migrations/2026-07-15_b7_payment_basis_rpcs.sql` is **NOT APPLIED**. No Node
DAO/service, no router/HTTP wiring, no handler replacement. Staging-only
(`tdikhfeinufaahagmpjz`); production untouched. Builds on the B7A1 ledger
(`public.order_financial_events`) and its append-only/RLS/grant hardening. Does
not duplicate or contradict the B7A1 schema contract.

## 1. Scope split
- **B7A2A (this phase):** the two RPCs that create the single immutable **payment
  basis** for an existing order — `order_mark_paid`, `order_import_legacy_payment`.
- **Later (NOT here):** `order_refund`, `order_void`, `order_create`,
  `order_rider_deliver`, giro-ownership RPCs, rider predicates, Node layer, wiring.

## 2. Exact RPC signatures (SQL parameter names + types)
```
public.order_mark_paid(
  p_order_id       text,
  p_payment_method text,
  p_reason         text,
  p_by_actor       text,
  p_ip_hash        text,
  p_meta           jsonb,
  p_idem_scope_key text
) RETURNS jsonb

public.order_import_legacy_payment(
  p_order_id       text,
  p_amount         numeric,
  p_payment_method text,
  p_reason         text,
  p_by_actor       text,
  p_ip_hash        text,
  p_meta           jsonb,
  p_idem_scope_key text,
  p_confirm        text
) RETURNS jsonb
```
Both `SECURITY INVOKER`, `SET search_path = public, pg_temp`, no dynamic SQL,
fully-qualified refs. EXECUTE revoked from PUBLIC/anon/authenticated; granted to
`service_role` (owner retains). A service-role grant is technical execution only —
the **stored actor role** in `auth_actors` is the business authority.

## 3. Roles
- `order_mark_paid`: initiating actor stored role `admin` **or** `operator`, `active=true`; **rider denied**.
- `order_import_legacy_payment`: stored role **exactly `admin`**, `active=true`; operator + rider denied. Requires exact confirmation `IMPORT_LEGACY_PAYMENT` (no case/whitespace normalization; never stored/returned/logged).

## 4. Legacy distinction (authoritative)
The **ledger** is the authoritative pay state; `ordenes.ya_pagado`/`cobrado`/
`metodo_pago` are compatibility mirrors only. If no ledger basis exists but the
order already has `ya_pagado=true` or `cobrado=true`, `order_mark_paid` refuses
(`AUTH_LEGACY_IMPORT_REQUIRED`) — the controlled `order_import_legacy_payment` is
the only B7A2A path to establish a basis for such legacy-paid orders. Conversely
`order_import_legacy_payment` refuses (`AUTH_NOT_LEGACY_PAID`) when both flags are
false (caller must use `order_mark_paid`).

## 5. Canonical digest (generated inside SQL — never caller-supplied)
`payload_digest = lower(encode(sha256(convert_to(<canonical_jsonb>::text,'UTF8')),'hex'))`
using native `pg_catalog.sha256` (no extension schema). Canonical JSONB fields:
- Common: `order_id`, `type`, `idem_scope_key`, `by_actor`, `by_role` (stored),
  normalized `reason`, `prev_estado`, `new_estado`, `prev_pay_state`, `new_pay_state`.
- `order_mark_paid` (+): server-derived `amount`, canonical `payment_method`, `legacy=false`.
- `order_import_legacy_payment` (+): explicit validated `amount`, canonical `payment_method`, `legacy=true`.
Excluded: `ip_hash`, `meta`, `created_at`, transport/display fields. Callers supply
**only** `p_idem_scope_key` — never a digest/`p_digest`, pay-state/estado snapshots,
`by_role`, or (for `order_mark_paid`) the amount.

## 6. Idempotency & concurrency
The target order row is the serialization lock. Financial-ledger rows are immutable
and are read with plain `SELECT` without row-locking clauses.

Order of operations:
1. lock initiator + order (`FOR UPDATE`; serializes concurrent financial attempts on the order);
2. derive all canonical values + digest;
3. **same-scope check** `(order_id, type, idem_scope_key)` **before** the generic
   basis rejection, using a plain ledger `SELECT`: same digest → return the existing
   committed result with `idempotent=true` (no insert, no order update); different
   digest → `AUTH_IDEMPOTENCY_CONFLICT` (no insert/update);
4. one-basis rule: use a plain ledger `SELECT` for any existing
   `payment`/`payment_imported` row, then reject `AUTH_BASIS_EXISTS` if one exists;
5. legacy precondition; then insert + order mirror.
No automatic retry after ambiguous failure. The partial unique indexes
(`…one_payment_uq`, `…one_refund_uq`) remain the final database backstop.

## 7. Pay-state, amount & atomic order mirrors
New basis events: `prev_pay_state='unpaid'`, `new_pay_state='paid'`,
`prev_estado=new_estado=<current order.estado>`, `original_giro_id=NULL`.
- `order_mark_paid`: `amount = round(ordenes.totale, 2)` (server-derived; `>0`; caller cannot override), `legacy=false`.
- `order_import_legacy_payment`: `amount = round(p_amount, 2)` (explicit historical; `>0`), `legacy=true`.
On success (one transaction): insert the immutable event, then
`UPDATE ordenes SET ya_pagado=true, cobrado=true, metodo_pago=<canonical>` —
`estado`, `refunded`, `manual_giro_id`, and pricing fields are preserved. Insert +
update commit or roll back together; any failure leaves order and ledger unchanged.

## 8. Sanitized output
Returns exactly: `event_id`, `order_id`, `type`, `amount`, `payment_method`,
`prev_estado`, `new_estado`, `prev_pay_state`, `new_pay_state`, `legacy`,
`idempotent`, `created_at`. Never returns `payload_digest`, `ip_hash`, `meta`,
confirmation, reason, actor secrets, or a raw order payload. Idempotent replay
returns the same event identity + semantic result with `idempotent=true`.

## 9. Errors (sanitized markers)
`AUTH_ACTOR_NOT_FOUND`, `AUTH_INITIATOR_INACTIVE`, `AUTH_FORBIDDEN_ROLE`,
`AUTH_ORDER_NOT_FOUND`, `AUTH_METHOD_INVALID`, `AUTH_REASON_BLANK`,
`AUTH_IP_HASH_REQUIRED`, `AUTH_IP_HASH_TOO_LONG`, `AUTH_META_INVALID`,
`AUTH_META_TOO_LARGE`, `AUTH_META_SENSITIVE_KEY`, `AUTH_IDEM_KEY_INVALID`,
`AUTH_AMOUNT_INVALID`, `AUTH_LEGACY_IMPORT_REQUIRED`, `AUTH_NOT_LEGACY_PAID`,
`AUTH_CONFIRMATION_REQUIRED`, `AUTH_BASIS_EXISTS`, `AUTH_IDEMPOTENCY_CONFLICT`.
The future Node boundary maps these to a generic administrative-action error and
never exposes actor/order existence or raw PostgreSQL errors.

## 10. Rollback boundary
`migrations/2026-07-15_b7_payment_basis_rpcs.ROLLBACK.sql` drops only the two
RPCs and refuses (`ROLLBACK REFUSED`) if any `payment`/`payment_imported` event
exists. It never touches the ledger table, B7A1 columns/constraints/grants, order
data, or B6/auth objects, and never deletes financial events.

## 11. Status
Unwired; migration not applied. No business RPC beyond the two above; no generic
`order_insert_financial_event(...)`; no refund/void/create/rider-deliver path.

### Artifacts
- Forward: `migrations/2026-07-15_b7_payment_basis_rpcs.sql`
- Rollback: `migrations/2026-07-15_b7_payment_basis_rpcs.ROLLBACK.sql`
- Static tests: `tests/b7PaymentBasisRpcsMigration.test.js`
