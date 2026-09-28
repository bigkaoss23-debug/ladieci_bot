# POST-FREEZE LAYERS — CONTRACT (v1, 2026-09-28)

Migrations that come **after** the Economy 139 → 156 freeze are *post-freeze layers*. They are not Economy migrations, they do not extend the
Economy certification boundary, and nothing here modifies an Economy file.

| Piece | File |
|---|---|
| Registry + numbering policy | `scripts/lib/postFreezeLayers.js` (dependency-free) |
| Exact layer states | `scripts/lib/postFreezeLayerChecks.js` |
| Runner (the only lifecycle path) | `scripts/postFreezeLayerApply.js` |
| Layer files | `migrations/post_freeze/` (outside the `migrations/` root the Economy tooling and tests enumerate) |
| Tests | `tests/postFreezeLayers.static.test.js`, `tests/postFreezeLayerApply.test.js` |

## 1. Economy baseline is immutable

* 139 … 156 are frozen (141 / 142 void forever). `verify-files` re-hashes the 32 Economy files against the certified sha256 of the frozen
  preflight (`scripts/economy139to146Preflight.js` `CHAIN`) every time.
* The runner **requires** the frozen Economy preflight and runs it unchanged. It never edits `economyChainApply.js`,
  `economy149150GuardedStep.js`, `v3BusinessBootstrap.js` or `lib/migrationTx.js` (static test).

## 2. Numbering / namespace policy

| Range | Domain | Allocated |
|---|---|---|
| 139 – 156 | ECONOMY (frozen) | the certified chain |
| 157 – 169 | SECURITY | 157 = SECURITY/G4 (isolated copy `~/Downloads/ladieci-g4-security-be`, **EXTERNAL** here); G4b takes the next free number |
| 170 – 189 | FISCAL_PREREQ | 170 = FP-1 `sale_evidence`; FP-2 / FP-3 / FP-5 take the next free numbers |
| 190 – 209 | FISCAL_CORE | none |
| 210 – 229 | DELIVERY (G2) | none |
| ≥ 230 | unallocated | a new domain gets a range by a reviewed change of the registry |

Rules:

1. A number exists only as a registry entry. It lies in its domain's range, is unique, and appears in the file name (`_layer_<n>.sql`;
   the G4 file keeps its historical `_migration_157.sql`).
2. `apply_order` is the ledger **identity** of a layer, not its chronology: layers of different domains are applied in any order unless an
   entry declares `requires`. Ranges exist so that parallel isolated work streams never renumber a certified file at integration.
3. `OWN` layers are applied / rolled back by this checkout. `EXTERNAL` layers (G4 here) are certified elsewhere: this checkout never
   applies, rolls back or verifies them, but a database carrying **exactly** their ledger row (apply_order, filename, sha256/16) is accepted as
   known. Any other ledger row above 156 is unknown and every mutating command refuses (fail closed).
4. Integration of two branches = merging their registry entries (one file). No file is renamed, no number moves.

Why ranges and not "next free number": G4 (157) is certified but not deployed, FP-1 is developed in parallel, and G4b / FP-2… will follow
in parallel isolated copies. With a single sequence, whichever branch integrates second would have to renumber (and so re-certify) a file.

## 3. Runner

```
node scripts/postFreezeLayerApply.js plan | verify-files | target
node scripts/postFreezeLayerApply.js status
node scripts/postFreezeLayerApply.js preflight --layer N
node scripts/postFreezeLayerApply.js apply --layer N --target <id> [--no-registry]
node scripts/postFreezeLayerApply.js rollback --layer N --target <id> --ack <ACK> [--no-registry]
```

Connection as the Economy runner (`PREFLIGHT_DATABASE_URL` or `PG*`; `W3_PG_NODE_MODULES`). Exit 0 done / already in state, 1 refused
(nothing changed), 2 usage / target / connection / pooler.

**One step = one transaction on one direct session** (Economy guarantees reused from `lib/migrationTx.js`): certified file bytes (sha256 of
the registry) → `BEGIN; <body> COMMIT;` shape → transaction pooler refused → same server session proved → session advisory lock
`ladieci_post_freeze_layer_apply` → checks → `BEGIN` → body → ledger row (kind `ddl`) + Supabase registry row → the layer's **exact state**
and the **Economy composite** re-checked inside the transaction → `COMMIT`. Any failure rolls the whole step back.

