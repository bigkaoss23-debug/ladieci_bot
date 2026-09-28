# V3 greenfield install and business bootstrap — contract (2026-09-27)

How a NEW La Dieci V3 database is built, from an empty Supabase project to a database ready for its first order, without depending on
staging and without copying any staging row. Deployment of the Economy chain itself: `docs/ECONOMY_139_156_ROLLOUT_CONTRACT.md`.
Legacy data: `docs/LEGACY_IMPORT_CONTRACT.md`.

## 1. Four layers, never mixed

| Layer | What | Owner / source | Created by |
|---|---|---|---|
| PLATFORM_PREREQUISITES | roles `anon` / `authenticated` / `service_role` (BYPASSRLS) / `authenticator`; `postgres` (not superuser, BYPASSRLS, member of the API roles); schema `extensions` with `pgcrypto`; `auth.users` + `auth.uid()`; publication `supabase_realtime`; `supabase_migrations.schema_migrations`; the default privileges of schema `public` | Supabase | the Supabase project (lab: `ci/greenfield/supabase_platform_emulation.lab.sql`, NEVER on a Supabase project) |
| LA_DIECI_V3_SCHEMA | the structural state at ledger tip 138: 3 schemas, 62 tables, 163 functions, 7 sequences, constraints, indexes, triggers (incl. `on_auth_user_created` on `auth.users`), RLS + 17 policies, privileges, comments, realtime membership (`conv`, `ordenes`, `wa_msgs`), the 3 structural singletons and the dispatch lock anchor | this repository | `migrations/baseline/2026-09-27_v3_greenfield_baseline_tip138.sql` via `scripts/economyChainApply.js install-greenfield` |
| ECONOMY 139 → 156 | the certified chain | this repository | `scripts/economyChainApply.js` (same run) |
| BUSINESS BOOTSTRAP | workspace, owner membership, the four canonical actors; then (in the app) PINs, access users, tables, menu, configuration; then (cutover) legacy commercial import | the owner | `scripts/v3BusinessBootstrap.js`, then the product's own screens / RPCs |

The baseline's guard checks every platform prerequisite and refuses a database that lacks one; it never creates a platform object.

## 2. The schema baseline

**Source.** The read-only catalog of staging (`tdikhfeinufaahagmpjz`) at ledger tip 138, extracted on 2026-09-27 with the queries of
`scripts/v3GreenfieldBaseline.js sql …` (plus two read-only queries for comments, the platform trigger, replica identity, persistence,
reloptions, collations: all defaults). `catalog-from-snapshot` sanitizes it into `migrations/baseline/catalog_tip138/`: structure only —
the staging ledger, the Supabase registry, row counts and the platform default ACLs are dropped.

**Generation.** `node scripts/v3GreenfieldBaseline.js generate migrations/baseline/catalog_tip138 <out>`; `verify` regenerates and
byte-compares; `pin` records `migrations/baseline/v3_greenfield_baseline_tip138.fingerprint.json` (baseline sha256, catalog file sha256s,
normalized catalog fingerprint `8cee65e4…`). The file is one transaction; function bodies are byte-exact `pg_get_functiondef` output and
every body is re-checked by md5 in the file's own post-condition (163 / 163).

**What it contains besides structure** (the only rows):

| Row | Value | Why |
|---|---|---|
| `service_session_state` | one row, column defaults (pointers NULL) | structural singleton (lifecycle pointer, `FOR SHARE` / `FOR UPDATE` target of every writer) |
| `business_day_policy` | one row, column defaults (`Europe/Madrid`, no auto-seal, ticket reset on consolidation) | structural singleton |
| `business_day_lifecycle_state` | one row, column defaults (pointers NULL) | structural singleton |
| `config('DRIVER_STATO', '{}')` | the value the code itself creates lazily | the dispatch lock anchor: `delete_order_if_not_active`, `delete_conversation_if_not_active`, `close_rider_trip`, `rider_collect_and_complete_stop` lock it `FOR UPDATE` and never create it; without it a greenfield database takes no lock there until the first trip ever |

