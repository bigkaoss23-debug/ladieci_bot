# Legacy → V3 import contract (frozen 2026-09-27)

**The past stays past.** No pre-cutover fact ever becomes a V3 obligation, payment transaction, allocation, financial event, closeout,
reconciliation, cash count, service, business day or fiscal document. Historical legacy money is archived, read-only, admin-visible, and
outside V3 economic and fiscal authority. Only useful commercial / operational data is imported.

Artifacts: `cutover/legacy_archive_v1.sql` (the two non-V3 domains), `scripts/cutover/legacyImport.js` (archive / commercial /
fingerprint), `tests/legacyImportInertness.static.test.js` (structural guarantees). Design background:
`~/Downloads/LA_DIECI_LEGACY_TO_V3_CUTOVER_DESIGN_2026-09-27.md`.

## 1. Three domains

| Domain | Where | Written by | Read by | Economic / fiscal authority |
|---|---|---|---|---|
| LEGACY_ARCHIVE | schema `legacy_archive` (`source_rows` versioned by content, `import_batches`, `admin_daily_snapshot`, `cutover_manifest`) | the import job only (INSERT) | operator / admin-report reads over a direct connection | **never** |
| COMMERCIAL_HISTORY | schema `commercial_history` (`customer_orders`, `customer_stats` per batch, `import_lineage`) | the import job only (INSERT) | commercial features, after an explicit read path is built | **never** |
| V3_CANONICAL | schema `public` | V3 writers; the import writes ONLY `public.clientes` and `public.geo_cache` | every V3 surface | yes — post-cutover facts only |

Both legacy domains: no foreign key or key into V3; no trigger on a V3 table; append-only at statement level (UPDATE / DELETE /
TRUNCATE refused, even on zero rows); no USAGE nor privilege for `anon` / `authenticated` / `service_role`; not in PostgREST
`db-schemas`. No runtime file of the backend names them (static test).

## 2. What moves where

| Legacy data | Destination | Rule |
|---|---|---|
| every legacy table (`storico`, `serata_summary`, `backup_serata`, `clientes`, `geo_cache`, `orden_estado_logs`, `delivery_logs`, `manual_giros`, `archivio_conv`, `analisi_serata`, `config`, `conv`, `wa_msgs`, `suggerimenti`, `ordenes`) | `legacy_archive.source_rows` | one READ ONLY repeatable-read snapshot of the legacy DB per batch; values as PostgreSQL renders them (`to_jsonb`: dates stay dates, numerics exact); content-versioned (a row changed after the initial import is archived again) |
| `config` values whose key matches `KEY|TOKEN|PIN|SECRET|PASSWORD` | archived WITHOUT the value (`redacted: true`) | secrets are rotated and re-created in the V3 environment; legacy PINs are replaced by V3 auth |
| `clientes` | `public.clientes` (+ lineage) | identity = the phone in the V3 form (international digits, no `+`: how the backend looks customers up); invalid / empty phones and duplicates after normalization are skipped and recorded; a colliding alias is dropped; **V3 wins** over a row edited in V3 after its import (lineage fingerprint) |
| `geo_cache` | `public.geo_cache` (+ lineage) | identity = `direccion_key`; rows without key or zona skipped; V3 wins |
| `storico` (what each customer ordered) | `commercial_history.customer_orders` | keyed by the legacy `storico.id`; items, date, channel, delivery type, zona, `informational_total`; **no payment status, no V3 key** |
| derived per customer | `commercial_history.customer_stats` | full snapshot per batch |
| `storico` + `serata_summary` per business date | `legacy_archive.admin_daily_snapshot` | declared totals (the legacy "cassa" = sum of declared order totals), declared by method, delivery / pickup, fees, `serata_summary.cassa_totale`, coherence EQUAL / DIFFERENT / STORICO_ONLY / SUMMARY_ONLY; labelled `HISTORICAL · LEGACY · PRE-CUTOVER — declared amounts, not accounting` |
| legacy orders, payments, mirrors (`cobrado`, `ya_pagado`), open orders, credits | **nothing in V3** | archive only. A real credit known to the owner is handled outside the system or re-entered as a NEW, explicit V3 order after go-live — never by import |

Never written by the import: `ordenes`, `storico`, `order_*`, `payment_*`, `service_*`, `cash_counts`, `orden_estado_logs`, `business_*`,
`auth_*`, `config` (V3). Proven necessary (negative control): a legacy order inserted into V3 `ordenes` immediately creates an
obligation; into V3 `storico` it is refused or becomes a Pendientes / Economía item.

## 3. Cutover sequence (no giant migration on cutover day)

Prepared in advance, on the new V3 production database (installed and bootstrapped, `docs/V3_GREENFIELD_INSTALL_AND_BOOTSTRAP_CONTRACT.md`):

1. `cutover/legacy_archive_v1.sql` (refuses a database that is not at Economy 156).
2. **Initial import** while legacy keeps serving: `legacyImport.js archive --kind initial`, then `commercial --batch <id>`.
   (Optional further `--kind delta` batches on later days.)

On cutover day:

3. Close the final legacy service (intake closed, legacy close run, `serata_summary` written, legacy `ordenes` empty, no active trip or giro).
4. **Final delta**: `archive --kind final_delta --cutover-at <iso> --v3-candidate <sha>` — refused while legacy `ordenes` has rows; archives
   only what changed (content versions), writes `admin_daily_snapshot` and the one immutable `cutover_manifest` row (CUTOVER_AT, last
   legacy date, final batch, archive sha256); then `commercial --batch <final id>`.
5. Verify: `legacyImport.js fingerprint` identical to the fingerprint taken before the first import (the V3 economic tables are untouched);
   Pendientes / Economía / Caja empty of legacy; `economyChainApply.js status` = `POST_APPLY`.
6. Switch to V3 (backend candidate, WhatsApp webhook). The first V3 service is opened by the first order's intake.

Rollback before the first V3 order: point the webhook back to legacy (untouched, read-only). After the first V3 order: operational point of
no return (V3 orders must be handled manually); the chain is never rolled back for a cutover.

## 4. Proven (cutover dry-run, lab PostgreSQL 17.7, synthetic legacy data)

Initial import while legacy open → legacy continues (new orders, a changed customer, a new customer, a V3-side edit) → final delta refused
while legacy open → legacy close → final delta → inertness → first V3 service. Results: V3 economic fingerprint identical before / after
both imports; surfaces clean; archive unreadable by the three API roles and immutable (update / delete / truncate refused); secrets never
archived; V3-wins honoured; admin snapshot coherence classes exact; the first V3 service's closeout and reconciliation equal the V3 facts
only; negative control positive. Evidence: `~/Downloads/LA_DIECI_ECONOMY_FINAL_GREENFIELD_EVIDENCE_2026-09-27/phase11/`.

## 5. Open owner decisions (not blocking this contract)

- **G4 privacy — BLOCKING THE REAL IMPORT:** in the V3 schema (staging parity) `public.clientes` is readable by `anon` (policy
  `clientes_public_read`, qual `true`, SELECT granted) and `public.geo_cache` is writable by `anon`. Importing real legacy customers
  (~395 on LIVE) into that shape exposes personal data. Decide and fix (a reviewed post-156 migration revoking anon access) BEFORE the
  real commercial import; retention of personal data in the archive.
- G2: the 21 LIVE-only commits (Delivery) — see the Phase 3 classification.
- G5: which `config` keys / optional datasets (`delivery_logs`) migrate; menu parity.
- G3: the legacy fiscal authority is external (no fiscal data in the legacy DB).
