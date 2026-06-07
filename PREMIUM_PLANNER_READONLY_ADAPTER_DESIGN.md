# Premium Planner — Read-only Adapter Design (`previewStrategicOpportunities`)

Design del **futuro** adapter read-only `previewStrategicOpportunities`, che
espone la catena Premium già costruita
(`deliveryChannels → strategicOpportunities → routeImpact → premiumPlannerBridge
→ premiumPlannerOpportunities`) come **preview read-only**, sullo stesso pattern
di [`src/agents/previewOrderPlanner.js`](src/agents/previewOrderPlanner.js).

**SOLO design in questo blocco.** Nessun modulo `src/agents/previewStrategicOpportunities.js`
creato, nessun endpoint, nessuna dispatcher action, nessun cambio a `index.js`,
nessuna scrittura DB, nessun deploy. Vedi anche
[`PREMIUM_PLANNER_ENGINE_DESIGN.md`](PREMIUM_PLANNER_ENGINE_DESIGN.md) §5
(actions future) e [`PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md`](PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md)
§A/§D.

---

## 1. Scopo

`previewStrategicOpportunities(params, deps)` — adapter **read-only** che, dato un
pedido in bozza, ritorna:

- la **baseline diretta** (`firstAvailable` / `bestProposal`);
- le **opportunità di giro** Premium (anche cross-zone "di passaggio"), già
  calcolate (ETA/slip/capacity/status) dalla catena motore;
- in forma **contract** che il frontend renderizza senza ricalcolare.

È il "motore esposto": apre il popup `Propuestas de entrega`. Read-only, deps
iniettate, write-guarded, no PII — esattamente come `previewOrderPlanner`.

## 2. Non-goals (questa fase e quella di implementazione iniziale)

- **No apply**, no `manualGiros` write, no creazione giro.
- **No endpoint live**, no dispatcher action, no `index.js`.
- **No frontend logic** (il frontend è renderer).
- **No DB write**, no migration, no env/secret.
- **No PII raw** in input echo o output (no direccion/telefono/nome).
- No Google routing reale (resta schema a zone).
- No multi-rider (single-rider V1).

## 3. Pattern ereditato da `previewOrderPlanner` (riuso, non reinvenzione)

Da [previewOrderPlanner.js](src/agents/previewOrderPlanner.js) +
[plannerSnapshot.js](src/core/delivery/plannerSnapshot.js) +
[readOnlyDbAdapter.js](src/core/delivery/readOnlyDbAdapter.js):

| Elemento | Come si riusa |
|---|---|
| **Deps injection** | `deps.db`, `deps.loadPlannerSnapshot`, `deps.resolveDeliveryFields`, `deps.now`. Override nei test; default ai moduli read-only. |
| **Read-only DB** | `createReadOnlyDbAdapter({supabase})`: solo `select`, tabelle/campi allowlisted, **nessun** insert/update/delete/upsert esposto. |
| **Write guard** | I test passano un `writeGuardDb` che **throwa** su ogni write → prova che l'adapter non scrive mai. |
| **Snapshot** | `loadPlannerSnapshot({db, date, now, includePii:false})` → `{orders, manual_giros, driver, …}`. |
| **No PII** | `safeInput` echeggia solo tipo/hora/pizzas; mai direccion. `safety.piiIncluded=false`. |
| **Geo read-only** | `resolveDeliveryFieldsReadOnly(params, deps)` risolve zona/andata senza scrivere `geo_cache`. |
| **Error shape** | `safeError(code,message)` → `{ok:false, blockers:[…], safety:{…}}`. |

> **Principio:** l'adapter strategico **non duplica** geo-resolution né snapshot
> loading: riusa gli stessi helper read-only. Aggiunge solo l'orchestrazione
> strategic → routeImpact → bridge.

## 4. Input futuro

```jsonc
{
  "tipo_consegna": "DOMICILIO",
  "direccion": "…",            // usata SOLO per geo read-only, MAI echeggiata
  "hora": "21:00",             // hora richiesta/flessibile (opzionale)
  "pizzas_count": 3,
  "date": "2026-06-07",        // service date
  "id": "__preview_new_order__",
  "includeCrossZone": true,    // se false, scarta i candidati cross
  "mode": "delivery"
}
```

