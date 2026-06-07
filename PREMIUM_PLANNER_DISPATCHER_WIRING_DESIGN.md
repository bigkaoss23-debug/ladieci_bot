# Premium Planner — Dispatcher / Wiring Design (`previewStrategicOpportunities`)

**SOLO DESIGN. Nessun codice di wiring in questo blocco.** Nessuna modifica a
`index.js`, nessuna dispatcher action aggiunta, nessun endpoint live, nessun DB
write, nessun deploy. Questo documento disegna *come in futuro* l'adapter
read-only [`previewStrategicOpportunities`](src/agents/previewStrategicOpportunities.js)
verrà esposto via dispatcher, e quali guardie/test/gate servono **prima** di
qualsiasi wiring reale.

Riferimenti: [PREMIUM_PLANNER_READONLY_ADAPTER_DESIGN.md](PREMIUM_PLANNER_READONLY_ADAPTER_DESIGN.md),
[PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md](PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md),
[PREMIUM_PLANNER_ENGINE_DESIGN.md](PREMIUM_PLANNER_ENGINE_DESIGN.md).

---

## 1. Scopo

Esporre, in una fase futura e **gated**, la catena Premium offline come una
**preview read-only** consumabile dal frontend LAB:

```
dispatcher action  →  previewStrategicOpportunities(input, deps)  →  contract
```

Solo **preview**: il frontend riceve opportunità di giro già calcolate
(ETA/slip/status/capacity) e le renderizza senza ricalcolare. **Nessun
write/apply** in questa fase né in quella di wiring iniziale.

## 2. Non-goals

- **No `applyManualGiro`**, no creazione/mutazione di `manual_giros`.
- **No DB write** (solo `select` via read-only adapter).
- **No WhatsApp**, no creazione automatica di ordini, no side-effect.
- **No frontend computation**: il frontend è renderer del contract.
- No multi-rider (single-rider V1), no Google routing reale.
- No PII raw in input echo o output.

## 3. Existing pattern (riuso, non reinvenzione)

### 3.1 Come funziona `previewOrderPlanner` oggi (modello da imitare)

Da [index.js](index.js) (`app.post("/api", …)`):

```js
const action = req.query.action || req.body.action;
// …
} else if (action === "previewOrderPlanner") {
  // read-only: db read-only via sbSelect, resolver geo read-only/no-cache di default.
  result = await previewOrderPlanner(req.body || {}, {
    db: createReadOnlyRestDb({ sbSelect }),
  });
}
// …
res.json(result);
```

Caratteristiche del pattern:

| Elemento | Valore attuale |
|---|---|
| **Dispatch** | catena `if (action === "…")` in `app.post("/api")` (blocco mutation) e `app.get` (blocco read). |
| **Input** | `req.body` (action + payload). |
| **DB** | iniettato come `db: createReadOnlyRestDb({ sbSelect })` — **solo `select`**, tabelle/campi allowlisted, no PII, no wildcard. |
| **Output** | `result` (oggetto contract) → `res.json(result)`. |
| **Error** | l'adapter ritorna `{ok:false, …}` safe; il `try/catch` globale fa `res.status(500).json({ error: e.message })` solo per eccezioni non gestite. |
| **Read-only** | nessun writer iniettato; default geo resolver no-cache. |
| **Test index** | [tests/previewOrderPlannerIndex.test.js](tests/previewOrderPlannerIndex.test.js): **source-inspection statica** (non avvia il server, non tocca DB) che verifica import, action, deps read-only, assenza di writer/resolver live. |

### 3.2 Differenze del Premium strategic preview

| Aspetto | `previewOrderPlanner` | `previewStrategicOpportunities` (Premium) |
|---|---|---|
| Scopo | timing/disponibilità del **singolo** nuovo ordine | **opportunità di giro** cross-zone "di passaggio" |
| Geo | risolve `direccion` → zona (read-only) | **zona esplicita** nel draft (no geo in questa fase) |
| Planner | chiama `evaluateNewOrder` (planner reale) | orchestratore offline (strategic → routeImpact → bridge → mapper) |
| Snapshot | importa `loadPlannerSnapshot` come **default**, riceve `deps.db` | usa **`deps.loadSnapshot`**; **nessun loader di default** (vedi §6 / FINDING) |
| `startTime` | derivato dal planner/now | **esplicito obbligatorio** (`missing_start_time`) |
| Contract | `nuevo-pedido-planner-preview-v1` | `premium-planner-strategic-preview-v1` |

> **FINDING 1 (gap deps loader).** A differenza di `previewOrderPlanner` (che
> importa `loadPlannerSnapshot` come default e riceve `deps.db`),
> `previewStrategicOpportunities` **non ha un loader di default**: se mancano sia
> `input.snapshot` sia `deps.loadSnapshot`, ritorna `missing_snapshot`. Per il
> wiring reale serve quindi una scelta esplicita (§6, §12).

