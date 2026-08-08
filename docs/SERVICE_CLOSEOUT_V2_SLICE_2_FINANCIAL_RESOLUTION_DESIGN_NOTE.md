# Post-close financial resolution — design note for Slice 2

Status: **DESIGN ONLY, not implemented.** Written during Slice 1 (persistent
closeout snapshots + incident register) per the Service Closeout V2 plan's
Step 9. No schema, RPC, or code in this note has been created.

## The confirmed gap (Slice 0)

Once an order is archived into `storico` as unpaid (`insoluto`), there is no
existing code path that can later record a payment, adjustment, or
reconciliation against it. `storico` has exactly two writers (the archive
upsert in `chiudiServizio`, and its own verify-failure rollback delete) — no
update path exists anywhere. Every financial RPC that touches
`order_financial_events` (`order_mark_paid`, `order_refund`, `order_void`,
`order_import_legacy_payment`) requires the order to still exist in
`ordenes`, and fails closed with `AUTH_ORDER_NOT_FOUND` otherwise — enforced
in SQL, not bypassable from JS.

## Non-negotiable constraints (repeated from the plan, restated as design
   inputs)

1. The original unpaid closeout snapshot (`storico` row, and now — Slice 1 —
   the `service_closeout_snapshots`/`service_incidents` rows it may be
   referenced from) must never be rewritten. The historical fact "62.50 EUR
   was outstanding at closeout" must remain true forever, independent of
   whatever happens later.
2. `order_financial_events` stays exactly as it is: immutable, append-only,
   and scoped to orders that still exist in `ordenes`. This note does not
   propose loosening that boundary.
3. The archived order's identity (`order_id`) must remain referenceable, but
   — per the precedent already set in Slice 1 (`service_incidents.order_id`)
   and in the existing schema (`order_financial_events`'s FK to `ordenes` was
   deliberately dropped, `manual_giros.original_giro_id` is FK-less by
   design) — never via an enforced foreign key back into `ordenes`, since the
   row there is gone.
4. No resurrection: the resolution must never move data back into `ordenes`,
   and must never be modeled as "reopening" the order.
5. Every resolution must be auditable: actor, role, timestamp, reason, and
   the amount/method involved, exactly like every other money-adjacent
   action in this codebase (`order_financial_events`, and now
   `service_incident_resolutions`).

## Proposed model

A new, dedicated, append-only table — **not** a mutation of `storico`, and
**not** a new row type inside `order_financial_events` (that table's own
`ofe_order_id_fk`-dropped design already assumes it will never gain new rows
for an order once archived; overloading its `type` CHECK to add a
post-archive resolution type would blur "what money moved on the live order"
with "what an admin later recorded about an archived order," which are
different facts with different audiences).

Working name: `archived_order_financial_resolutions`.

Sketch (illustrative, not final — Slice 2 should re-derive exact column types
against the schema as it exists then):

```
id                       uuid PK
service_session_id       uuid NOT NULL REFERENCES service_sessions(id) ON DELETE RESTRICT
archived_order_id        text NOT NULL          -- storico.orden_id, NO FK (same reasoning as service_incidents.order_id)
related_incident_id      uuid REFERENCES service_incidents(id) ON DELETE RESTRICT  -- nullable; links back to the
                                                                                    -- UNPAID_BALANCE_AT_CLOSE incident
                                                                                    -- that flagged this order, when one exists
resolution_type          text NOT NULL           -- e.g. 'late_payment_recorded' | 'written_off' | 'disputed_adjustment'
amount_cents             integer                 -- nullable; not every resolution_type involves money (e.g. a write-off note)
payment_method           text                    -- nullable; 'efectivo'|'tarjeta'|'bizum' when applicable, same vocabulary as order_financial_events
actor                    text NOT NULL
role                     text NOT NULL CHECK (role = 'admin')   -- same authorization boundary as service_incidents resolution
reason                   text NOT NULL
note                     text
created_at               timestamptz NOT NULL DEFAULT now()
```

Append-only (BEFORE UPDATE OR DELETE trigger, same pattern as
`order_financial_events`/`service_closeout_snapshots`/
`service_incident_resolutions`); RLS enabled, zero policies, `service_role`
SELECT/INSERT only; a `create_archived_order_financial_resolution(...)` RPC
following the exact `SECURITY INVOKER` + role='admin'-check shape
`resolve_service_incident` already established in Slice 1.

## How the two timelines stay separate

- **`storico` (and the Slice-1 `service_closeout_snapshots`)** answer: *"What
  was true when the service closed?"* — frozen forever, never touched.
- **`archived_order_financial_resolutions`** answers: *"What has anyone
  recorded about that order since?"* — an open-ended, append-only sequence of
  facts layered on top.

A future admin UI reads both and presents them together — e.g. "62.50 EUR
unpaid at close (2026-08-08) → later recorded as paid in cash on
2026-08-09 by owner, reason: customer returned to settle" — without either
row ever being edited to make the other "look right." This mirrors exactly
how Slice 1 already separates `service_incidents` (the detection fact) from
`service_incident_resolutions` (the append-only resolution history) — Slice 2
would extend the same shape one level further, into the specific case where
the "incident" is an unpaid archived order.

## Why this is scoped to Slice 2, not built now

Building this table now would be premature: it should be designed against
whatever `UNPAID_BALANCE_AT_CLOSE` incidents actually look like once Slice
2/3 start generating them for real (closeout_correlation_id conventions,
whether `financial_exposure_cents` on the incident and `amount_cents` here
can/should reconcile automatically, etc.) rather than guessed at in the
abstract. Slice 1 only had to prove the storage foundation could support this
kind of reference — `service_incidents.snapshot_id` and the FK-less
historical-identity columns already establish the pattern this note reuses.
