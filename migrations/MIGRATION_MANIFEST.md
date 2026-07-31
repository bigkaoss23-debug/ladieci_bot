# Migration manifest & replay authority

**Scope of this file.** This project has **no Supabase CLI migration ledger** (there is no
`supabase/` directory and no `supabase_migrations.schema_migrations` table populated by the
CLI). Migrations are plain `migrations/YYYY-MM-DD_<name>.sql` files, applied **manually**
against staging and tracked by two things only: **git history** (the commit that introduced
each file is the authoritative "created / applied" record) and **static text tests**
(`tests/*Migration.test.js`).

Because ordering is otherwise inferred from filenames, this manifest is the **explicit replay
authority**: a replay MUST apply forward migrations in ascending `apply_order` below — **not**
in lexical filename order — and MAY use the recorded `sha256` to detect an already-applied
migration. Introduced during **S2-7C1** (reference date **2026-07-23**) to reconcile the two
future-dated S2-7B/S2-7C migrations without renaming or re-running any SQL.

---

## S2-7C1 reconciliation — the two account/workspace migrations

| field | S2-7B workspace foundation | S2-7C account boundary |
|---|---|---|
| source filename | `2026-07-24_workspace_foundation.sql` | `2026-07-24_account_auth_boundary.sql` |
| rollback filename | `2026-07-24_workspace_foundation.ROLLBACK.sql` | `2026-07-24_account_auth_boundary.ROLLBACK.sql` |
| version prefix (filename) | `2026-07-24` | `2026-07-24` |
| introduced by commit | `140c8cd` | `0222f04` |
| commit author date | **2026-07-23 14:55:08 +0200** | **2026-07-23 15:20:37 +0200** |
| forward sha256 | `42c949a39ce7d34dc78f904bc898c8537572f2edc71eebf8d1c4fce06bc4a436` | `c46be5b362fa6541de345a95ffca639260b413e90230ab5b877f2afd6ed80e3a` |
| rollback sha256 | `eff05f9a81449b54c6c9788db81dd3a47af840f1faeb16ed54c6b4c552a48ca5` | `10d25240b8773b530b7059871dcc4e46832db80802ef9b40254b80be80bb1812` |
| **apply_order** | **29** | **30** |

> The reference date at reconciliation time is **2026-07-23**. Both filenames carry the
> version prefix **2026-07-24**, i.e. **one day in the future** relative to both their own
> commit date and the reference date.

### Two hazards identified

1. **Future-dated prefix (cosmetic).** `2026-07-24` sorts after every `≤ 2026-07-23`
   migration, so relative to the *current* set the two files still land last, in the right
   place. The wrong date does not, by itself, skip/duplicate/reorder anything.

2. **Intra-prefix lexical inversion of the B→C dependency (real).** Both files share the
   `2026-07-24` prefix, and lexically `account_auth_boundary` **precedes** `workspace_foundation`.
   That is the **reverse** of the true dependency: `2026-07-24_account_auth_boundary.sql`
   (S2-7C) runs `REVOKE UPDATE ON public.user_profiles`, `CREATE TRIGGER … ON
   public.user_profiles`, and triggers on `public.workspace_account_audit` — objects
   **created by** `2026-07-24_workspace_foundation.sql` (S2-7B). A replay driver that sorts
   by filename would apply S2-7C **before** S2-7B and fail (`public.user_profiles` does not
   exist yet). The commit order (`140c8cd` before `0222f04`) is the correct order and is the
   **opposite** of the lexical order.

### Adopted reconciliation

**Keep the filenames as-is (no rename); pin the true order in this manifest.**

- **No SQL is re-run**, **no history is wiped**, **no file is blind-renamed** — as required.
- Renaming the files to a `2026-07-23` prefix was rejected: it would (a) require rewriting the
  applied commits `140c8cd` / `0222f04` (forbidden), and (b) **diverge the source filename
  from the name under which the SQL was applied to staging**, which is itself the skip/dup
  hazard we are avoiding. Keeping the applied name guarantees *source identity == applied
  identity*.