## 4. Future action name

Candidati: `previewStrategicOpportunities` vs `previewPremiumPlanner`.

| Criterio | `previewStrategicOpportunities` | `previewPremiumPlanner` |
|---|---|---|
| Coerenza naming (`preview*`) | ✅ (come `previewOrderPlanner`, `previewOrderTiming`) | ✅ |
| Mappa 1:1 col nome funzione/modulo | ✅ identico | ❌ |
| Chiarezza di cosa ritorna | ✅ "opportunità strategiche" | ⚠️ generico ("planner premium") |
| Collisione in `index.js` | nessuna (grep pulito) | nessuna |
| Rischio futura ambiguità con `previewOrderPlanner` | basso | medio (entrambi "planner") |

**RACCOMANDAZIONE: `previewStrategicOpportunities`** — mappa diretta col modulo,
coerente col pattern `preview*`, semanticamente preciso. (Decisione finale resta
in §12.)

## 5. Input contract (future)

```jsonc
{
  "action": "previewStrategicOpportunities",
  "currentOrderDraft": {
    "zona": "Q2",          // zona esplicita (no geo in questa fase)
    "pizzas": 1,
    "promised": "20:50",   // HH:MM o null (ordine flessibile)
    "serviceMin": 2        // opzionale, default 2 (handoff)
  },
  "startTime": "20:35",    // ESPLICITO e obbligatorio (vedi nota)
  "serviceDate": "2026-06-07",  // → date per il loader snapshot
  "includeCrossZone": true       // false ⇒ scarta i candidati cross
}
```

> **Nota `startTime` (FINDING 5).** `loadPlannerSnapshot` ritorna `driver:null`
> (driver availability non caricata). Finché non esiste una fonte read-only per
> il rider libero, `startTime` **resta input esplicito obbligatorio**; assente →
> `missing_start_time`. **Mai** `Date.now`, mai driver availability inventata.

Validazione minima richiesta al confine dispatcher (prima/oltre l'adapter, che
comunque rivalida): `action` nota, `currentOrderDraft.zona` presente, `startTime`
formato `HH:MM`. PII (`direccion`/`telefono`/`nombre`) **non** accettata in input
in questa fase (zona esplicita); se in futuro entra `direccion`, vale §6.

## 6. Data loading (read-only)

- **Snapshot**: `loadPlannerSnapshot({ db, date, now, includePii:false })` →
  `{orders, manual_giros, driver, …}`. **Mai** `includePii:true`.
- **DB**: `createReadOnlyRestDb({ sbSelect })` — solo `select`, allowlist
  tabelle/campi, no wildcard, no PII (stesso adapter di `previewOrderPlanner`).
- **Travel legs**: `deliveryLegs` (matrice statica V1); tratte mancanti → blocco,
  mai 0 fantasma.
- **Geo** (solo se in futuro entra `direccion`): `resolveDeliveryFieldsReadOnly`
  (no scrittura `geo_cache`). In questa fase **non serve** (zona esplicita).
- **Nessun write adapter** iniettato (no `sbInsert/sbUpdate/sbUpsert/sbDelete`).

### Wiring del loader — due opzioni (decisione §12)

L'adapter usa `deps.loadSnapshot`. Il dispatcher dovrà fornirlo:

- **W1 (preferita per fase design, zero cambi adapter)** — closure in `index.js`:
  ```text
  loadSnapshot: (args) => loadPlannerSnapshot({ ...args, db: createReadOnlyRestDb({ sbSelect }) })
  ```
  L'adapter resta intatto; il wiring è puro.
- **W2 (allinea al pattern `previewOrderPlanner`)** — estendere l'adapter perché
  importi `loadPlannerSnapshot` come default e accetti `deps.db`. Più coerente
  con `previewOrderPlanner`, ma è una modifica all'adapter (fuori dal "design
  only"): da fare solo in fase implementativa, con test.

## 7. Output contract

