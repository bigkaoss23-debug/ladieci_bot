# ci/f10-certification/ — F-10 concurrency certification inputs

**These are TEST / CERTIFICATION INPUTS. They are NOT:**
- canonical product schema
- migration 0
- migration 93
- production migration source
- anything ever intended to be applied to real STAGING or LIVE

This directory exists solely so a GitHub Actions runner (which cannot read
`/Users/bigart/Downloads`) has local copies of the already-certified,
hash-pinned DB-SCHEMA-BASELINE.3 (V3) artifacts and the already-drafted,
hash-pinned candidate F-10 resolver migration, to bootstrap a disposable
Postgres 17 + PostgREST instance for the F-10.3C ephemeral concurrency
certification workflow (`.github/workflows/f10-concurrency-cert.yml`,
triggered only on `ci/f10-concurrency-cert-2026-08-19`).

## V3 → V4 repair (DB-SCHEMA-BASELINE.3R)

Run [32249061176](https://github.com/bigkaoss23-debug/ladieci_bot/actions/runs/32249061176)
(certification commit `39f22677824e5edecbf2fbb15abf636701eaa710`) failed at
schema bootstrap — `CREATE FUNCTION public.is_platform_admin()` (a
`LANGUAGE sql` function, eagerly validated at `CREATE` time, unlike
`plpgsql`) referenced `public.platform_roles`, a table deliberately
excluded from this minimal bootstrap. **No concurrency phase ever ran.**

`is_platform_admin`/`is_workspace_member` are removed in V4 — both were
already logically `excluded_from_minimal_bootstrap` in V3's own dependency
graph (reachable only through an RLS policy this bootstrap never even
creates), just not yet physically removed from the SQL. Full audit,
per-object delta, and root-cause detail: `schema/staging-schema-head-92-2026-08-19.v4.capture-notes.md`,
`schema/v3-v4-semantic-delta.json`, `schema/f10-create-time-dependency-graph.json`.

**Why the file named `...v3.bootstrap.sql` now contains V4 bytes:** the
frozen `.github/workflows/f10-concurrency-cert.yml` hardcodes that literal
path in its `psql -f` step and was not modified (see workflow-scope note
below). The canonically-named `...v4.bootstrap.sql` (identical bytes)
sits alongside it for clean provenance. `staging-schema-head-92-2026-08-19.v3.sql`'s
sibling `.metadata.json`/`.inventory.json`/`.capture-notes.md` files are
**not** rewritten — they remain the accurate record of what run
32249061176 actually attempted and why it failed.

## Layout

- `schema/` — the hash-verified V3 baseline artifacts (preserved, describing
  failed run 32249061176) **and** the V4 repair artifacts described above,
  copied verbatim from `/Users/bigart/Downloads/ladieci-db-schema-baseline/`,
  plus 2 CI-only additions (`f10-ci-roles.sql`, `f10-ci-overlap-probe.sql`)
  that implement `f10-ci-role-model.json` and Phase 11's lock-contention
  probe inside the ephemeral database only.
- `resolver/` — the candidate F-10 resolver cutover + its rollback,
  copied verbatim from `/Users/bigart/Downloads/ladieci-f10-certification/`.
  Frozen bytes, not edited in this slice.
- `harness/` — the Node test harness (`runAll.js` and its phase modules).
  Requires the REAL, unmodified backend source (`src/agents/agentOrdini.js`,
  `src/serviceSessions/forgottenCloseRecovery.js`, etc., already present at
  the repository root of this same branch) — never a copy, never a mock.

## What this workflow does NOT do

- Never touches the operational `feature/staging-messa-tables-2026-08-01`
  branch, the real STAGING database, Railway, Netlify, or LIVE.
- Never activates the candidate resolver anywhere but this one disposable,
  ephemeral CI database.
- Never uses a real Supabase/Railway/Netlify credential — every credential
  it uses (Postgres password, JWT signing secret, JWT itself) is generated
  fresh at run time and discarded when the job ends.

See `f10-concurrency-certification.json` (produced by the workflow run, not
committed here) for the full evidence and verdict.