**What it never contains:** a workspace, an actor, a user, an order, a table, a menu row, business configuration, a staging UUID (the
only UUID literal is the nil sentinel inside a function body), a staging value, a migration-ledger row. The ledger row that stands for
the baseline (apply_order 138, kind `bootstrap`, `verified`) and its Supabase registry row are written by the installer in the baseline's
own transaction, after the installed catalog was compared with the pinned catalog and `PRE_APPLY` passed.

**Identity.** Six identity columns, each with its own identity sequence — `archivio_conv.id`, `backup_serata.id`, `clientes.id`,
`delivery_logs.id`, `storico.id` (BY DEFAULT) and `auth_audit.id` (ALWAYS) — plus one standalone sequence, `trip_authority.trips_seq_v1`:
7 sequences. All start at 1 on a greenfield database (staging's current values are data, not structure).

## 3. Catalog comparison: staging tip 138 vs greenfield

Normalized comparison (`compare`): owners and grantors excluded, aclitems sorted, JSON key order irrelevant, column LOGICAL order compared
instead of physical `attnum`. Final result: **0 differences**; raw function definitions 163 / 163 byte-identical.

| Difference met while building the generator | Class | Resolution |
|---|---|---|
| `gen_random_uuid()` resolved to `extensions.gen_random_uuid()` (32 defaults) | REAL_STRUCTURAL_MISMATCH | generator fixed: `pg_catalog` stays implicitly first in the generation `search_path` |
| 3 CHECK constraints deparsed flat instead of nested (`BETWEEN` origin) | REAL_STRUCTURAL_MISMATCH (byte-level constraint pins exist) | generator writes the nested `(e >= lo) AND (e <= hi)` shape back as `BETWEEN`; round-trips byte-identically |
| `attnum` gaps in `ordenes` (68 vs 67) and `restaurant_tables` (15 vs 14) | EXPECTED | dropped columns on staging; logical order identical |
| aclitem order of 9 trigger functions | EXPECTED | PostgreSQL metadata; same grantees and privileges |
| grantor of schema `public` ACL items | EXPECTED | platform object |
| staging ledger (135 rows) / registry (112 rows) vs one baseline row | EXPECTED | greenfield history is represented, not replayed |
| staging business rows (5 actors, 1 workspace, sessions, orders, menu, config) | STAGING_DATA_ONLY | never copied; business bootstrap instead |
| the dynamic `cashier` actor | STAGING_DATA_ONLY | created by the owner in the app (`auth_create_access_user_v3`) |
| `supabase_realtime_messages_publication` membership of the `realtime.messages_*` partitions | LEGACY_ARTIFACT (platform) | outside the application schemas; the platform manages it |

## 4. Production install (the cutover target)

1. New Supabase project (PostgreSQL 17). Nothing to create: the platform provides the prerequisites.
2. Direct connection as `postgres` (`db.<ref>.supabase.co:5432`, never port 6543):
   `node scripts/economyChainApply.js install-greenfield` → `INSTALLED`, `POST_APPLY`, ledger 138 + 139 … 156, registry byte proofs.
3. The owner signs up (Supabase Auth). `on_auth_user_created` creates `user_profiles`.
4. `node scripts/v3BusinessBootstrap.js apply --config owner.json` with
   `{"owner_user_id": "<uuid>", "workspace": {"slug": "…", "display_name": "…"}}` → one active workspace, the owner membership, the four
   canonical actors `owner:admin`, `operator_primary:operator`, `operator_backup:operator`, `rider:rider`, no PIN. Idempotent; a different
   config on a bootstrapped database is refused; tables / menu / config / PINs are rejected as inputs.
5. In the app: the owner sets the PIN (`auth_set_actor_pin_v3`, caller kind `account_owner`), creates access users, tables (Mesa admin,
   `mesa_save_table_v1`), menu, restaurant configuration; secrets are set as environment variables (rotated, never copied from legacy).
6. Cutover import and first service: `docs/LEGACY_IMPORT_CONTRACT.md`.

`status` after step 2 must read `POST_APPLY`, `ledger_consistent: true`; `v3BusinessBootstrap.js check` after step 4 must show exactly the
state above with 0 services.
