# Service session identity contract

`service_sessions.id` is the sole service identity. `business_date` is display and
administrative aggregation metadata only. It never selects an operator closeout.

The singleton `service_session_state` row is an explicit lifecycle pointer. It
references either the active session (`current_session_id`) or the session closed
by the lifecycle most recently (`recent_closed_session_id`). Consumers must never
replace these pointers with `ORDER BY opened_at`, a date, or a lunch/dinner window.

Lifecycle transitions are `open -> closing -> closed`. A partial unique index and
transaction advisory lock prevent multiple active sessions. Opening after close
always creates a new UUID, including on the same business date. Midnight has no
effect on identity; the opening transaction fixes `business_date` in Europe/Madrid.

Orders are assigned by a database trigger to the current open session. A supplied
different ID is rejected and the ID is immutable. Archive rows and financial events
preserve the same UUID. Manual and automatic close call the same lifecycle.

## Legacy data plan

- Rows already bearing a session UUID can be migrated with certainty only when the
  referenced session and all related summary/ledger rows agree.
- Pre-identity data may be assigned only from external, auditable evidence proving
  exact opening/closing boundaries and one-to-one membership.
- A date, order number, timestamp proximity, or “latest row” is insufficient when
  multiple services may occur in one day.
- Ambiguous rows remain `service_session_id IS NULL` and are classified
  `legacy/unassigned`. This migration intentionally performs no backfill.
