# Staging — immutable test residues

**Environment:** Supabase staging `tdikhfeinufaahagmpjz`. Never production.
**Test date:** 2026-07-22 (block S2-6A3B lifecycle smoke).
**Status:** permanent by design. Registered here instead of deleted.

## What is recorded

Four rows survive the S2-6A3B smoke cleanup: two service sessions and two ledger
events. Everything else created by that smoke (orders, archive rows, summaries,
session audit) was removed.

| Kind | Reference | Detail |
|---|---|---|
| Service session | `616b7773…` | closed, business date 2026-07-22, opened/closed by `owner`, source `s2-6a3b-smoke` |
| Service session | `3665f8a0…` | closed, business date 2026-07-22, opened/closed by `owner`, source `s2-6a3b-smoke` |
| Ledger event | idem key `s2smoke-lunch-pay-1` | `payment`, amount 20.00, attached to session `616b7773…` |
| Ledger event | idem key `s2smoke-dinner-pay-1` | `payment`, amount 42.00, attached to session `3665f8a0…` |

## Why they are permanent

`order_financial_events` is append-only: the `order_financial_events_append_only`
trigger raises unconditionally on UPDATE and DELETE, with no flag or bypass. The two
synthetic payments therefore cannot be removed. Their `service_session_id` foreign
key to `service_sessions` is `ON DELETE RESTRICT`, so the two sessions that own them
cannot be removed either.

Deleting them would require disabling a financial-integrity control. That is not done,
and must not be done.

## Rules

1. **These are not real operational data.** No customer, no real money, no real
   service. The amounts are synthetic and belong to no accounting period.
2. **Do not delete and do not modify** either the sessions or the events, by any
   means — no trigger disable, no `ALTER TABLE ... DISABLE TRIGGER`, no direct
   catalogue edit. The append-only guarantee is worth more than a clean row count.
3. Any report, reconciliation or export that treats staging figures as real must
   exclude the two idem keys above.
4. Both sessions are `closed`; the lifecycle pointer (`service_session_state`) holds
   no reference to them, so no closeout, UI view or operator payload can surface them.

## Policy for future smoke tests

Smoke tests on shared staging **must not create financial events**. Lifecycle
coverage (open → closing → closed, session containment, midnight behaviour,
idempotent close) is fully exercisable with orders and archive rows alone, all of
which are deletable. Payments, refunds and voids write to an immutable ledger and
leave residue that can never be cleaned up.

If a payment path genuinely needs live coverage, use a disposable database
(the local PostgreSQL 17 rehearsal harness), not shared staging.