**Economy composite (fail closed).** The frozen preflight in mode `POST_APPLY` must pass its catalog sections (A, B, D, E). Its ledger
section (C) must pass except the two range checks a post-freeze row makes fail (`ledger tip max(apply_order)`, `ledger rows above 138 =
exactly the applied prefix`), and only if every ledger row above 156 is exactly a registered layer.

**Exact layer state.** Each OWN layer has a read-only state reader and a classifier: `ABSENT`, `APPLIED`, `DETACHED` (layers whose rollback
detaches), `DRIFT`. `APPLIED` / `DETACHED` compare catalog fingerprints pinned in `postFreezeLayerChecks.js` (functions md5 + security +
ACL, columns, constraints, indexes, triggers, RLS, publications). `DRIFT` refuses every mutating command.

**Collisions.** Refused before `BEGIN`: a ledger row with the layer's number but another file, the layer's file under another number, a
ledger row for a layer whose objects are absent, objects without their ledger row. The ledger itself has `UNIQUE (apply_order)` and
`PRIMARY KEY (filename)` and is append-only.

**Target protection** (before any connection):

* the LIVE project ref (`wnswassgfuuivmfwjxsf`) is refused for **every** command, read-only ones included, wherever it appears in the
  connection (host, user, URL);
* `apply` / `rollback` require `--target <id>` equal to the target this process would connect to: `local:<host>:<port>/<db>`,
  `supabase:<ref>` (direct host `db.<ref>.supabase.co` or session-pooler user `postgres.<ref>`), `remote:<host>:<port>/<db>`;
* a non-local target also needs `LADIECI_POST_FREEZE_REMOTE_TARGET_ACK=<the same id>` in the environment;
* a libpq keyword connection string or a Supabase host without a readable ref is not classified: refused;
* the target is read as the pg driver resolves it: a URL without host / port falls back to `PGHOST` / `PGPORT`; a URL whose query string
  overrides `host`, `hostaddr` or `port` is not classified: refused;
* after connecting, `current_database()` must be the one named.

**`--no-registry`** (skips the Supabase registry row and its check) exists only for an ephemeral **local** certification database that has
no Supabase registry. It is refused, fail closed and before any write:

* before connecting, for every command, on any non-local target: STAGING, LIVE, any `supabase:<ref>` (direct host or pooler user), any
  `remote:` host;
* after connecting (read-only, before the lock / `BEGIN`), when the database has `supabase_migrations.schema_migrations`, so that a
  local-looking path to a real project (tunnel, proxy) cannot skip the registry either.

Without the flag every command checks (and `apply` writes) the registry, `rollback` included.

## 4. Known limitations (by design of "no Economy file modified")

* **L1 — Economy re-forward with a post-freeze row.** The frozen `economy149150GuardedStep.js` accepts no ledger row above 156, so on a
  database that carries a post-freeze layer `economyChainApply.js next` refuses after an Economy `rollback-one` (fail closed; nothing is
  written). `economyChainApply.js status` reports `POST_APPLY` with `ledger_consistent: false` (the two range checks); this runner's `status`
  explains those rows. Lifting it = accepting `isCertifiedPostFreezeRow` in the Economy ledger rule, i.e. an Economy tooling change with its
  own re-certification (the G4 isolated copy carries such a change; it is **not** brought here). On staging, PONR 152 is reached, so an
  Economy rollback below 152 is refused anyway.
* **L2 — Greenfield order.** `v3BusinessBootstrap.js` requires a strict `POST_APPLY` ledger, so a greenfield database is built as
  `install-greenfield → business bootstrap → post-freeze layers` (never a layer before the bootstrap).

## 5. Registered layers

| n | Domain | Status | Layer | Rollback |
|---|---|---|---|---|
| 157 | SECURITY | EXTERNAL | G4 `clientes` / `geo_cache` anon exposure (not in this checkout) | its own runner |
| 170 | FISCAL_PREREQ | OWN | P1 `sale_evidence` — `docs/FISCAL_P1_SALE_EVIDENCE_CONTRACT.md` | DETACH, ack `DETACH_SALE_EVIDENCE_CAPTURE_ACCEPT_EVIDENCE_GAP` |
