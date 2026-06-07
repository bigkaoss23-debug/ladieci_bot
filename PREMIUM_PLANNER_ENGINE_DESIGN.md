# Premium Planner — Engine Design (backend)

Design del **motore backend** che in futuro produrrà i dati per il popup
frontend `Propuestas de entrega` (Premium LAB). Fase 1: solo design + helper
puri offline + test. **Nessun endpoint live, nessun wiring, nessuna scrittura DB
in questa fase.**

Frase guida: *non costruire il volante nel frontend. Prima costruiamo il motore.
Il motore produce opportunità già calcolate; la UI le legge e le mostra.*

---

## 1. Scopo

Definire come il planner/backend genera **strategic opportunities** (opportunità
di giro suggerite) e la **preview di un giro manuale** per il pedido in bozza,
nella forma che il frontend renderizza senza calcolare nulla.

Relazione con i contract già scritti:

- Frontend renderer + contract dati:
  `LaDieciBotV2-github/ladieci-app33/docs/PREMIUM_PLANNER_BACKEND_CONTRACT.md`
- Endpoint read-only puntuale già esistente (base da estendere):
  `PREVIEW_ORDER_PLANNER_V1_SPEC.md` → `previewOrderPlanner` /
  `src/agents/previewOrderPlanner.js`.

## 2. Non goals (fase 1)

- Nessun endpoint live nuovo, nessun cambio a `index.js`.
- Nessuna scrittura DB / migration / env / secret.
- Nessun cambio all'orchestrator WhatsApp né alla logica delivery live.
- Nessun dato reale, nessun deploy.

## 3. Fonte di verità = backend

Il planner/backend calcola e restituisce **già deciso**: compatibilità, canale,
ETA per fermata, ritardo `+N` (`slipLabel`), baseline diretta, capacity, status
e flag `blocked`/`warning`. Il frontend non ricalcola: render + select + mappa +
console.debug in LAB.

## 4. Architettura — cosa esiste già

| Layer | Modulo | Ruolo |
|---|---|---|
| Engine timing | `src/utils/zones.js` | `ZONE_DELIVERY` (tempoGiro, `maxOrdiniPerGiro`), `simulateDriverSchedule` (giri cascade-aware), `proposeForNewOrder`, `computeDriverFields`, `calcolaFornoOut` |
| Planner | `src/core/delivery/planner.js` | `evaluateNewOrder(snapshot, newOrder)` → `options[]` (`separate`/`join_giro`, status valid/blocked/recommended), capacity + retraso |
| Read-only preview | `src/agents/previewOrderPlanner.js` | contract `nuevo-pedido-planner-preview-v1`, deps iniettate, write-guarded, no PII |
| Snapshot/geo read-only | `plannerSnapshot.js`, `resolveDeliveryFieldsReadOnly.js`, `readOnlyDbAdapter.js`, `readOnlyRestDb.js` | carica stato giornata e geo senza scrivere |
| Apply (writes) | `src/agents/manualGiros.js` | create/add/remove/dissolve giri manuali (DB) — futuro `applyManualGiro` |

### Gap da colmare (nuovo)

1. **Channel map** sur/oeste/cross — **non esiste** (`canal` nel codice = sorgente
   ordine WA/MANUAL, non direzione). → `src/core/delivery/deliveryChannels.js`
   (pure, fase 1).
2. **Opportunity-shape mapper**: da `evaluateNewOrder.options` alla shape
   opportunity del contract frontend.
3. **Strategic layer**: proporre opportunità di giro per cliente flessibile,
   ordinate, oltre la prima disponibile.
4. **Precompute** `slipLabel`, `capacity.state`, `status`, `baseline`.

## 5. Actions future

| Action | Tipo | Descrizione |
|---|---|---|
| `previewStrategicOpportunities` | read-only | Dato il pedido in bozza, ritorna best proposal + opportunities[] + service line. Apre il popup. |
| `previewManualGiro` | read-only | Dato pedido + giro candidato, ritorna **una** opportunity risolta (rotta intera ricalcolata). Click su riga/quick option. |
| `applyManualGiro` | write (futuro) | Applica davvero (via `manualGiros.js`). **Ricalcola prima di scrivere** (§12). Fuori dal LAB renderer. |

Le prime due read-only, deps iniettate, write-guarded come `previewOrderPlanner`.

## 6. Input — `previewStrategicOpportunities`

