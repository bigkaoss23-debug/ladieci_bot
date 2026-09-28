# FISCAL PREREQUISITES V1 — P1: IMMUTABLE ACCEPTED-SALE EVIDENCE — CONTRACT (layer 170, 2026-09-28)

Post-freeze layer **170** (`migrations/post_freeze/2026-09-28_fiscal_prereq_sale_evidence_v1_layer_170.sql` + `.ROLLBACK.sql`), applied only
by `scripts/postFreezeLayerApply.js` (`docs/POST_FREEZE_LAYERS_CONTRACT.md`). Design authority: `LA_DIECI_FISCAL_PREREQUISITES_V1_DESIGN_2026-09-28.md`
§3, approved with conditions as DP-1.

**This is commercial evidence, not a fiscal document.** No tax rate, treatment, invoice number, series, QR, hash chain or AEAT concept exists
in this layer. A later fiscal document references one exact revision (`composition_revisions.id` + `basis_digest`).

## 1. Scope

Generic orders only (Delivery = `DOMICILIO`, pickup = `RITIRO`: `ordenes.table_session_id IS NULL`). Mesa orders already have immutable per-unit
evidence (`table_order_lines`) and are excluded by the trigger `WHEN` clause.

## 2. Objects

Schema `sale_evidence` (owner `postgres`, RLS on every table with **no policy**, `service_role` SELECT only, no write grant to anyone, not in
any publication, not usable by `anon` / `authenticated`):

| Object | Role |
|---|---|
| `composition_revisions` | one immutable accepted composition of one order; `UNIQUE (order_uid, revision)`; deterministic `id = md5('sale_evidence.revision.v1\|order_uid\|revision')::uuid` |
| `composition_lines` | its lines, parsed from the item as recorded (never from the menu); deterministic `id = md5('sale_evidence.line.v1\|order_uid\|revision\|line_index')::uuid` |
| `capture_epochs` | attach / detach history (1 ATTACHED FRESH, 2 DETACHED, 3 ATTACHED REATTACH, …) |
| `history_gap_markers` | orders whose history this layer does **not** prove — a statement of absence, never evidence |
| `capture_composition_v1()` | the capture: `SECURITY DEFINER`, owner `postgres`, `search_path = pg_catalog, pg_temp`, EXECUTE revoked from everyone |
| `basis_digest_v1(...)`, `evidence_digest_v1(row)`, `verify_revision_v1(id)` | integrity functions (service_role EXECUTE) |
| `parse_line_v1`, `json_cents_v1`, `numeric_cents_v1`, `json_positive_int_v1`, `jsonb_value_canonical_v1` | pure parsers |
| guard triggers | append-only (UPDATE / DELETE / TRUNCATE refused for every role, owner included); INSERT into revisions / lines only from inside the capture (trigger depth ≥ 2, own txid, attached epoch); epochs strictly alternate; markers only in the attach transaction |
| `ordenes_zzz_sale_evidence_capture_ins_v1` | `AFTER INSERT ON public.ordenes FOR EACH ROW WHEN (NEW.table_session_id IS NULL)` |
| `ordenes_zzz_sale_evidence_capture_upd_v1` | `AFTER UPDATE OF items, totale, delivery_fee, descuento_tipo, descuento_valor, descuento_importe, tipo_consegna` … `WHEN (generic AND any of the seven IS DISTINCT)` |

No Economy function, table, constraint, grant or existing trigger is created, replaced, altered or dropped (static test).

## 3. The capture predicate (when a new version is written)