`deps`: `{ db, now, loadPlannerSnapshot?, resolveDeliveryFields?, evaluateNewOrder?,
buildStrategicCandidates?, buildRouteImpact?, buildOpportunityFromPlannerOption?,
zoneConfig? }` (tutte iniettabili; default ai moduli puri).

## 5. Data loading read-only — cosa serve e da dove viene

| Dato | Serve a | Fonte read-only | Stato |
|---|---|---|---|
| current order draft (zona, andata, pizze, hora) | strategic + routeImpact | `resolveDeliveryFieldsReadOnly` + params | ✅ esiste |
| active/future orders (anchors) | strategic anchors | `snapshot.orders` (DOMICILIO, futuri, con zona/hora) | ✅ esiste |
| manual giros / giri esistenti | anchors aggiuntivi | `snapshot.manual_giros` | ✅ esiste |
| zone/timing config (maxOrdiniPerGiro, tempoGiro) | capacity + travel proxy | `ZONE_DELIVERY` (zones.js) | ✅ esiste (iniettare, non drift) |
| channel map | strategic channel | `deliveryChannels` | ✅ esiste |
| driver availability (`startTime`) | routeImpact startTime | `snapshot.driver*` | ⚠️ **null** nel loader attuale |
| **inter-zone travel times** ("Q2->Q5") | routeImpact legs | — | ❌ **non esiste nel data model** |
| forno state / pizza-quality limit | routeImpact quality | `snapshot.orders.forno_out` / costante | ⚠️ costante da definire |
| capacity rules (maxPizzas, routeMinLimit) | routeImpact capacity | `ZONE_DELIVERY` + policy | ✅/⚠️ |

### FINDING CRITICO — travel times inter-zona non esistono

`snapshot.orders[].andata_min` (= `durata_andata_min`) è **solo** Pizzería→zona
(one-way). Il route model di `routeImpact`/`strategicOpportunities` richiede
anche i leg **inter-zona** (`"Q2->Q5"`, `"Q5->Pizzería"`), che **non sono
memorizzati da nessuna parte** (grep confermato: nessuna matrice punto-punto).

Opzioni valutate:

1. Proxy `andata_min` (`travel(Prev→Z) ≈ andata_min(Z)`) — coerente con
   `planner.js:estimateRouteDuration`, ma confonde "Pizzería→Z" con "Z1→Z2".
2. **Matrice statica `ZONE_LEGS` (SCELTA V1).**
3. Google Distance Matrix — **escluso** in V1 (no routing reale, costo, write).

### DECISIONE V1 — `deliveryLegs.js` (matrice statica `ZONE_LEGS`) ✅

Implementato [`src/core/delivery/deliveryLegs.js`](src/core/delivery/deliveryLegs.js)
(puro/offline, zero-import, test `tests/deliveryLegs.test.js`):

- `ZONE_LEGS` = matrice **direzionale** di stime operative (NON Google):
  depot↔zone (Pizzería↔Q1..Q5), sur (Q1-Q2-Q5), oeste (Q3-Q4).
- `getDeliveryLegMin(from,to)` → minuti, oppure **`null`** se la tratta non
  esiste (REGOLA DURA: **mai 0 fantasma** — `routeImpact` tratterebbe 0 come leg
  istantaneo).
- `buildTravelTimesForZones(routeZones)` → `{ ok, travelTimes, missing[] }`: i
  `travelTimes` pronti per `strategicOpportunities` (chiavi `"From->To"`,
  depot=`HUB_LABEL="Pizzería"`); `ok:false` + `missing[]` se una tratta manca.
- **Cross-channel assente di proposito** (Q5↔Q3, Q2↔Q4, …): il generator blocca
  il candidato cross invece di inventare una rotta (coerente con
  `deliveryChannels`: cross = no_recomendado).

> **FINDING naming.** `deliveryLegs.HUB_LABEL = "Pizzería"` (nodo depot del grafo
> travel) ≠ `deliveryChannels.HUB_ZONE = "Q1"` (zona Centro, hub di *canale*).
> Concetti distinti; mantenerli separati.

