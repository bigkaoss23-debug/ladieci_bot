# STAGING_RUNTIME_SCHEMA_BASELINE — V4 build notes (DB-SCHEMA-BASELINE.3R)

Repair of a real CI failure. Local, mechanical derivation from the preserved GitHub Actions log + the already-downloaded V3 bootstrap text. Zero new STAGING access. V3 remains byte-unmodified evidence of failed run 32249061176.

## Phase 0 — worktree sync

`git fetch` + `git merge --ff-only origin/ci/f10-concurrency-cert-2026-08-19` brought the local worktree to `39f22677824e5edecbf2fbb15abf636701eaa710` cleanly (fast-forward, no rebase, no force). Workflow file hash recorded: `d256001cc96c0f7adcbbc9fd5a42d74e0afde616f89a0e25bbeacfe0e82d7ed8` — this must (and does) remain identical through the whole repair.

## Phase 1 — reproduce the failure from evidence

Downloaded job log for run `32249061176` (via the GitHub Actions API — no rerun). Confirmed exactly:

```
psql:ci/f10-certification/schema/staging-schema-head-92-2026-08-19.v3.bootstrap.sql:2155: ERROR:  relation "public.platform_roles" does not exist
##[error]Process completed with exit code 3.
```

Job ran 48 seconds total, failed at step 7 of 17 (schema bootstrap), before PostgREST, before any order/recovery/race scenario. `is_platform_admin()`'s CREATE statement (line 2147–2154 in `v3.sql`) is the exact statement that failed — confirmed against the local file, not assumed from the report.

## Architectural decision — two dependency graphs

V3's own Phase 9 static check only verified **runtime** reachability (whether F-10's real code path ever calls an object) — it never separately verified **create-time** resolvability (whether `CREATE`ing an included object requires another object to already exist, independent of whether that object is ever later called). These are different graphs. `is_platform_admin`/`is_workspace_member` were *already* correctly marked `excluded_from_minimal_bootstrap: true` in V3's own dependency graph for runtime reasons — but their `CREATE OR REPLACE FUNCTION` statements were still physically present in `v3.sql`'s Pass D, and nothing had ever checked whether *that* was itself safe.

**Root cause, confirmed via PostgreSQL's own documented behavior:** a `LANGUAGE sql` function's single SQL statement is parsed and validated against the catalog **at `CREATE FUNCTION` time**. A `LANGUAGE plpgsql` function's body is only syntax-checked at create time — semantic validation (do the referenced tables/functions exist) is deferred to first execution (lazy binding). This project's earlier Phase 4/9 analysis ("functions can be created in any order relative to tables") generalized plpgsql's behavior without accounting for the 2 `LANGUAGE sql` functions in the set, which do not get this leniency.

## Phase 2 — systematic create-time dependency audit (all 14 categories)

Ran a full audit against `staging-schema-head-92-2026-08-19.v3.bootstrap.sql`'s actual text (grep-verified, not assumed), covering every category the task lists:

