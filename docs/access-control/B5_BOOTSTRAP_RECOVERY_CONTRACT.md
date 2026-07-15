# B5 — Bootstrap / Recovery Contract (UNWIRED · MIGRATION NOT APPLIED)

> **Status:** isolated, **unwired** emergency admin-access capability. No Express
> route, not called from `index.js`, not a B4 router action. The migration
> `migrations/2026-07-14_auth_recovery_windows.sql` is **authored but NOT applied**.
> No runtime effect.
>
> **Source of truth:** the modules under `src/auth/` and the SQL migration. This
> document describes the contract; the tests
> (`tests/bootstrapRecovery.test.js`, `tests/authRecoveryWindowsMigration.test.js`)
> enforce it. No credentials/secrets/PINs appear here.

## Bootstrap vs recovery

| Flow | Precondition on target admin actor | Effect |
|---|---|---|
| **bootstrap** | `pin_hash IS NULL` | establishes the **first** PIN via a one-shot window |
| **recovery** | `pin_hash IS NOT NULL` | **replaces** the PIN via a one-shot window; all prior sessions invalidated (session_version bump) |

Both flows target the actor whose stored role is exactly `admin` (the `owner`
actor), apply the admin PIN policy (**9–12 digits**), hash with the existing B1
versioned scrypt, reset `failed_count=0` / `locked_until=NULL`, set `active=true`,
increment `session_version`, write a `bootstrap`/`recovery` audit event, and
consume the window atomically. These are **emergency** operations — routine PIN
management is **B6**.

## Human / service auth distinction

Bootstrap and recovery **do not** use a human JWT. They require **both** backend-direct
credentials; a Bearer JWT is neither required nor accepted and grants no access:

1. `X-Api-Key` — the existing `DASHBOARD_API_KEY` backend contract.
2. the dedicated window secret header (below).

Backend-direct only: never routed through the browser proxy, the future B8 human
JWT transport, or the B4 action matrix. **Not** registered as a B4 router action.

## Dedicated request headers (exact)

| Flow | Required headers |
|---|---|
| bootstrap | `X-Api-Key` + `X-Auth-Bootstrap-Secret` |
| recovery | `X-Api-Key` + `X-Auth-Recovery-Secret` |

Header handling is exact and fail-closed: missing/empty/duplicated(ambiguous
array) values are rejected; comparisons that occur in Node are constant-time;
values are never logged nor included in errors; external failure is generic. The
dedicated secret is accepted **only** from its header — never from query, body,
cookies, `Authorization: Bearer`, or an alternate header name. The header **name**
is purpose-specific, so a bootstrap secret cannot open a recovery window and
vice-versa.

## Environment window descriptors

One bootstrap window and one recovery window, each described by four env vars
(all required — no partial descriptor):

```
AUTH_BOOTSTRAP_WINDOW_ID | _ACTOR | _EXPIRES_AT | _SECRET_B64URL
AUTH_RECOVERY_WINDOW_ID  | _ACTOR | _EXPIRES_AT | _SECRET_B64URL
```

Validation: `WINDOW_ID` is a strict lowercase UUID; `ACTOR` is a canonical actor
identifier; `EXPIRES_AT` is an absolute tz-qualified UTC timestamp, in the future,
with an **effective lifetime ≤ 15 minutes**; `SECRET_B64URL` is canonical base64url
decoding to **≥ 32 random bytes**. Bootstrap and recovery secrets are independent.
The **target actor comes from the descriptor** — the request body cannot select a
different actor. Values are never printed or copied into the database (only the
secret **digest** is stored).

## Persistent table — `auth_recovery_windows`

Additive migration (`migrations/2026-07-14_auth_recovery_windows.sql`, **not
applied**). Columns: `window_id` (PK, UUID-format check), `purpose`
(`IN ('bootstrap','recovery')`), `actor` (FK → `auth_actors` `ON DELETE RESTRICT`),
`secret_digest` (sha256 hex, **never plaintext**), `created_at` (default now()),
`expires_at`, `consumed_at` (NULL until one consumption), `consumed_ip_hash`,
`metadata` (jsonb `{}` default, object-only). Constraints: `expires_at > created_at`
and `expires_at <= created_at + interval '15 minutes'`. **RLS enabled, zero
anon/authenticated policies** (service_role reaches it only through the two RPCs).
A staging-positive sentinel guard matches B0/B2.

## Window registration

`auth_register_recovery_window(...)` — idempotent, server-time authoritative:
derives nothing (receives the digest), rejects already-expired and over-15-min
lifetimes, `INSERT ... ON CONFLICT (window_id) DO NOTHING`. An exact re-registration
of the immutable descriptor is a safe no-op (restart / multi-instance safe); an
**altered** descriptor (different purpose/actor/digest/expiry) fails closed
(`AUTH_WINDOW_DESCRIPTOR_MISMATCH`). It **never** resets `consumed_at` nor reopens a
consumed window. There is no HTTP endpoint to create arbitrary windows —
registration originates only from the validated env descriptor.

## Atomic consumption RPC

`auth_consume_recovery_window(...)` performs the entire success flow in **one**
transaction (SECURITY INVOKER, pinned search_path): lock the window `FOR UPDATE`;
verify exact window_id/purpose/actor/secret_digest, not-consumed, not-expired
(server `now()`); lock the actor `FOR UPDATE`; require stored role `admin`; enforce
bootstrap→`pin_hash IS NULL` / recovery→`pin_hash IS NOT NULL`; set the new scrypt
hash; reset `failed_count=0`, `locked_until=NULL`; set `active=true`; increment
`session_version`; mark the window consumed (one-shot); write the reused B2-allowlisted
`bootstrap`/`recovery` audit event — **all committed atomically**. Any failure
leaves the actor unchanged, the window unconsumed, and writes no success audit row.
A second use fails closed with no further actor mutation. The one-shot and the
actor mutation share one transaction (not consume-then-separate-RPC).

## PIN validation & hashing

The new PIN exists only in process memory: validated by the shared `pinPolicy`
(admin **9–12** digits, plus the weak/sequential/repeated rules), rejected before
expensive hashing; hashed with the existing B1 versioned scrypt (no second
implementation); never stored/logged/returned in plaintext; absent from errors,
test output and fixtures (tests use synthetic PINs only).

## Audit & IP

Only the approved **IP hash** (B3 HMAC, never the raw IP) is stored in
`consumed_ip_hash` and audit `ip_hash`. Audit meta carries `purpose` + `window_id`
only; it never contains the plaintext secret, secret digest, plaintext PIN, PIN
hash, API key, `Authorization`, or raw IP. The event value (`bootstrap` /
`recovery`) clearly distinguishes the two flows.

## Error contract

External failure is always generic (`{ ok:false, error:'auth_failed' }`). It never
reveals whether the cause was an unknown/wrong/expired/consumed window, wrong
secret, wrong API key, actor not found/not admin/inactive, or a PIN-presence
conflict — no user/actor enumeration. Internal distinctions exist only in safe
test assertions, never with secret material.

## Unwired / no-runtime-effect status

- No Express route; not imported by `index.js`; not a B4 action.
- No human JWT; no B8 transport; no Netlify/frontend.
- Migration authored, **NOT applied**; no DB access performed.
- Enforcement wiring, service-token transport, and B6 routine management are out
  of scope (future phases).