L'adapter futuro costruirà `travelTimes` via `buildTravelTimesForZones`,
marcando `geo_source:"static_legs_v1"`/assunzione nei warnings. Una tratta
mancante → candidato `blockedCandidate` (già gestito da `strategicOpportunities`),
non un ETA finto.

### FINDING — driver availability non caricata

`loadPlannerSnapshot` ritorna `driver:null, driver_status:null` (vedi
[plannerSnapshot.js:176](src/core/delivery/plannerSnapshot.js)). `routeImpact`
ha bisogno di `startTime` (rider libero). Opzioni: (a) estendere **in modo
additivo** il loader per leggere `driver_status.available_from` (read-only select,
nuovo campo allowlisted) — modifica futura, non in questo doc; (b) derivare
`startTime` via `simulateDriverSchedule` sugli ordini dello snapshot. Documentare
la scelta in fase implementativa.

## 6. Normalization (read-only data → input dei moduli puri)

```
snapshot + geo(draft)
  → currentOrder  { id, zone, label:"Pedido actual", pizzas, promised(hora), serviceMin }
  → anchors[]     da snapshot.orders/manual_giros futuri, stessa finestra,
                  filtrati per channel (deliveryChannels) se includeCrossZone=false
  → travelTimes   costruiti da andata_min (proxy §5) — chiavi "Pizzería->Z","Z1->Z2","Z->Pizzería"
  → startTime     da driver availability / simulateDriverSchedule
  → capacity      { maxPizzas: ZONE_DELIVERY[zona].maxOrdiniPerGiro, routeMinLimit, pizzaQualityLimitMin }
  → input strategic = { currentOrder, anchors, startTime, travelTimes, capacity, toleranceMin }
```

Poi:

```
candidates = buildStrategicCandidates(input)          // strategicOpportunities
for each candidate with routeImpactInput != null:
    opp = buildOpportunityFromPlannerOption(
            syntheticOption(candidate),                 // {type:"join_giro"|"separate", giro_id:anchorId,…}
            { currentOrderZone, routeZones, routeImpactInput: candidate.routeImpactInput, … })
                                                        // bridge calcola via routeImpact e mappa al contract
```

> Nota: il bridge accetta già `context.routeImpactInput` (fase precedente). Il
> `syntheticOption` serve solo a dare `kind` (agregar/crear) e `giroId`: status/
> ETA/slip arrivano dal routeImpact via bridge. **Niente calcolo nell'adapter.**

## 7. Output contract (top-level)

```jsonc
{
  "ok": true,
  "contract": "premium-planner-strategic-preview-v1",
  "mode": "read_only",
  "source": "planner",
  "input": { "tipo_consegna":"DOMICILIO", "requested_hora":"21:00", "pizzas_count":3 },
  "currentOrder": { "zone":"Q2", "hora":"21:00", "pizzas":3 },
  "firstAvailable": { /* prima opzione diretta, anche non ottimale */ },
  "bestProposal":   { /* directa consigliata */ },
  "opportunities":  [ /* Opportunity[] dal bridge/mapper, contract-ready */ ],
  "serviceLine":    [ /* righe Giros y huecos, se distinte */ ],
  "warnings":       [ { "code","message" } ],
  "blockers":       [ { "code","message" } ],
  "safety": { "readOnly": true, "writesEnabled": false, "piiIncluded": false }
}
```

`firstAvailable ≠ bestProposal ≠ opportunities`: la baseline diretta è sempre
mostrata (non si spinge il cliente a ritardare).

## 8. Opportunity generation flow

1. **baseline direct** — opzione diretta dal planner reale (`evaluateNewOrder`
   separate) → `firstAvailable`/`bestProposal` (riuso `previewOrderPlanner`-style).
2. **strategic candidates** — `buildStrategicCandidates` (cross-zone di passaggio).
3. **routeImpact** — per ogni candidato con `routeImpactInput`, valutazione
   ETA/slip/capacity/status (via bridge che incapsula `buildRouteImpact`).