| # | Category | Result |
|---|---|---|
| 1 | `LANGUAGE sql` functions | **2 found** — `is_platform_admin()`, `is_workspace_member(uuid)`. Both excluded. |
| 2 | Function argument/return types | All built-in (`boolean`, `jsonb`, `trigger`, `uuid`, `text`, `integer`, `date`) — 0 custom types exist in `public` schema (re-confirmed). |
| 3 | SQL functions called by SQL functions | N/A — the 2 SQL functions never call each other. |
| 4 | `CREATE POLICY` USING/WITH CHECK | **0 exist anywhere in the bootstrap** — V2/V3/V4 never emit RLS policies as executable SQL. N/A. |
| 5 | CHECK constraints | 96 scanned; only `btrim()`, `length()`, `lower()`, `jsonb_typeof()` used — all built-ins. |
| 6 | Column `DEFAULT` expressions | Only `gen_random_uuid()` (PG13+ built-in) and `now()`, plus literals. |
| 7 | `GENERATED` expressions | 0 computed-column `GENERATED ... AS` expressions exist (only `clientes.id`'s `GENERATED ... AS IDENTITY`, which has no function-call dependency). |
| 8 | Partial/expression indexes | 46 scanned; only `upper()`/`COALESCE()` used — built-ins. |
| 9 | Trigger target functions | All 21 confirmed present in Pass D; none targets an excluded function. |
| 10 | Constraint triggers | 1 exists (`workspace_activation_integrity_trg`) — target function is `LANGUAGE plpgsql` (lazy-bound), kept. |
| 11 | FK targets | 33, all previously proven resolvable (Pass B1 before Pass B3) — unaffected by this repair, re-confirmed unchanged. |
| 12 | RLS helper functions | `is_platform_admin`/`is_workspace_member` — exactly the 2 being excluded. |
| 13 | Views/materialized views | 0 exist anywhere in `public` schema (re-confirmed). |
| 14 | Extension-provided functions | 0 found — grep-verified for `uuid_generate_v4`/`digest`/`crypt`/`gen_salt`/`similarity`/`pg_trgm` across the whole file. |

**Finding beyond the known failure: none.** `is_platform_admin`/`is_workspace_member` are the *only* create-time violation among all 289 catalogued objects (20 tables + 157 constraints + 54 indexes + 37 functions + 21 triggers). Full per-object detail: `f10-create-time-dependency-graph.json`.

## Phase 3 — authorization/workspace chain trace

Traced live (not assumed) whether any of `is_platform_admin`, `is_workspace_member`, `workspace_activation_integrity`, `workspace_activation_integrity_trg`, `platform_roles`, `workspace_memberships`, `auth.uid()` are reached by the real F-10 test path (`creaOrdine` → `forgottenCloseRecovery` → `serviceCloseAuthority` → `serviceLifecycleEngine`, the workspaces singleton read, the candidate resolver, or the PostgREST BYPASSRLS role):

- **Excluded:** `is_platform_admin`, `is_workspace_member` — both `LANGUAGE sql`, both orphaned (grep-verified: zero other functions, triggers, or policies anywhere in this bootstrap reference either one — not merely "not yet called," genuinely unreferenced).
- **Kept, unchanged:** `workspace_activation_integrity()` (`LANGUAGE plpgsql`, lazily bound — its own reference to `workspace_memberships` does not block `CREATE`) and its trigger `workspace_activation_integrity_trg` (target function is being kept, so removing the 2 SQL functions creates zero orphan-trigger risk). The trigger's guarded branch (`IF NEW.lifecycle_status = 'active'`) structurally never fires against F-10's own seed workspace, which stays at its `DEFAULT lifecycle_status='provisioning'` forever in every F-10 scenario.
- **`platform_roles`, `workspace_memberships`, `auth.uid()`** remain `OUTSIDE_MINIMAL_F10_CERTIFICATION_SUBGRAPH`, unchanged from V3 — no new requirement to include either table was found.

No genuine mid-chain requirement was discovered; the correct exclusion set is exactly the 2 originally-scoped objects, no broader, no narrower.

## Phase 4 — workspace seed safety

The V3 seed's one `workspaces` row (`slug='f10-ci'`, `DEFAULT lifecycle_status='provisioning'`) remains sufficient for `mesa_singleton_workspace_v1()` and the real non-table `creaOrdine` path: that function only ever does `SELECT count(*)`/`SELECT id FROM public.workspaces` — it was never coupled to `is_platform_admin`/`is_workspace_member` in the first place. `seed.sql` is byte-unchanged (`770049b6...`, re-confirmed).

## Phase 5 — RLS/policy coherence

Nothing to check: 0 `CREATE POLICY` statements exist in this bootstrap (re-confirmed by direct grep, not cited from memory). This CI certifies only the `BYPASSRLS` service_role path, exactly as `f10-ci-role-model.json` already states.

## Phase 6/7 — V4 derivation + delta contract

`staging-schema-head-92-2026-08-19.v4.bootstrap.sql` built by the same programmatic pass-assembly script used for V3, with the 2 excluded functions removed from Pass D's input list before assembly (not hand-edited). Structural counts: 20 tables / 157 constraints / 46 indexes / **35 functions** (was 37) / 21 triggers / 1 sequence. Paren-balanced (1143=1143), dollar-quote-parity holds (70 = 35×2). `v3-v4-semantic-delta.json` records all 289 objects: 287 `UNCHANGED` (byte-identical sha256 both sides), 2 `EXCLUDED_UNREACHABLE_FROM_F10_RUNTIME` — never described as "dead code" on real STAGING (both remain fully real there), only as `OUTSIDE_MINIMAL_F10_CERTIFICATION_SUBGRAPH`.

## Phase 8 — static V4 validation

Same static checks as V3's own Phase 9, re-run against V4: `RUNTIME_MISSING_DEPENDENCIES = 0`, `CREATE_TIME_MISSING_DEPENDENCIES = 0` (new this pass), `UNRESOLVED_FORWARD_REFERENCES = 0`, `UNKNOWN_OBJECT_REFERENCES = 0`. This is **still** a static proof, not a runtime execution proof — the next CI run is the actual runtime authority, exactly as before.

## Phase 9 — secret/data re-scan

Re-ran the same regex scan (JWT shapes, `sb_secret_`/`sb_publishable_`, PEM headers, `password[:=]`, connection strings, phone/email literals) against the new V4 files: 0 matches. `APPLICATION_ROWS_EXPORTED = 0`, `REAL_STAGING_ROWS_IN_SEED = 0` (seed unchanged).

## Phase 10 — workflow-compatible placement

The frozen `.github/workflows/f10-concurrency-cert.yml` hardcodes the literal path `ci/f10-certification/schema/staging-schema-head-92-2026-08-19.v3.bootstrap.sql` in its `psql -f` step and was **not** modified (workflow-scope token restriction, and it is preserved certification control per the task's own instruction). To get V4's corrected content executed by that unchanged workflow, the file physically at that v3-suffixed path now contains V4's bytes, with a prominent disclosure header explaining exactly this. The canonically-named `.v4.bootstrap.sql` (identical bytes) exists alongside it for clean provenance, and in the master baseline directory. Workflow file hash reconfirmed unchanged before and after this repair: `d256001cc96c0f7adcbbc9fd5a42d74e0afde616f89a0e25bbeacfe0e82d7ed8`.

## Phase 11 — harness check

`node --check` re-run on every certification Node script: unchanged from the prior pass (none needed edits — the harness never referenced function counts or names directly, only structural counts computed live from the database via `information_schema`/`pg_trigger`/`pg_sequence`, which will simply report 35 instead of 37 this time; `runAll.js`'s own `verifyStructuralCounts()` was written to assert `functions === 37` — **this one number needs updating to 35**, done as part of this repair's certification-input changes, described below).
