# B6 — Routine Administrator Access Management (Contract)

**Status:** B6A (SQL/database contract) implemented, **unwired**. Migration
`migrations/2026-07-15_auth_admin_access_management.sql` is **NOT APPLIED**. The
Node service/DAO and HTTP wiring are **B6B (future)**. Staging-only
(`tdikhfeinufaahagmpjz`); production untouched.

## 1. B5 emergency access vs B6 routine management

| | **B5 — bootstrap/recovery (emergency)** | **B6 — routine management** |
|---|---|---|
| Initiator | **None** — no human actor (`by_actor` NULL) | An authenticated **active admin** (`p_by_actor`) |
| Authorization | One-shot secret window (`auth_recovery_windows`) | Stored `role='admin'` + `active=true`, validated **under row lock** |
| Scope | Restore admin PIN when locked out | Day-to-day PIN/session/active/unlock management of any actor |
| Audit `by_actor` | NULL | the initiating admin |
| Events | `bootstrap`, `recovery` | `pin_set`, `pin_change`, `revoke`, `actor_enabled`, `actor_disabled`, `actor_unlocked` |

B6 never self-authorizes via a secret; it always requires a live, active admin.

## 2. Common initiator contract

Every RPC takes `p_by_actor`. Inside SQL, after acquiring the row lock:
- the initiator row must **exist**;
- its **stored** `role` must be exactly `admin` (caller-supplied role is never trusted);
- it must be `active=true`.

Operator, rider, disabled admin, unknown/missing initiator → **fail closed**. The
`service_role` execute grant authorizes *technical* execution only; it does **not**
satisfy this business-level check.

## 3. Common target contract

Every operation targets an existing `auth_actors` row. Supported stored roles:
`admin`, `operator`, `rider`. The **database row is authoritative**. Each RPC also
receives `p_expected_role` and verifies it against the **locked** target row
(`AUTH_TARGET_ROLE_MISMATCH` on divergence). Service/machine actors are not
representable in `auth_actors` and are therefore unsupported.

## 4. Deterministic locking

Both required rows are locked in **canonical actor-name order** with a single
`SELECT 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE`
(collapses to one row when initiator = target). Row values are then read from the
already-locked rows (no second `FOR UPDATE`), so no row is locked twice and no
lock is taken in conflicting order. All authorization/state decisions are made
**after** the locks are held, so concurrent calls serialize predictably.

## 5. The four operations

All four are `SECURITY INVOKER`, `SET search_path = public, pg_temp`, no dynamic
SQL, fully-qualified refs, and return **sanitized** payloads only
(`actor, role, active, session_version, failed_count, locked_until, updated_at, updated_by, changed, event`
— **never** `pin_hash`).

### 5.1 `auth_admin_set_actor_pin`
`(p_by_actor, p_target_actor, p_expected_role, p_hash, p_ip_hash, p_meta, p_confirm)`
- Rejects NULL/empty hash; requires versioned `scrypt$…` shape (real hashing is B1
  in Node — plaintext PINs never reach SQL). **Never sets `pin_hash=NULL`.**
- Preserves `active`; resets `failed_count=0`, `locked_until=NULL`; bumps
  `session_version` **once**; sets `updated_at=now()`, `updated_by=p_by_actor`.
- Audits `pin_set` when the prior hash was NULL, else `pin_change`.
- **Owner self-change:** when `p_by_actor='owner'` and target=`owner`, requires the
  exact confirmation `CHANGE_OWNER_PIN` (no case/whitespace normalization). The
  phrase is never stored, audited, or returned.

### 5.2 `auth_admin_revoke_actor_sessions`
`(p_by_actor, p_target_actor, p_expected_role, p_ip_hash, p_meta, p_confirm)`
- Bumps `session_version` **once**; sets `updated_at`/`updated_by`; audits `revoke`.
- Preserves `pin_hash`, `active`, `failed_count`, `locked_until`.
- **Owner self-revoke:** requires the exact confirmation `REVOKE_OWNER_SESSIONS`
  (no normalization). Revoking any other actor needs no self-confirmation.

