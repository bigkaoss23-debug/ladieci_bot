# Giro Authority V1: W3 certification (dormant)

Planner wave **W3**: the Giro Authority and its single projection, written and certified
on an **ephemeral PostgreSQL 17** only. Nothing here is applied to staging or production,
nothing is wired into the backend, and no trigger is installed on `public.ordenes`.

## Status

| Item | Value |
|---|---|
| `PLANNER_NEXT_MIGRATION_CANDIDATE` | **130**. This is a candidate only: it is not reserved and not assigned. |
| `FINAL_MIGRATION_NUMBER` | **DEFERRED**. The ledger tip is 126 and S4 holds 127–129 (CASE L). The candidate therefore lives here, outside `migrations/`, with no manifest row. |
| Private schema | `giro_authority`. Staging PostgREST exposes only `public, graphql_public` (PGRST106 probe, 2026-09-14). The schema has no USAGE for PUBLIC, anon, authenticated or service_role. |
| Capture trigger | Exists only as the W5 artifact. |
| Projection adapter | `src/core/delivery/giroProjectionPort.js` is prepared and pure. Nothing live requires it; the cutover belongs to W4. |
| `AUTHORITY_LOCK_DESIGN_CERTIFIED` | **YES**. The Authority takes the giro row first, then the order locks (ascending), then `FOR SHARE`. This is proven against a fixture that follows the W4 lock order. |
| `CURRENT_RUNTIME_START_RIDER_TRIP_ALIGNED` | **NO**. The live `start_rider_trip` still reads the raw column and does not lock the giro row. Aligning it is W4/W6 work, so no runtime protection is active yet. |

## Files

- `candidate/giro_authority_v1.sql` is the forward candidate: guards, D5 data precondition, schema, tables, the single derivation, the commands, the projection, grants and post-conditions.
- `candidate/giro_authority_v1.ROLLBACK.sql` is the exact reversal. It refuses to run when Authority data or the W5 trigger exists.
- `candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql` holds the BEFORE INSERT capture trigger. It must sort last and is applied only in W5.
- `fixture/staging_shape_v1.sql` is a staging-shaped subset read from the catalog on 2026-09-14.
- `harness/` contains the runner and the scenario groups. It uses the live `start_rider_trip` and `close_rider_trip` bodies verbatim from `migrations/`.
- `harness/matrix.js` lists W3-N01..N30 and the requirement areas. Each entry maps to named assertions, and the run fails if any entry lacks a passing proof.
- The repository suite includes two related tests:
  - `tests/giroAuthorityW3Candidate.static.test.js` is an offline guard that checks dormancy, the numbering deferral, lock order, the boundary and the forbidden tokens.
  - `tests/giroProjectionPort.test.js` checks the projection-to-GiroFacts mapping, including composition with the unchanged W2 core.

## Run

Local (no Docker needed): point to a `node_modules` that contains `embedded-postgres@17.7.0-beta.16` and `pg@8`.

```bash
W3_PG_NODE_MODULES=/path/to/node_modules W3_PG_DATA_ROOT=/tmp W3_EVIDENCE_OUT=/tmp/w3.json \
  node ci/giro-authority-certification/harness/run.js
```

For CI, set `PGHOST`, `PGPORT`, `PGUSER` and `PGPASSWORD` to a disposable `postgres:17.6` started with `POSTGRES_USER=supabase_admin` and `wal_level=logical`. The bootstrap superuser must not be called `postgres`.

## Consume outcomes

Business outcomes never raise. A resolved intent is immutable, and every retry returns the same logical outcome.

| Status | Codes |
|---|---|
| CONSUMED | `ATTACHED`, `GIRO_CREATED` |
| REJECTED | `TARGET_CHANGED`, `TARGET_GONE`, `TARGET_DEPARTED`, `ORDER_CHANGED`, `ORDER_NOT_ELIGIBLE`, `SCOPE_UNAVAILABLE`, `UNVERIFIABLE` (trip facts unreadable) |
| EXPIRED | `SERVICE_CLOSED` |
| Not materialized | `NO_INTENT`, `NOT_YET_OPERATIVE` (called before the first kitchen entry) |

## Known limits (carried to later waves)

- **W4 trip start.** `start_rider_trip` still reads the raw column. W4 redefines it to lock the giro row first, take its members from the projection, and freeze `salida` together with the effective giro ids in the snapshot. Until then, IN_TRIP is derived from the snapshot order ids and `EN_ENTREGA`.
- **Edge E1.** When a derived-dissolved giro's last member departs alone, the giro reads IN_TRIP with that one member. W4's frozen snapshot giro ids remove this case.
- **Single writer on `manual_giros`.** It is not structural yet: service_role keeps DML for the legacy JS writers until W4.
- **W4 wiring.** The data-free change signal (TB-1A am. 9), the BE read wiring and the H1B RPC entries are W4 work.
- **ORDER_CHANGED** compares zona, hora, delivery type and session. The S4 `content_revision` joins the comparison once it exists.

## Applying later (not W3)

1. The owner reserves the migration number with the S workstream (candidate: 130).
2. The file moves verbatim into `migrations/` and gets its `MIGRATION_MANIFEST.md` row.
3. The CASE L guard advances.
4. The owner authorizes the staging application (G3). The D5 precondition refuses by itself when any raw `manual_giro_id` or persisted `pending_giro_intent` exists.