1. **Creation** — every accepted `INSERT` of a generic order → revision 1, `ORDER_CREATED`, `chain_origin = CAPTURED_AT_CREATION`.
2. **Edit** — the `UPDATE` trigger fires only when one of the **seven editor basis columns** (exactly the Economy's `EDITOR_BASIS_FIELDS` /
   153 `v_basis`) is `IS DISTINCT` (the same rule as the Economy's own paid guard and basis lock). Inside, a revision is written only when the
   **value-level basis digest** of the new row differs from the order's last revision (or, for an order without revision, from the OLD row).
   * value level = numbers compared by value (`21.50` = `21.5`), JSON key order irrelevant, `NULL` items = `[]`, `''` text = `NULL`;
   * so a representation-only rewrite, an editor call that resends the same basis (the Modificar modal does), `hora` / `nota` / estado /
     `llegado` / `repartidor` / driver-schedule / payment-mirror updates write **nothing**.
3. Everything else never writes: payments, refunds, commercial adjustments, cancellations, post-close resolutions, rider trips, Finalizar
   (none of them changes a basis column — they revise the obligation or the state). Their facts stay Economy-owned.
4. Intermediate updates inside one logical operation: the only one in the code is `order_initial_payment_v1` (paid-at-creation), which updates
   `initial_payment_intent` / payment mirrors — not a basis column — so the creation produces exactly one revision.

`basis_digest_v1` = sha256 over `["sale_evidence.basis.v1", canonical(items), totale, delivery_fee, descuento_tipo, descuento_valor,
descuento_importe, tipo_consegna]` (trimmed numerics). It is recomputable from a live `ordenes` row and from the raw values stored on every
revision.

## 4. Atomicity and authority

* Same statement, same transaction as the accepted create / edit. PostgreSQL fires same-event triggers in name order; every Economy AFTER trigger
  of `ordenes` sorts before `ordenes_zzz_…` (checked by the migration guard and post-condition), so the capture sees the obligation revision
  and the paid-at-creation payment of its own statement.
* A refused write (N-5 paid guard, 126 basis lock, 151 gate, 153 compare-and-set, app-level refusals) never reaches the capture: **no version**.
* A rolled-back transaction takes the version with it: **no version**.
* An infrastructure failure of the capture raises and aborts the order write: **no Economy write without evidence** (proved in the lab by
  fault injection: order, entity, obligation, payment and event all absent).
* The capture never refuses for **content**: unparseable amounts, unknown fulfilment, non-canonical items are stored with
  `parse_status = INVALID` and named `parse_issues`; the Economy write proceeds. A later fiscal use BLOCKS such a revision.
* A revision is authoritative immutable evidence of what was accepted from its capture instant. It becomes the *fiscal* authority only when a
  future Fiscal Core document pins it.

## 5. What each revision records

Identity / versioning: `order_uid` (permanent), `revision` (1, 2, 3 … gapless per order), `capture_kind`, `chain_origin`, `capture_epoch_no`,
`display_order_id` (label only), `workspace_id`, `sale_service_session_id`.
Composition: `fulfilment` (`RITIRO` / `DOMICILIO` / `UNKNOWN`) + raw value, `channel_raw`, `items_raw` (the stored `ordenes.items`, verbatim),
`line_count`, `lines_total_cents`, `delivery_fee_raw` / `_cents` (the amount stored on the order, never the code constant),
`discount_type_raw`, `discount_value_raw`, `discount_amount_raw` / `discount_cents`, `order_total_raw` / `_cents`,
`composition_net_cents` (lines + fee − discount), `composition_consistent` (= order total).
Lines: `line_index`, `item_raw`, `snapshot_version`, `legacy_id` / `product_id` / `legacy_key` / `official_number` **as recorded** (staging items
carry `legacyId` only; nothing is looked up), `custom`, `custom_base_id`, `classic_name`, `fantasy_name`, `category_label` (a display label,
never a tax key), `quantity`, `base_unit_cents`, `extras_unit_cents`, `final_unit_cents`, `line_total_cents`, `extras [{index,key,name,unitCents,quantity}]`.
Obligation link: `obligation_id`, `obligation_revision`, `obligation_source`, `obligation_gross_cents`, `obligation_matches_total` — the highest
obligation revision of the order visible in the capturing transaction (the obligation triggers of the same statement have run). The Economy ledger
is referenced, never duplicated.
Provenance: `writer_path` (`ORDER_INSERT` / `ORDER_EDITOR_V1` / `OTHER_UPDATE`), `request_role`, `estado_at_capture`,
`paid_evidence_at_capture` (the N-5 predicate, informational), `tx_started_at` (Economy clock), `captured_at`, `txid`.
Integrity: `basis_digest`, `evidence_digest` (over the stored revision and its stored lines), `parse_status`, `parse_issues`, `observations`.
No PII (no name / phone / address / customer id).

## 6. Historical orders — no fake back-fill

* The attach transaction writes **no** revision (post-condition). Every generic order that exists at attach time is registered in
  `history_gap_markers` with reason `ORDER_PREDATES_CAPTURE` — it has no authoritative creation evidence and must stay INCOMPLETE / BLOCKED for a
  later Fiscal Candidate.
* A later accepted edit of such an order is captured as revision 1 `ACCEPTED_EDIT` with `chain_origin = CREATION_NOT_CAPTURED`.
* Detach (rollback) + re-attach: the re-attach marks `CREATED_WHILE_DETACHED` (no revision at all) and `BASIS_CHANGED_WHILE_DETACHED` (live
  basis ≠ last revision). A change that was reverted while detached cannot be seen; the DETACHED epoch itself is on record.
* Clean cut: the attach takes `SHARE ROW EXCLUSIVE` on `ordenes` first and holds it to COMMIT — every order committed before is marked, every
  order written after fires the triggers.

## 7. Locks

The capture takes **no row lock** and the layer has **no foreign key to an Economy table**; it only reads `order_entities`, `order_obligations`,
`order_financial_events`, `payment_allocations`, `payment_transactions`. Revision numbers are serialized by the `ordenes` row lock the writing
`UPDATE` already holds; `UNIQUE (order_uid, revision)` turns any unknown concurrent path into a failure. A lab negative control shows why: the
same capture with a `KEY SHARE` on `order_entities` (what a foreign key would take) deadlocks against a payment; the certified capture does not.
The attach / detach take only the `ordenes` table lock, first, so they cannot join a deadlock cycle (`lock_timeout` 15 s).

## 8. Rollback = DETACH

`postFreezeLayerApply.js rollback --layer 170 --target <id> --ack DETACH_SALE_EVIDENCE_CAPTURE_ACCEPT_EVIDENCE_GAP`: drops the two triggers and
the capture function, records a DETACHED epoch, **keeps every table and row**. Re-apply = re-attach (same forward file, from the exact DETACHED
state). Point of no return: the first fiscal document that references a revision (future Fiscal Core); from then on, detach is prohibited in
production.

## 9. For the future Fiscal Candidate (contract V1.1, not implemented here)

* OBSERVATION: latest revision `basis_digest` = `basis_digest_v1` of the live row read in the same snapshot, else BLOCKED
  (`COMPOSITION_CAPTURE_MISMATCH`, explained or not by a gap marker).
* A generic order with no revision → marker present ⇒ INCOMPLETE / UNSAFE (no authoritative evidence); no marker ⇒ BLOCKED (`COMPOSITION_REVISION_MISSING`).
* `parse_status = INVALID` ⇒ BLOCKED (`COMPOSITION_REVISION_PARSE_INVALID`).
* `paid_evidence_at_capture` on an edit ⇒ WARNING `COMPOSITION_CHANGED_AFTER_PAYMENT`.