```jsonc
{
  "currentOrderDraft": {
    "zone": "Q2", "hora": "21:00", "horaFlexible": true,
    "pizzas": 3, "tipoConsegna": "DOMICILIO"
  },
  "snapshot": { /* read-only: ordenes attivi, giri, driver_status, zones cfg */ },
  "capacityRules": { /* maxOrdiniPerGiro per zona, durata max giro, tempo max pizza */ },
  "channelMap": { /* deliveryChannels: sur/oeste + coppie incompatibili */ }
}
```

`previewManualGiro` riceve in più il giro candidato (`giroId` o richiesta `crear`).

## 7. Output (top-level)

```jsonc
{
  "contract": "premium-planner-popup-lab-v2",
  "mode": "read_only",
  "source": "planner",
  "currentOrder": { "zone": "Q2", "hora": "21:00", "pizzas": 3 },
  "firstAvailable": { /* prima opzione, anche non ottimale */ },
  "bestProposal": { /* directa consigliata */ },
  "opportunities": [ /* §8 */ ],
  "serviceLine": [ /* righe Giros y huecos, se distinte */ ],
  "zoneMapHint": { /* zones + colori + seaLabel */ },
  "warnings": [], "blockers": [],
  "safety": { "readOnly": true, "writes": false, "piiIncluded": false }
}
```

`firstAvailable` ≠ `bestProposal`: il planner non dà solo la prima ora, ma anche
opportunità di giro quando il cliente è flessibile.

## 8. Opportunity shape (contract da rispettare)

```jsonc
{
  "id": "opp-q2-q5-2100",
  "kind": "agregar",                 // agregar | crear
  "giroId": "giro-q5-2100",          // null se kind=crear
  "channel": "sur",                  // sur | oeste | cross  (da deliveryChannels)
  "currentOrderZone": "Q2",
  "currentOrderLabel": "Pedido actual · Q2",
  "routeZones": ["Q2", "Q5"],
  "mapPath": ["Pizzería", "Q2", "Q5"],
  "routeEtas": [
    { "zone": "Q2", "label": "Pedido actual", "eta": "20:50", "promised": null,    "slips": false, "slipLabel": "", "isNew": true },
    { "zone": "Q5", "label": "Las Marinas",   "eta": "21:00", "promised": "21:00", "slips": false, "slipLabel": "", "isNew": false }
  ],
  "baseline": { "directEta": "20:40", "label": "Directa sin giro" },
  "capacity": { "pizzas": "3/6", "routeMin": 22, "limitMin": 30, "state": "ok" },
  "status": "compatible",            // compatible | ajuste | no_recomendado | lleno
  "severity": "ok",
  "blocked": false,
  "warning": "",
  "title": "Agregar a giro Q5 21:00",
  "subtitle": "Q2 entra a las 20:50 antes de Las Marinas",
  "chip": "oportunidad",
  "explanation": "Inserta Q2 antes del Q5 sin volver a pizzería.",
  "quickOptionId": "quick-q2-q5"
}
```

Tutti i campi sono **output**. `slipLabel` (es. `"+5"`) è pre-calcolato dal
backend: il frontend non fa `eta - promised`.

## 9. Channel map

Schema operativo (config pura nel planner, mai UI logic):

- **sur:** Q1 → Q2 → Q5
- **oeste:** Q1 → Q3 → Q4
- **cross / no_recomendado:** zone di canali diversi, es. `Q5+Q3`, `Q5+Q4`, `Q2+Q4`.

`Q1` (Centro) è **hub**: sede pizzería, neutra, compatibile con entrambi i canali.
Una rotta è `cross` se mescola `sur` e `oeste`. Implementazione fase 1:
`src/core/delivery/deliveryChannels.js` (pure: `getZoneChannel`, `routeChannel`,
`isRouteChannelCompatible`, `classifyChannelPair`, `orderZonesByChannel`).

La mappa resta uno **schema operativo a zone**, non Google Maps. Colori zona:
Q1 `#0097A7`, Q2 `#CE93D8`, Q3 `#E65100`, Q4 `#C2185B`, Q5 `#7CB342`.

## 10. Capacity rules

Multi-dimensione, calcolata dal planner (le basi esistono in `zones.js`):

| Dimensione | Fonte | Campo |
|---|---|---|
| Pizze vs limite giro | `ZONE_DELIVERY[].maxOrdiniPerGiro` | `pizzas` `"3/6"` |
| Durata totale giro vs limite | `simulateDriverSchedule` (partenza→rientro) | `routeMin`/`limitMin` |
| Tempo max pizza in giro | regola qualità (soglia) | (interno) |
| Stato sintetico | classifier | `state` ok \| tight/warning \| full |