- The dangerous signal is not the date but the lexical order; this manifest overrides it by
  making `apply_order` (which follows commit/dependency order: **29 = workspace_foundation**,
  then **30 = account_auth_boundary**) the authority, independent of the misleading filenames.
- A short guard test (`tests/migrationManifestOrder.test.js`) asserts the manifest keeps
  S2-7B strictly before S2-7C and that S2-7C references objects S2-7B creates — so the
  inversion can never be silently reintroduced.

### Replay-safety proof

A future replay driven by this manifest **cannot**:

- **skip** — every forward migration in `migrations/*.sql` has exactly one `apply_order` row
  (full table below); nothing is unlisted.
- **duplicate** — each row carries the exact source `sha256`; a driver applies a row only if
  its checksum is not already recorded as applied, so a re-run is a no-op rather than a second
  `CREATE`.
- **reorder** — the driver follows ascending `apply_order`, which encodes commit/dependency
  order. In particular `workspace_foundation` (29) is guaranteed to run before
  `account_auth_boundary` (30), regardless of the fact that the filenames sort the other way.

---

## Full ordered manifest (all forward migrations)

`apply_order` follows commit-introduction order. Where a filename's version prefix disagrees
with its commit date (rows 8, 11, 29, 30) the commit date governs.

| # | version prefix | filename | introduced-by | commit date | sha256 (16) |
|--:|---|---|---|---|---|
| 1 | 2026-05-14 | 2026-05-14_geo_cache_confidence.sql | fab25bc | 2026-05-14 | 598f1f38caffe541 |
| 2 | 2026-05-25 | 2026-05-25_manual_giros.sql | cfba8b9 | 2026-05-25 | 46c748f218f411cb |
| 3 | 2026-05-29 | 2026-05-29_manual_giros_entrega_ref.sql | 3061989 | 2026-05-29 | 352741f5ad731f19 |
| 4 | 2026-05-29 | 2026-05-29_manual_giros_hora_ref.sql | 9edcdb9 | 2026-05-29 | 444f31d91d9b14ac |
| 5 | 2026-06-02 | 2026-06-02_driver_schedule_fields.sql | 5f7f31d | 2026-06-02 | 36a1447f9e69cc51 |
| 6 | 2026-06-05 | 2026-06-05_order_state_transition_logs.sql | 5d9e2de | 2026-06-05 | 6a80a260b9a7e77c |
| 7 | 2026-07-10 | 2026-07-10_p0_lock_sensitive_reads.sql | 3e0814c | 2026-07-10 | 69fdb47bda938354 |
| 8 | 2026-07-13 | 2026-07-13_auth_active_events.sql | 3888d22 | 2026-07-14 | a2ca58a671383c12 |
| 9 | 2026-07-13 | 2026-07-13_auth_rpc.sql | eaad05b | 2026-07-13 | 7e9a6ce04f5b7290 |
| 10 | 2026-07-13 | 2026-07-13_auth_v2_foundation.sql | 1fef81d | 2026-07-13 | 9af802a1c54ae7c1 |
| 11 | 2026-07-14 | 2026-07-14_auth_recovery_windows.sql | 8a1a4ff | 2026-07-15 | 61b7fece50873718 |
| 12 | 2026-07-15 | 2026-07-15_auth_admin_access_management.sql | 785d317 | 2026-07-15 | c18838668c3d3219 |
| 13 | 2026-07-15 | 2026-07-15_auth_unlocked_event.sql | 15512c9 | 2026-07-15 | 4728a8de17371a94 |
| 14 | 2026-07-15 | 2026-07-15_b7_financial_ledger_foundation.sql | 93861d8 | 2026-07-15 | f9f51b24f32c331e |
| 15 | 2026-07-15 | 2026-07-15_b7_financial_ledger_grant_hardening.sql | 2955c27 | 2026-07-15 | a783b8d57b01abde |
| 16 | 2026-07-15 | 2026-07-15_b7_payment_basis_rpcs.sql | 700c03b | 2026-07-15 | 53f572f8fa61a557 |
| 17 | 2026-07-15 | 2026-07-15_b7_refund_void_rpcs.sql | e72218a | 2026-07-15 | bebb7de415c20d23 |
| 18 | 2026-07-16 | 2026-07-16_b7_void_digest_replay_fix.sql | aca5969 | 2026-07-16 | 4021e40294324feb |
| 19 | 2026-07-17 | 2026-07-17_b7_financial_session_version_guard.sql | a5ef761 | 2026-07-17 | f3d56d58b834ce72 |
| 20 | 2026-07-19 | 2026-07-19_b7_payment_basis_historical_replay_fix.sql | 2ec5246 | 2026-07-19 | 8707762a27ab5f99 |
| 21 | 2026-07-20 | 2026-07-20_config_write_revoke.sql | 573398b | 2026-07-20 | b46a6bdeac02022c |
| 22 | 2026-07-20 | 2026-07-20_manual_giros_rls_lockdown.sql | 573398b | 2026-07-20 | 1cf173b97249f40b |
| 23 | 2026-07-20 | 2026-07-20_rider_trip_rpcs.sql | 77693e9 | 2026-07-20 | 450c5d75edf210b8 |
| 24 | 2026-07-21 | 2026-07-21_fix_rider_delivery_log_timestamps.sql | 9fef8d3 | 2026-07-21 | bec2490d9d32e56e |
| 25 | 2026-07-21 | 2026-07-21_fix_rider_trip_json_null_idempotency.sql | 821d56b | 2026-07-21 | 73d4b2fa60cc6925 |
| 26 | 2026-07-22 | 2026-07-22_service_session_identity.sql | 207672b | 2026-07-22 | 835d9d6d0fa7d971 |
| 27 | 2026-07-23 | 2026-07-23_storico_drop_legacy_orden_fecha_uniqueness.sql | 0cf9320 | 2026-07-23 | 993ab0c39e842814 |
| 28 | 2026-07-23 | 2026-07-23_storico_session_order_uq_nonpartial.sql | 4ecf3e1 | 2026-07-23 | a074088c269073e0 |
| 29 | 2026-07-24 → **B (S2-7B)** | 2026-07-24_workspace_foundation.sql | 140c8cd | 2026-07-23 | 42c949a39ce7d34d |
| 30 | 2026-07-24 → **C (S2-7C)** | 2026-07-24_account_auth_boundary.sql | 0222f04 | 2026-07-23 | c46be5b362fa6541 |
| 31 | 2026-07-24 → **S2-7D** | 2026-07-24_workspace_owner_pin.sql | bd6f363 | 2026-07-24 | e5c02d93520ee665 |  <!-- APPLIED on staging -->
| 32 | 2026-07-25 → **S2-7D2 A** | 2026-07-25_canonical_pin_rotation.sql | pending | 2026-07-25 | bfa0711f14dde6be |  <!-- DRAFT — apply BEFORE the backend cutover -->
| 33 | 2026-07-26 → **S2-7D2 B** | 2026-07-26_disable_legacy_pin_rotation.sql | pending | 2026-07-26 | 510ab39362dd4ff7 |  <!-- DRAFT — apply ONLY AFTER the cutover is deployed+verified -->
| 34 | 2026-07-26 → **S2-7D6B** | 2026-07-26_two_service_identity.sql | 9a86fb1 | 2026-07-26 | 3027d7291d3c6c6d |  <!-- APPLIED on staging -->
| 35 | 2026-07-27 → **S2-7D6E** | 2026-07-27_order_state_logs_session_identity.sql | pending | 2026-07-27 | f1448c0f33ef8bad |  <!-- DRAFT — NOT APPLIED; purely additive (nullable column + partial indexes + soft trigger), independent of the payment wiring -->
| 36 | 2026-07-27 → **S2-7D6E3 A** | 2026-07-27_s2_7d6e3a_rider_ledger_writer_additive.sql | pending | 2026-07-27 | 2c0796cc34aaa546 |  <!-- DRAFT — NOT APPLIED. Supersedes the single-file S2-7D6E2 draft (split after an audit found it coupled DB and backend deploys). Purely additive: creates _ledger_write_payment (session-scoped idempotency — fixes a gap present since 2026-07-19 that the 2026-07-26 session-scoped indexes never got matched in code), replaces order_mark_paid to delegate to it (admin/operator authority byte-unchanged), adds rider_collect_and_complete_stop. Does NOT drop complete_rider_stop — an older backend keeps working unmodified. Apply independently of the backend deploy. -->
| 37 | 2026-07-27 → **S2-7D6E3 D** | 2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql | pending | 2026-07-27 | 5766f9eebe9c1cee |  <!-- DRAFT — NOT APPLIED. Cleanup-only: DROPS the ledger-less complete_rider_stop(text,boolean,text). Apply ONLY AFTER row 36 is applied AND the backend commit repointing riderTrip.completeStop to rider_collect_and_complete_stop has deployed AND a live smoke test has passed. Guard refuses to run unless rider_collect_and_complete_stop already exists. -->
| 38 | 2026-07-28 → **SERVICE ORDER NUMBER** | 2026-07-28_service_order_number.sql | 846a58f | 2026-07-28 | 18e91cd253cbad04 |  <!-- APPLIED on staging; trigger wiring re-applied explicitly and verified after the forward was made self-contained. -->
| 39 | 2026-07-29 → **V3-A** | 2026-07-29_v3a_access_control_foundation.sql | d3610ae | 2026-07-29 | 4d3aae1ea98ba87c |  <!-- APPLIED on staging 2026-07-29 (tdikhfeinufaahagmpjz). Additive/foundation only: widens the auth_actors.role CHECK to a transitional union (legacy admin/operator/rider values UNCHANGED on every row — real per-row conversion deferred to V3-C), adds display_name/created_at/created_by, adds auth_actor_pin_fingerprints + access_management_idempotency (both inert, 0 rows), widens auth_audit_event_chk. Does not lift the actor-id CHECK (V3-D) and does not touch table_sessions (V3-G). Idempotent-re-apply fix landed in commit d480f03 before staging apply. -->
| 40 | 2026-07-29 → **V3-B** | 2026-07-29_v3b_auth_set_actor_pin_v3.sql | f75a8f4 | 2026-07-29 | f2e887c6dce6abe4 |  <!-- APPLIED on staging 2026-07-29 (tdikhfeinufaahagmpjz), ledger version 20260729151034. Additive only: creates auth_set_actor_pin_v3 ALONGSIDE the still-untouched, still-sole-live auth_set_actor_pin_v2 (verified byte-identical pre/post apply). Adds atomic dual-key fingerprint writes and removes v2's hardcoded 3-role closed-list pre-check (the authoritative row-based role check is unchanged). No Node code calls v3 yet — still completely unwired. -->
| 41 | 2026-07-29 → **V3-C** | 2026-07-29_v3c_auth_change_actor_role.sql | 35344f3 | 2026-07-29 | 0825d580cc96eb10 |  <!-- APPLIED on staging 2026-07-29 (tdikhfeinufaahagmpjz), ledger version 20260729162816. Relaxes the hardcoded 1:1 auth_actors_actor_role_map CHECK to permit any non-owner actor to hold any role except admin/owner (owner stays pinned to admin; no row's role value changed on apply — verified byte-identical pre/post). Creates auth_change_actor_role_v3: a dormant, owner-authorized, session-bound-idempotent RPC converting ONE non-owner actor to ONE of the 5 assignable V3 roles (cashier/waiter/kitchen/rider/shift_manager), auditing role_changed + session_invalidated on every real change. No Node code calls it yet — still completely unwired. -->
| 42 | 2026-07-29 → **V3-D** | 2026-07-29_v3d_dynamic_access_user.sql | d8cfc96 | 2026-07-30 | c64249995bbf4fbd |  <!-- APPLIED on staging 2026-07-30 (tdikhfeinufaahagmpjz), ledger version 20260730085937. Lifts the fixed four-actor identity ceiling: widens auth_actors_actor_chk/created_by_chk/updated_by_chk and auth_audit_target_actor_chk/by_actor_chk to also accept a canonical UUID text form (strict superset — no existing row changed on apply, verified byte-identical pre/post). Adds auth_actors_display_name_chk (bound 120, trimmed, control-char-free). Creates auth_create_access_user_v3 (server-generates the UUID, frozen safe defaults, pin_hash NULL, no fingerprint) and auth_rename_access_user_v3 (display_name only, self-rename allowed), both session-bound-idempotent and auditing user_created/user_renamed. No Node code calls either yet — still completely unwired. -->
| 43 | 2026-07-30 → **V3-E** | 2026-07-30_v3e_access_user_lifecycle.sql | pending | 2026-07-30 | cb570e3d738f2aeb |  <!-- DRAFT — NOT APPLIED. Adds no new/widened constraint (every audit event it uses — user_deactivated/user_reactivated/credential_cleared/session_invalidated — was already reserved by V3-A). Creates auth_set_access_user_active_v3: one canonical active-state writer for both directions, distinguished by a boolean + by distinct stable idempotency action ids (deactivate_access_user_v3/reactivate_access_user_v3); bumps session_version on BOTH directions (deliberately stricter than the legacy auth_set_active, which only bumps on disable). Creates auth_clear_access_user_credential_v3: clears pin_hash, deletes every fingerprint row for the target, resets failed_count/locked_until, bumps session_version once — releasing the PIN for reuse, distinct from deactivation (which preserves the credential and its reservation). Both owner-authorized by role, workspace-scoped, session-bound-idempotent. Target eligibility is a POSITIVE allowlist (operator/legacy_operator/cashier/waiter/kitchen/rider/shift_manager), not a denylist — corrected in a pre-staging security-closure pass, checksum updated accordingly. Idempotency replay is evaluated only AFTER acting-owner and target-eligibility are re-proved under lock, so a revoked/demoted/deactivated acting owner cannot replay a stored success. No Node code calls either RPC yet — still completely unwired. -->
| 44 | 2026-07-31 → **V3-G** | 2026-07-31_v3g_waiter_table_assignment_safety.sql | pending | 2026-07-31 | a3e315edd932732f |  <!-- DRAFT — NOT APPLIED. PATH B: no table/mesa/dine-in concept existed anywhere in this codebase (confirmed by audit); creates the minimal canonical table_sessions (workspace-scoped, nullable assigned_waiter_actor — an open session MAY be legitimately unassigned) + append-only table_session_assignment_history. Creates auth_assign_table_session_waiter_v3: dormant, owner-authorized, session-bound-idempotent, frozen actors-before-sessions lock order (workspace → every involved actor in ONE deterministic ORDER BY actor statement, including the acting owner, the session's current assignee, and the requested waiter → the target session, ORDER BY id → idempotency only after all validation). Revises auth_set_access_user_active_v3 (CREATE OR REPLACE, guarded by an exact-signature predecessor check proving V3-E's own function is what is being replaced) to add exactly one rule: a role='waiter' target with one or more OPEN assigned table sessions cannot be deactivated — AUTH_WAITER_HAS_OPEN_TABLES, raised after authorization/idempotency-replay evaluation but before any actor mutation, audit insertion, or idempotency insertion. Every other V3-E behavior is preserved byte-for-byte; reactivation and non-waiter deactivation are unaffected. V3-G.1 (2026-07-31, checksum updated) additionally revises auth_change_actor_role_v3 (CREATE OR REPLACE, guarded by an exact-signature predecessor check proving V3-C's own function is what is being replaced) with the SAME rule for role changes away from waiter, and CORRECTS a source-audit finding: the committed V3-C body evaluated idempotency replay BEFORE actor locking/authorization (opposite of V3-E's already-corrected order) — this revision reorders it to match V3-E's pattern (actor lock/authorize → idempotency replay short-circuit → expected-role snapshot check → waiter guard → mutate), so neither a revoked/demoted acting owner NOR a stale idempotency record can bypass current authorization or the new guard. Does not widen auth_audit_event_chk (the dedicated history table is the source of truth). No Node code calls any of these RPCs yet — still completely unwired. -->

> Rows 29–30: filename prefix `2026-07-24` is one day ahead of the `2026-07-23` commit date.
> `apply_order` places **workspace_foundation (S2-7B) before account_auth_boundary (S2-7C)**,
> overriding the lexical filename order which would (wrongly) invert them.

## Live-staging verification (owner / tooling action)

Confirming the *registered* version of each migration in the live staging database was **out
of scope for this session** (no Supabase Management/DB access was available here). When access
is present, verify for rows 29–30 that the applied name equals the source filename
(`2026-07-24_*`); if it matches, source and history are already consistent and no further
action is needed. Do **not** rename to "correct" the date after the fact — that would create
the very divergence this manifest prevents.


## S2-7D2 cutover ordering (rows 32–33)

The two S2-7D2 migrations are **not interchangeable** and must bracket the backend deploy:

1. **row 32** `2026-07-25_canonical_pin_rotation.sql` — adds `auth_set_actor_pin_v2`. Purely
   additive: the legacy writers still work, so an older backend keeps functioning.
2. **deploy the backend** that routes EVERY owner/operator/rider rotation through v2.
3. **verify** no call site references any of the six writers closed in step 4
   (`tests/pinRotationCutover.static.test.js`).
4. **row 33** `2026-07-26_disable_legacy_pin_rotation.sql` — fail-closes and revokes **all six**
   unsynchronized writers, each keeping its exact signature and `jsonb` return type:
   `auth_admin_set_actor_pin`, `auth_account_set_owner_pin`, `auth_set_pin_hash`,
   `auth_set_active`, `auth_admin_set_actor_active`, `auth_consume_recovery_window`.
   Its guard refuses to run unless row 32 is present, `service_role` can execute v2, and every
   one of the six is found with its exact expected overload.

> **Capability removed, not migrated.** Step 4 leaves **zero** writers of `auth_actors.active`
> and no operational recovery path. Neither is exposed by any runtime route today, so nothing
> regresses — but activation and emergency recovery stay disabled until they are redesigned
> around the canonical workspace lock in a later block. Operational and personal-account login,
> failed-attempt, unlock and session-revocation paths are untouched.

> **Transition boundary.** Between steps 1 and 4 the PIN-uniqueness invariant does **not**
> hold: any still-running old backend instance can call a legacy writer, which locks only
> (initiator, target) and performs no cross-actor duplicate check. Keep the window short and
> do not rotate operator/rider PINs inside it.

## S2-7D6E3 rider ledger rollout ordering (rows 36–37)

Same shape as the S2-7D2 cutover above — additive first, cleanup last, no step requires
simultaneity between Railway (backend) and Supabase (DB):

1. **row 36** `2026-07-27_s2_7d6e3a_rider_ledger_writer_additive.sql` — creates
   `_ledger_write_payment` and `rider_collect_and_complete_stop`, and replaces
   `order_mark_paid`'s body to delegate to the shared writer. `complete_rider_stop` is left
   untouched. Apply any time; the currently-deployed backend (which still calls
   `complete_rider_stop` and the pre-existing `order_mark_paid`) keeps working unmodified.
   This step alone also fixes an already-live gap: `order_mark_paid`'s pre-INSERT lookup
   queries had not been updated to match the session-scoped unique indexes
   `2026-07-26_two_service_identity.sql` installed, so an order id/number recycled across two
   service sessions could false-replay or spuriously conflict — see
   `tests/ledgerWritePaymentSessionScoping.test.js`.
2. **deploy the backend** commit that repoints `riderTrip.completeStop` from
   `complete_rider_stop` to `rider_collect_and_complete_stop`.
3. **smoke-test** the rider door-collection flow live: confirm `order_financial_events` rows
   appear with `by_role='rider'`, `meta.source='rider_delivery'`, and that a repeated
   "Entregado" tap on the SAME stop replays instead of double-charging.
4. **row 37** `2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql` — apply ONLY after step 3
   passes. Drops `complete_rider_stop(text, boolean, text)`. Its guard refuses to run unless
   row 36's `rider_collect_and_complete_stop` is present.

> **Transition boundary.** Between steps 1 and 4, `complete_rider_stop` still exists and would
> still work exactly as before if some caller reached it — nothing forces the cutover, so
> there is no unsafe window analogous to the PIN-rotation one above. The only requirement is
> ordering: never apply row 37 before step 2 has deployed and step 3 has passed.