### 5.3 `auth_admin_set_actor_active`
`(p_by_actor, p_target_actor, p_expected_role, p_active, p_ip_hash, p_meta)`
- **Self-disable forbidden:** initiator = target with `p_active=false` →
  `AUTH_SELF_DISABLE_FORBIDDEN` (applies to every admin, including `owner`).
- **Same-state no-op:** if current `active` already equals `p_active`, returns
  `changed=false` with **no** `session_version` bump, **no** audit, no timestamp churn.
- **Real change (authoritative session-version rule):** both `true→false` and
  `false→true` bump `session_version` **exactly once**. Rationale: no token issued
  before a deactivation may become usable again after reactivation. (This supersedes
  the older B2 `auth_set_active`, where enable did **not** bump.) Preserves
  `pin_hash`, `failed_count`, `locked_until`. Audits `actor_disabled`/`actor_enabled`.

### 5.4 `auth_admin_unlock_actor`
`(p_by_actor, p_target_actor, p_expected_role, p_ip_hash, p_meta)`
- **Already-unlocked no-op:** if `failed_count=0` and `locked_until IS NULL`,
  returns `changed=false` with no audit, no `session_version` change, no timestamp churn.
- **Real reset:** sets `failed_count=0`, `locked_until=NULL`, `updated_at`,
  `updated_by`; audits `actor_unlocked`. Preserves `pin_hash`, `active`,
  `session_version`. **Unlock must not revoke sessions.**

## 6. Session-version effects (summary)

| Operation | Real change | No-op |
|---|---|---|
| set PIN | +1 (every committed call) | n/a |
| revoke sessions | +1 (every committed call) | n/a |
| set active (disable/enable) | +1 | no change |
| unlock | **0** (never bumps) | no change |

## 7. IP-hash contract

Every mutating B6 op requires a non-empty **approved IP hash** (`p_ip_hash`): NULL,
empty, or whitespace-only is rejected; length is capped at 64 (consistent with
B3/B5); a raw IP is never accepted or stored. Only the hash is written to
`auth_audit.ip_hash`.

## 8. Metadata safety

Reuses the B2/B5 guard: JSON object only, ≤2048 serialized bytes, safe default
`{}`, and rejection of sensitive keys — `pin`, `pin_hash`, `password`, `token`,
`access_token`, `refresh_token`, `jwt`, `secret`, `recovery_secret`,
`authorization`, `api_key`, `apikey`, `bearer`, `cookie`, `raw_ip`, `confirmation`.
Caller metadata is validated, never blindly merged; `set active` additionally
records only the derived `{active: <bool>}` fact.

## 9. Failures

Controlled `RAISE` markers (mapped to typed errors by the future Node layer, no
SQL leak): `AUTH_INITIATOR_NOT_FOUND`, `AUTH_NOT_ADMIN`,
`AUTH_INITIATOR_INACTIVE`, `AUTH_ACTOR_NOT_FOUND`, `AUTH_TARGET_ROLE_MISMATCH`,
`AUTH_CONFIRMATION_REQUIRED`, `AUTH_SELF_DISABLE_FORBIDDEN`, `AUTH_HASH_INVALID`,
`AUTH_IP_HASH_REQUIRED`, `AUTH_IP_HASH_TOO_LONG`, `AUTH_ROLE_INVALID`,
`AUTH_ACTIVE_INVALID`, `AUTH_META_INVALID`, `AUTH_META_TOO_LARGE`,
`AUTH_META_SENSITIVE_KEY`.

## 10. Security & grants

`REVOKE ALL … FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE … TO
service_role` on all four functions. No RLS policies added (tables stay
default-deny; `service_role` bypasses RLS and reaches the tables only through
these RPCs).

## 11. B6A / B6B split & status

- **B6A (this contract):** canonical doc + the four SQL RPCs + guarded rollback +
  static tests. **Migration not applied.** No Node code, no router/HTTP wiring.
- **B6B (future):** Node DAO/service that calls these RPCs (computing the scrypt
  hash via B1 and the IP hash via `ipSecurity`), plus authenticated HTTP routes.

### Artifacts
- Forward: `migrations/2026-07-15_auth_admin_access_management.sql`
- Rollback: `migrations/2026-07-15_auth_admin_access_management.ROLLBACK.sql`
- Static tests: `tests/authAdminAccessManagementMigration.test.js`