`state="full"` ⇒ `status="lleno"` ⇒ `blocked=true`.

## 11. Route impact

L'inserimento ricalcola **tutta** la rotta (non solo la fermata nuova): lo
`status` si valuta sull'intero `routeEtas`, perché ogni fermata a valle può
slittare. `simulateDriverSchedule` già produce partenza/consegna/rientro per
ogni giro → da qui si derivano gli ETA per fermata e i ritardi.

```
Q2 20:50 → Q5 21:00            compatible (Q5 resta sul promesso)
Q2 20:50 → Q5 21:05 (+5)       ajuste    (inserire Q2 sposta Q5)
```

## 12. Revalidate on apply

Le preview sono stime sullo stato attuale e possono diventare stantie. Al futuro
`applyManualGiro`:

1. il backend **ricalcola** rotta/ETA/capacity/status;
2. se qualcosa è cambiato (forno slitta, nuovo ordine, driver occupato, Q5 non
   più puntuale), ritorna **nuova preview/conferma**;
3. **mai applicare una preview stantia**.

## 13. Stati semantici (decisi dal planner)

| `status` | Significato |
|---|---|
| `compatible` | Nessuna fermata importante slitta oltre soglia, capacity OK. |
| `ajuste` | Inseribile ma impatta una fermata/orario (es. Q5 +5). |
| `no_recomendado` | Canali diversi / qualità a rischio / giro operativo brutto. Non verde, forzabile con avviso. |
| `lleno` | Capacità rider o durata giro piena. |

Più flag: `blocked` (non applicabile normalmente), `warning` (messaggio già
pronto), `severity` (chiave tono UI).

## 14. Safety

- `previewStrategicOpportunities` / `previewManualGiro`: **read-only**, deps
  iniettate, write-guarded, no PII non necessaria.
- Nessuna scrittura durante preview. `apply` separato e ricalcolato.
- Fase 1: helper puri **non wired** a `index.js`.

## 15. Offline test plan

Scenari (fixture, niente DB/fetch/env):

1. Q2 attuale + giro Q5 21:00 → `compatible` / `agregar`.
2. Inserire Q2/Q1 spinge Q5 +5 → `ajuste`, `slipLabel:"+5"`.
3. Q2+Q5 senza giro → `crear`.
4. Q3+Q5 (canali diversi) → `no_recomendado` / `cross`.
5. Capacity 6/6 → `lleno` / `blocked`.
6. Revalidate-on-apply: preview stantia richiede nuova preview prima di apply.

Fase 1 implementa e testa **solo** lo strato channel map (scenari di canale:
compatibilità sur/oeste, cross Q5+Q3/Q5+Q4/Q2+Q4, hub Q1, ordinamento rotta).
Gli altri scenari restano documentati come test futuri.

## 16. Integration plan (future, non in questa fase)

1. ✅ `deliveryChannels.js` puro + test (fase 1).
2. ✅ `premiumPlannerOpportunities.js` puro — assembler/normalizer della
   opportunity shape da input GIÀ calcolato (fixture) + test offline. Usa
   `deliveryChannels` per `channel`/`mapPath`; policy esplicita status →
   severity/blocked; `slipLabel`/`capacity`/`baseline` pass-through (nessuna
   aritmetica). Non wired.
3. ✅ `premiumPlannerBridge.js` puro — traduce `evaluateNewOrder.options` →
   input del mapper (kind/status/warning, `slipLabel` da `retraso`, baseline
   dalla separata, capacity dal context) + test offline. Non wired.
   **Limiti onesti (FINDINGS):** (a) `evaluateNewOrder` produce solo join
   *same-zone* (`planner.js:713`) → le opportunità cross-zone "di passaggio"
   sono future strategic-layer; (b) `option.retraso` è il ritardo del NUOVO
   ordine sulla sua promessa (`planner.js:201`), non lo slittamento delle altre
   fermate → gli ETA/slip a valle arrivano dal context fixture finché non
   esiste il route-impact engine.
4. Strategic layer: opportunità cross-zone per canale + route-impact (slip a
   valle) + ranking + `previewStrategicOpportunities` adapter read-only.
5. `previewManualGiro` adapter read-only (route impact su giro candidato).
6. Wiring endpoint in `index.js` (dispatcher) — solo quando autorizzato.
7. `applyManualGiro` con revalidate-on-apply su `manualGiros.js`.

**No live wiring in questa fase.**