4. **bridge → Opportunity** — `buildOpportunityFromPlannerOption` → contract shape.
5. **ranking** — per `candidate.priority` (compatibile < cross < blocked) e
   prossimità a `hora`. `blockedCandidate`/`blocked` in coda.
6. **bestProposal selection** — la migliore directa; le opportunità di giro sono
   alternative, non sostituiscono la baseline.

## 9. Safety

- **Read-only**: solo `select` (read-only adapter); nessun write path.
- **Write guard**: test con `writeGuardDb` che throwa su insert/update/delete/upsert.
- **No PII raw**: direccion usata solo per geo, mai echeggiata; `piiIncluded:false`.
- **No stale apply**: la preview è una stima; un futuro `applyManualGiro` deve
  **revalidare** (engine §12, strategic §D) — mai applicare preview stantia.
- Helper puri **non wired** a `index.js` in questa e nella prima fase impl.

## 10. Error handling (tutti → `safeError`, response `ok:false` + blocker)

| Caso | code | Comportamento |
|---|---|---|
| tipo mancante/non valido | `missing_tipo_consegna` | blocker |
| hora non valida | `invalid_hora` | blocker |
| direccion mancante (DOMICILIO) | `missing_direccion` | blocker |
| geo non risolto / dirty | `unresolved_geo` | blocker (come previewOrderPlanner) |
| **travel times mancanti** | `missing_travel_times` | candidato `blockedCandidate` (strategic già lo fa) → warning, non crash |
| nessun anchor compatibile | — | `opportunities:[]`, ritorna **solo** baseline diretta |
| driver non disponibile | `driver_unavailable` | warning + baseline; opportunità eventualmente vuote |
| capacity full | — | opportunità con `status:"lleno"`, `blocked:true` (dal motore) |
| route troppo lunga | — | `status:"no_recomendado"` (dal motore) |
| snapshot/db non disponibile | `snapshot_unavailable` | blocker safe |
| planner non disponibile | `planner_unavailable` | blocker safe |

## 11. Test plan offline (futuri, niente DB/fetch/env)

1. **Write guard**: `writeGuardDb` → nessun insert/update/delete/upsert; trip se
   accidentale.
2. **Q2+Q5**: current Q2 + anchor Q5 → `opportunities` con 1 Opportunity sur,
   routeEtas/slip dal motore, contract shape completa.
3. **missing travel**: travelTimes incompleti → candidato blocked, warning
   `missing_travel_times`, **no crash**, baseline comunque presente.
4. **no anchors**: nessun anchor compatibile → `opportunities:[]` + baseline
   diretta (`firstAvailable`/`bestProposal`).
5. **cross channel**: Q3 current + Q5 anchor con `includeCrossZone:true` →
   Opportunity `no_recomendado`/`channel:"cross"`, `blocked` coerente; con
   `includeCrossZone:false` → scartato.
6. **routeImpact ajuste**: anchor che fa slittare Q5 → `status:"ajuste"`,
   `slipLabel:"+5"` nel routeEtas.
7. **no PII**: la response non contiene direccion/telefono/nome;
   `safety.piiIncluded===false`.
8. **deps injection**: tutti i moduli puri iniettabili; default usati se assenti.

## 12. Future wiring plan (gated, non in questa fase)

1. ✅ moduli puri (channels, strategic, routeImpact, bridge, mapper) — fatti.
2. **adapter module** `src/agents/previewStrategicOpportunities.js` (read-only,
   deps-injected, write-guarded) — fase successiva, **solo** dopo audit/OK.
3. **test offline** dell'adapter (§11) — insieme al modulo.
4. estensione additiva `loadPlannerSnapshot` per driver availability (§5) — se
   serve `startTime` reale.
5. decisione `travelTimes` (proxy `andata_min` vs matrice) — **prerequisito** del
   route impact reale (§5 FINDING).
6. **dispatcher action** in `index.js` — SOLO con autorizzazione esplicita.
   Il frontend legge il contract, non calcola.
7. rollout produzione **gated** (shadow/preview prima del live), come gli altri
   blocchi delivery.

**No live wiring in questa fase. Docs first.**