`premium-planner-strategic-preview-v1` (già prodotto dall'adapter):

```jsonc
{
  "ok": true,
  "contract": "premium-planner-strategic-preview-v1",
  "source": "offline-readonly",
  "mode": "read_only",
  "input": { "zona":"Q2", "promised":"20:50", "pizzas":1 },  // echo no-PII
  "currentOrder": { "zone":"Q2", "promised":"20:50", "pizzas":1 },
  "firstAvailable": { "zone":"Q2", "eta":"20:42", "status":"compatible" },
  "bestProposal":   { /* Opportunity diretta */ },
  "opportunities":  [ /* Opportunity[] contract-ready */ ],
  "serviceLine":    [ /* sintesi anchor no-PII: id/zone/promised/pizzas */ ],
  "warnings":       [ { "code","message" } ],
  "blockers":       [ { "code","message" } ],
  "safety": { "readOnly": true, "writes": false, "pii": "redacted" }
}
```

## 8. Safety gates (obbligatori prima del wiring reale)

- **Read-only DB**: solo `createReadOnlyRestDb({ sbSelect })`; nessun writer.
- **Write guard test**: deps con `insert/update/delete/upsert` che throwano →
  mai chiamati (già coperto a livello adapter; replicare a livello index).
- **No `Date.now`** nell'adapter (già verificato dai test di purity).
- **No PII**: `includePii:false`, sanitizzazione anchor, `safety.pii:"redacted"`;
  test che `JSON.stringify(response)` non contiene direccion/telefono/nome.
- **No endpoint write**, **no manual_giros write**, **no apply** in questa fase.
- **Dispatcher test PRIMA del wiring**: source-inspection statica di `index.js`
  (come `previewOrderPlannerIndex.test.js`) che prova import, action, deps
  read-only, assenza di writer/resolver live.
- **FINDING 3 (pre-esistente)**: il `catch` globale di `app.post` fa
  `res.status(500).json({ error: e.message })` → potenziale leak. L'adapter non
  lancia (ritorna `ok:false` safe); la closure di wiring dev'essere difensiva.
  Hardening del catch globale = fuori scope di questo doc (riguarda `index.js`),
  da valutare come rollout-gate.

## 9. Error handling (tutti → `ok:false` + blocker safe, niente throw)

| Caso | code | Note |
|---|---|---|
| `currentOrderDraft.zona` mancante | `missing_current_order` | blocker |
| `startTime` assente | `missing_start_time` | loader NON chiamato (fail-fast) |
| `startTime` malformato | `invalid_start_time` | blocker |
| snapshot + loader assenti | `missing_snapshot` | blocker |
| loader throw | `snapshot_unavailable` | safe, niente stacktrace/secret |
| tratte di viaggio mancanti | `missing_travel_times` | warning; candidato blocked, niente ETA finti |
| nessun anchor compatibile | `no_anchors` (warning) | ritorna baseline diretta |
| rotta cross | `no_recomendado`/`blocked` | riconciliazione cross nell'adapter |

## 10. Tests required before real wiring

1. **Dispatcher source-inspection** (`previewStrategicOpportunitiesIndex.test.js`,
   stile `previewOrderPlannerIndex`): import adapter, action route, `deps`
   read-only (loader closure su `createReadOnlyRestDb`), nessun writer, nessun
   resolver live, `previewOrderPlanner`/`previewOrderTiming` intatti.
2. **Write guard** a livello index (deps writer throw → mai chiamati).
3. **No PII** nel contract di risposta.
4. **`missing_start_time`** (e loader non chiamato).
5. **Snapshot loader failure** → `snapshot_unavailable` safe.
6. **Happy path Q2→Q5** (opportunity compatible).
7. **No same-zone anchor** (A1: `[Q2,Q2]` non generato).
8. **No live DB** (nessuna connessione reale nei test).

> Tutti i test dell'adapter (81/0) e la catena (strategic/routeImpact/bridge/
> mapper/legs/channels) restano prerequisito verde.

## 11. Rollout plan (gated)

- **Phase 0 — docs only.** ⬅️ *questo documento.*
- **Phase 1 — dispatcher wiring dietro action esplicita, TEST ONLY.** Aggiunta
  del ramo `action === "previewStrategicOpportunities"` in `index.js` + closure
  loader read-only + `…Index.test.js`. Nessun consumo frontend ancora.
- **Phase 2 — local API smoke con dati FAKE.** Nessun ordine reale, nessuna PII.
- **Phase 3 — frontend LAB consuma il contract** (renderer puro), dietro flag.
- **Phase 4 — produzione disabilitata/nascosta** (feature flag off di default).
- **Phase 5 — abilitazione controllata** (shadow/preview prima del live, come gli
  altri blocchi delivery), con auth confermata.

## 12. Open decisions (prima dell'implementazione)

1. **Action name finale**: raccomandato `previewStrategicOpportunities` (§4).
2. **Loader wiring**: W1 (closure, zero cambi adapter) vs W2 (adapter db-default
   allineato a `previewOrderPlanner`) — §6.
3. **`startTime` source**: il frontend lo passa esplicito (raccomandato in V1)
   oppure il backend lo deriva da una futura driver-availability read-only
   (estensione additiva di `loadPlannerSnapshot`) — §5, FINDING 5.
4. **Same-zone**: confermato che la consolidazione same-zone resta dominio del
   planner classico (`evaluateNewOrder`); lo strategic preview la esclude (A1).
5. **Come il frontend LAB richiede la preview** (action POST `/api`, payload §5).
6. **Feature flag / gating**: nome flag, default off, dove valutarlo.
7. **Auth** (FINDING 4): allineare alle altre action `/api`; confermare prima
   della produzione (Phase 4–5).

---

**Docs first. Nessun wiring, nessun `index.js`, nessun endpoint live in questa fase.**
