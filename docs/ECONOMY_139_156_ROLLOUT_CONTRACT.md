# Economy 139 → 156 — the canonical deployment contract (greenfield finalization, 2026-09-27)

This is the ONE deployment contract of the Economy package. It supersedes:

- the post-final-blind amendment of this file (2026-09-27, "149 + 150 are one guarded step"), which it keeps and hardens;
- every `ROLLOUT:` / `ROLLBACK ORDER:` line in the frozen headers of the chain migrations where it differs from this file — in
  particular 149 ("149, then the backend", "ROLLBACK ORDER: 149 FIRST") and 150 ("ROLLBACK ORDER: backend first, then 150"); the
  headers of 145–148 and 151–156 agree with it. The migration SQL is unchanged, byte for byte: those header comments are historical and
  cannot be edited without breaking their certified sha256;
- the rollout / rollback sentences of rows 149 / 150 of `migrations/MIGRATION_MANIFEST.md` (rewritten to point here).

Install and bootstrap of a new database: `docs/V3_GREENFIELD_INSTALL_AND_BOOTSTRAP_CONTRACT.md`. Legacy data: `docs/LEGACY_IMPORT_CONTRACT.md`.

## 1. The only deployment path

```
node scripts/economyChainApply.js plan                 # the sequence below, no connection
node scripts/economyChainApply.js status               # read-only: position (catalog + ledger), open services, H-1 states
node scripts/economyChainApply.js install-greenfield   # EMPTY Supabase database -> baseline -> 139 .. 156 (never-served database only)
node scripts/economyChainApply.js next [--package-backend-deployed]   # an existing V3 database: exactly ONE step forward
node scripts/economyChainApply.js rollback-one         # exactly ONE step back
```

```
PLATFORM_PREREQUISITES (Supabase)
→ V3 GREENFIELD BASELINE tip 138      (ledger row 138, kind bootstrap)          ← greenfield only; an existing V3 database is already at 138
→ 139 → 140 → 143 → 144 → 145 → 146 → 147 → 148
→ GUARDED(149 + 150)                   ONE transaction, lifecycle lock, no open service
→ [package backend]                    on a database that serves; nothing to do on a never-served greenfield database
→ 151 → 152 → 153 → 154 → 155 → 156
→ BUSINESS BOOTSTRAP                   greenfield only (scripts/v3BusinessBootstrap.js)
```

Every step is ONE transaction on ONE direct session:

1. the file is the certified bytes (sha256 of the frozen manifest, `PF.CHAIN`) and has the `BEGIN; <body> COMMIT;` shape
   (`scripts/lib/migrationTx.js txBody`);
2. the read-only preflight of the starting mode passes (`scripts/economy139to146Preflight.js`);
3. `BEGIN` → the body → its ledger row (`public.ladieci_schema_migrations`, sha256/16) → its Supabase registry row
   (`supabase_migrations.schema_migrations.statements[1]` = the exact file text) → the full preflight of the TARGET mode, evaluated inside
   the still-uncommitted transaction → `COMMIT`.

Any failure rolls the whole step back: the database is never between two certified states, and the ledger never records a step that did
not commit (nor misses one that did).

### Session requirements (enforced)

- A direct connection (`db.<ref>.supabase.co:5432`) or the session pooler. **Port 6543 (transaction pooler) is refused** before any
  statement. The runner also proves that one server session answers every statement (`pg_backend_pid` stable) and owns its advisory
  locks (`pg_locks`).
- Role `postgres` (object owner) for the baseline; `client_encoding` UTF8 (the runner sets it; several bodies carry non-ASCII bytes).
- One runner at a time (session advisory lock `hashtext('ladieci_economy_chain_apply')`).

### Not deployment paths (forbidden for this package)

| Path | Why |
|---|---|
| Supabase MCP `apply_migration`, the SQL editor, `psql -f` of a chain file | cannot run 149 + 150 atomically, cannot write the ledger / registry in the migration's own transaction, skips the preflight gate |
| applying 149 or 150 alone (either direction) | the H-1 state ("149 without 150" with a previous V3 backend live) |
| inserting ledger rows by hand | the ledger is the proof that the certified file committed in that transaction |
| a transaction-mode pooler | the lifecycle lock is a session lock |
| deploying a previous V3 backend (`2e3e59a` / `0c4efb0`) to production | vulnerable to the crash/retry stale close (final pass validation, HIGH) |

A database found at "149 without 150" (bypass or interruption) is completed by `next`: the guarded step applies 150 and writes the
missing 149 / 150 ledger and registry rows in one transaction (certified on a real database: evidence `phase5_6`, G5).

## 2. The guarded step (149 + 150)

