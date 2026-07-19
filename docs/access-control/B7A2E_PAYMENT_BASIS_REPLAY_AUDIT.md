# B7A2E — Payment-Basis Historical Replay Audit

**Date:** 2026-07-19
**Scope:** read-only staging root-cause analysis plus offline source correction.
**Staging ref:** `tdikhfeinufaahagmpjz` / Railway service `fearless-reverence`.

No staging mutation was performed for this audit: no login, no PIN change, no
financial RPC/HTTP mutation, no flag activation, no SQL apply, and no deploy.

## Finding
The guarded `order_mark_paid` and `order_import_legacy_payment` definitions from
`migrations/2026-07-17_b7_financial_session_version_guard.sql` perform the
same-scope ledger lookup before generic `AUTH_BASIS_EXISTS`, but they compute the
comparison digest before that lookup from mutable `public.ordenes` fields:
`prev_estado = v_ord.estado` and `new_estado = v_ord.estado`.

That is correct for a fresh payment-basis insert, but incorrect for historical
replay. Once a later void/refund changes the order state, a same-key replay must
compare against the immutable basis event snapshots, not the current order row.

## Evidence
- B7A6D recovered failure code: `AUTH_IDEMPOTENCY_CONFLICT`.
- Fixture A basis event:
  - `order_id`: `B7A2_E2E_A`
  - event id `e1bd3c05-a0cb-4bd0-bd55-30ff893de8ff`
  - type `payment`
  - stored snapshots `prev_estado = EN_COCINA`, `new_estado = EN_COCINA`
  - current order state `ANULADO`
  - stored digest prefix `33ef071fb6a5852e`
  - local Postgres-jsonb-compatible recomputation from immutable event snapshots
    matched the stored digest prefix `33ef071fb6a5852e`
  - recomputation with current order snapshots produced prefix `f94f8ecbf97896fb`
- Fixture B latent proof:
  - `order_id`: `B7A2_E2E_B`
  - event id `8717131c-d4e6-4742-a893-4bb59cf945ad`
  - type `payment_imported`
  - stored snapshots `prev_estado = EN_COCINA`, `new_estado = EN_COCINA`
  - current order state is still `EN_COCINA`, so immutable and current recomputes
    currently match prefix `8f3830dafc252089`
  - the same mutable-order replay bug would surface if this order state later
    diverges from the immutable basis snapshots.

## Offline Correction
`migrations/2026-07-19_b7_payment_basis_historical_replay_fix.sql` replaces only
the guarded payment-basis RPCs. Same-scope replay now:
- runs before generic basis rejection;
- validates the existing event is a coherent payment basis shape;
- rebuilds replay digests from `v_existing.prev_estado`, `v_existing.new_estado`,
  `v_existing.prev_pay_state`, and `v_existing.new_pay_state`;
- uses `v_existing.amount` for `order_mark_paid` replay;
- uses current normalized request amount for `order_import_legacy_payment` replay,
  so changed historical amount remains an idempotency conflict;
- preserves fresh insert semantics based on the locked order row.

Rollback
`migrations/2026-07-19_b7_payment_basis_historical_replay_fix.ROLLBACK.sql`
restores the B7A2D guarded baseline only after an explicit session setting and
does not delete or rewrite financial evidence.

## B7A6D Procedural Defect
B7A6D call 1 failed, but calls 2-10 had already completed before stop handling
could prevent them. Future staging E2E runners for this surface must execute one
call, inspect and persist the exact response/evidence, then decide whether to
continue. Do not prelaunch a batch of financial calls.
