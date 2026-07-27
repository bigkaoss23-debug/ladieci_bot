# B4 — Backend Authorization Contract (UNWIRED)

> **Status:** implemented as an isolated, **unwired** module. It makes **no runtime
> authorization decision** yet. Enforcement (transport, middleware, the `service`
> credential, and B7 predicate evaluation) is deferred to later authorized phases.
>
> **Source of truth:** [`src/auth/authorizationContract.js`](../../src/auth/authorizationContract.js)
> is the executable contract. This document **mirrors** it. The
> `CONTRACT-SNAPSHOT` block below is validated against the module by
> [`tests/authorizationContractDocConsistency.test.js`](../../tests/authorizationContractDocConsistency.test.js) —
> **any change to the contract requires updating the module, this document, and the
> tests together**, or CI-equivalent local tests fail. Do **not** maintain a second
> independent matrix.
>
> No credentials, environment values, PINs, or runtime data appear in this file.

## Principals

| Principal | Kind | Notes |
|---|---|---|
| `admin` | human (JWT) | owner |
| `operator` | human (JWT) | `operator_primary`, `operator_backup` |
| `rider` | human (JWT) | rider self-service, narrowly scoped |
| `service` | **machine-only** | never produced by a human login (B3 `login.js`/`jwt.js` unchanged) |

## Classification rules (finalized)

- **service-only** — allowed for `service`, denied to every human.
  - `triggerCloseIfNeeded` (internal scheduler/cron; isolated from the human
    browser proxy in B8; must not be reachable through a human JWT).
- **admin-only (11)** — `admin` allowed; `operator`/`rider`/`service` denied.
- **rider-enabled (7)** — `admin` + `operator` + `rider`; `service` denied.
  Rider invocation additionally requires a **B7 predicate** (metadata only in B4).
  Admin/operator invocation of these actions carries **no** rider predicate.
- **admin + operator (default class)** — every canonical action **not** in the
  three groups above. Allowed for `admin` + `operator`; denied to `rider` +
  `service`. There is **no** implicit "admin allows everything": `admin` is
  denied `triggerCloseIfNeeded` explicitly, and every resolved decision is
  asserted per-action in the tests.

### Fresh authentication (9)
Explicit metadata — **never** inferred from admin-only status, action name,
read/mutation class, or substrings. Deliberately **not** fresh: `rigeneraSuggerimenti`,
`debugInterpreta`, `chiudiServizio`, all rider-enabled actions, routine ops.

### B7 rider predicates (7)
Stable identifiers stored as metadata. B4 **never evaluates** them and adds **no**
permissive placeholder. When enforcement is wired, a rider action bearing a
predicate with no evaluator **must fail closed**.

| Action | Predicate ID |
|---|---|
| `getDriverStatus` | `RIDER_OWN_DRIVER_STATUS` |
| `updateEstado` | `RIDER_UPDATE_ESTADO_SCOPE` |
| `marcarEnEntrega` | `RIDER_MARK_EN_ENTREGA_SCOPE` |
| `marcarEntregado` | `RIDER_MARK_ENTREGADO_SCOPE` |
| `registrarSalidaDriver` | `RIDER_REGISTER_SALIDA_SCOPE` |
| `chiudiGiro` | `RIDER_CLOSE_GIRO_SCOPE` |
| `marcarLlegado` | `RIDER_MARK_LLEGADO_SCOPE` |

## Alias map — EMPTY (frozen)

The current alias map is **empty** and tested as empty. The four look-alike pairs
are **separate canonical actions, not aliases** (separately routed, possibly
different handler semantics / collateral effects) and must not be collapsed:

- `creaOrdine` / `createOrden`
- `cambiaStato` / `updateEstado`
- `modificaOrdine` / `updateOrden`
- `getWaMsgs` / `getWaMessages`

Any future alias must resolve to exactly one canonical action, inherit that
action's contract (including fresh-auth), forbid cycles, fail closed on unknown
targets, and be added here + to the module + to the tests explicitly.

## Totals (secondary sanity — not the primary proof)

| Principal | Allowed actions |
|---|---|
| `admin` | 60 (every routed action except `triggerCloseIfNeeded`) |
| `operator` | 45 (every action except `triggerCloseIfNeeded` + the admin-only set) |
| `rider` | 7 (the rider-enabled actions) |
| `service` | 1 (`triggerCloseIfNeeded`) |

Primary proof is the exhaustive action-by-action decision surface plus
dynamic router↔matrix set-equality — see `tests/authorizationContract.test.js`.

## Dynamic set-equality requirements

The live router's dispatched action set (extracted from `index.js` without wiring
it) must equal the canonical matrix: no router-only action, no matrix-only action,
no duplicate; the alias map is empty; the fresh set ⊆ canonical; the
predicate-bearing set is exactly the 7 rider actions; the service-only set is
exactly `{ triggerCloseIfNeeded }`. Negative controls prove the extractor and the
equality check actually detect added / removed / misspelled / duplicated actions.

## Unwired / no-runtime-effect boundary

B4 ships classification metadata and a pure decision API only. It does **not**:
wire into `index.js` or any handler; enforce anything at runtime; implement the
`service` token transport or scheduler; implement B7 predicate evaluation; or
change B3 JWT/login/PIN behavior.

---

## CONTRACT-SNAPSHOT

<!-- Machine-readable mirror of the module. Validated by
     tests/authorizationContractDocConsistency.test.js against
     src/auth/authorizationContract.js. Keep in exact sync. -->

```
PRINCIPALS: admin, operator, rider, service
CANONICAL_COUNT: 63
SERVICE_ONLY: triggerCloseIfNeeded
ADMIN_ONLY: getConfig, rigeneraSuggerimenti, approvaSuggerimento, getClientes, debugInterpreta, debugMenuShadow, getStorico, getOrdenesArchivio, getEconomiaLedger, getDeliveryLogs, getSuggerimenti, setConfig, eliminaOrdine, eliminaConversazione, getAuthActors, setActorPin
RIDER_ENABLED: getDriverStatus, updateEstado, marcarEnEntrega, marcarEntregado, registrarSalidaDriver, chiudiGiro, marcarLlegado
FRESH_AUTH: getConfig, rigeneraSuggerimenti, approvaSuggerimento, getClientes, getStorico, getOrdenesArchivio, getEconomiaLedger, getDeliveryLogs, getSuggerimenti, setConfig, eliminaOrdine, eliminaConversazione, getAuthActors, setActorPin, getCurrentServiceCloseout, openServiceSession
PREDICATE getDriverStatus: RIDER_OWN_DRIVER_STATUS
PREDICATE updateEstado: RIDER_UPDATE_ESTADO_SCOPE
PREDICATE marcarEnEntrega: RIDER_MARK_EN_ENTREGA_SCOPE
PREDICATE marcarEntregado: RIDER_MARK_ENTREGADO_SCOPE
PREDICATE registrarSalidaDriver: RIDER_REGISTER_SALIDA_SCOPE
PREDICATE chiudiGiro: RIDER_CLOSE_GIRO_SCOPE
PREDICATE marcarLlegado: RIDER_MARK_LLEGADO_SCOPE
ALIAS_MAP: EMPTY
TOTAL admin: 62
TOTAL operator: 46
TOTAL rider: 7
TOTAL service: 1
```