`scripts/economy149150GuardedStep.js` (called by `next`; callable directly with the same guarantees). Under
`pg_advisory_lock(hashtext('service_session_lifecycle'))` — the lock every service opening and the terminal close take first — it
requires: no service `open` / `closing`, no closeout on such a service (H-1), no active closeout attempt, certified files, the preflight
of the starting mode. Then **forward** = ONE transaction: body 149 + body 150 + ledger 149 / 150 + registry 149 / 150 + full preflight
`BEFORE_151` → `COMMIT`; **rollback** = ONE transaction: body rb150 + body rb149 + catalog `BEFORE_149` → `COMMIT` (the immutable ledger
keeps its rows).

Measured on real PostgreSQL 17.7 greenfield databases: a concurrent observer sampling the catalog 270 times while the step's
transaction was held open never saw 149 without 150; an injected failure after both bodies rolled the real DDL back to 148.

## 3. Rollback and points of no return

| From → to | How | Refused when |
|---|---|---|
| 156 → 155 → 154 → 153 | `rollback-one` (package backend live) | drift (each file's own guards) |
| 153 → 152 → 151 | `rollback-one` | **152: a post-close resolution fact exists (PONR)** |
| 151 → GUARDED(rb150 + rb149) → 148 | `rollback-one` (package backend STILL live), then the previous backend | an open service, an H-1 state, an active attempt |
| 148 → … → 140 → 139 → 138 | `rollback-one` | **139: an off-service payment receipt exists (PONR)** |

Re-applying after a rollback is supported: the ledger is immutable, so the certified rows of the rolled-back migrations stay, and the
runner accepts exactly those rows (every other preflight section passes; every ledger row above 138 is the certified row of its chain
member; registry byte proofs still pass). Certified: full rollback 156 → 138 and re-forward to `POST_APPLY` with a consistent ledger.

**Production (greenfield cutover target).** No previous V3 backend may ever run there, so the rollback floor in production is
`BEFORE_151` (151 … 156 can be rolled back with the package backend live). Rolling 149 + 150 back in production is **not supported after
go-live**. Before go-live the whole chain can be rolled back (or the database simply discarded); after the first V3 order the cutover
rollback is the legacy system (`docs/LEGACY_IMPORT_CONTRACT.md`), never a chain rollback.

## 4. Backend position

- Existing V3 database that serves (staging lineage): the package backend is deployed after the guarded step and before 151; `next`
  refuses 151 without `--package-backend-deployed`. Rollback: the package backend stays live until the guarded rollback step is done.
- Greenfield database: nothing serves during the install (no workspace, no service; the runner checks it at every step), so the backend
  is deployed once, after the install and the bootstrap.

## 5. Runbooks

**R1 — H-1 state detected** (`status` / `check` → `h1_states > 0`, or preflight section E FAIL): a closeout committed for a service
still open. Unreachable through this contract; possible only from a previous V3 backend crash (staging lineage). Before the guarded step:
retry Finalizar with the previous backend only if the service is untouched since the crash (otherwise the previous engine closes with
stale figures, final pass validation). After 150 with the package backend: an untouched service resumes; with irreversible facts since
the closeout: freeze the service, export closeout / snapshot / reconciliation / incidents / live facts, open an incident; repair only by a
reviewed `repair` migration. Never delete the closeout by hand.

**R2 — connection lost during COMMIT of a step.** The step is atomic: the database is either at the starting step or at the target step,
never between. Run `status`, then `next` (or `rollback-one`) again. (The former "CRITICAL hold, exit 3" path no longer exists.)

**R3 — step refused.**

| Refusal | Action |
|---|---|
| `REFUSED_PRECONDITION` | Finalizar every open service. For closed services with an active attempt: `scripts/r4bHistoricalCloseAttemptRecovery.js`. |
| `LOCK_NOT_ACQUIRED` / `INSTALLER_BUSY` | Retry. |
| `REFUSED_PREFLIGHT_*` / `REFUSED_LEDGER` / `REFUSED_UNKNOWN_POSITION` | Resolve the reported drift; never edit the ledger. |
| `REFUSED_*_ROLLED_BACK` | Nothing changed; read the detail (a file guard, a PONR, the post-check). |
| `REFUSED_BACKEND_POSITION` | Deploy the package backend, then `next --package-backend-deployed`. |
| `POOLER` | Use the direct connection or the session pooler. |

## 6. Why (finding H-1, kept for the record)

The previous V3 backend runs Finalizar as seven separate transactions. Against "149 without 150", the terminal close is rolled back at
COMMIT by the 149 trigger while closeout, snapshot, reconciliation and incidents are already committed for a service that stays open.
150 makes a closeout commit only with its terminal close. Hence 149 and 150 form one indivisible step; this contract makes that step
atomic in the database itself, not only procedurally. Measured compatibility matrix (post-final-blind evidence): previous backend @ ≤148
closes; @149 H-1; @150–156 fail-closed; package backend @148–149 fail-closed; @150–156 closes.
