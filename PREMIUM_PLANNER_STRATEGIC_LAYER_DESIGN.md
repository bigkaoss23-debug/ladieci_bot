# Premium Planner — Strategic Layer + Route-impact Engine (design)

Estensione di [`PREMIUM_PLANNER_ENGINE_DESIGN.md`](PREMIUM_PLANNER_ENGINE_DESIGN.md)
(§4 "Gap da colmare" punto 3, §11 "Route impact", §16 step 4). Progetta i **due
pezzi accoppiati** che il planner attuale NON produce ancora:

- **A) Strategic layer** — genera *candidati* di opportunità Premium (anche
  cross-zone "di passaggio") che `evaluateNewOrder` non emette.
- **B) Route-impact engine** — dato un candidato, ricalcola **tutta** la rotta
  (ETA per fermata, slip a valle, capacity, ritorno rider) e decide lo status.

**Fase di SOLO design.** Nessun codice engine nuovo in questo blocco. Nessun
endpoint, nessun DB, nessun wiring a `index.js`, nessun dato reale. I moduli
nominati qui (`premiumPlannerStrategic.js`, `routeImpact.js`) **non esistono
ancora**: sono il contratto da implementare in una fase successiva e autorizzata.

Frase guida (invariata): *prima il motore, poi il volante. Il motore produce
opportunità già calcolate; la UI le legge.*

---

## 0. Perché serve un layer nuovo (findings dal codice esistente)

Il planner reale **non** copre i casi Premium target. Verificato leggendo il codice:

1. **`evaluateNewOrder` fa join SOLO same-zone.** `planner.js:713`
   (`if (t.zona !== newOrder.zona) continue;`). Un ordine Q2 non riceve mai
   l'opzione "entra nel giro Q5 di passaggio". → serve lo **strategic layer**.

2. **`option.retraso` misura il ritardo del NUOVO ordine sulla sua promessa**
   (`planner.js:576`, `planner.js:201`), **non** lo slittamento delle fermate
   ESISTENTI ("Q5 se mueve +5"). → serve il **route-impact engine** per gli slip
   a valle.

3. **`simulateDriverSchedule` aggrega anch'esso solo same-zone-slot**
   (`zones.js:337`, key `${o.zona}|${sl}`). Non modella una rotta multi-zona in
   un singolo trip. Quindi NON è la base diretta per il route-impact cross-zone.

4. **L'unico modello multi-zona sequenziale già esistente** è
   `buildRiderBlock` + `estimateRouteDuration` in `planner.js:110-275` (legs
   cliente→cliente, nessun rientro intermedio in pizzeria). È il candidato
   naturale da **riusare/incapsulare** per il route-impact (vedi §B.5), con una
   cautela: `buildRiderBlock` non è puro (chiama `ctx.addOven`, side-effect su
   `ovenLoad`) ed è legato alla shape `manual_route`.

Conseguenza di design: i due pezzi sono **nuovi moduli puri offline**, non patch
del planner live. Lo strategic layer trova i candidati; il route-impact li valida.

---

## A. Strategic layer

### A.1 Scopo

Generare *candidate opportunities* Premium che il planner attuale non produce,
ordinandole, **senza mai forzare il cliente a ritardare**: la baseline diretta
(`firstAvailable` / `directa`) resta sempre mostrata. Esempi target:

- ordine attuale **Q2** + giro futuro **Q5 21:00** → candidato `agregar` sur;
- ordine attuale **Q1** + futuri **Q2+Q5** → candidato rotta sur;
- **Q1/Q2/Q5** nel canale **sur**; **Q1/Q3/Q4** nel canale **oeste**;
- **Q5+Q3 / Q5+Q4 / Q2+Q4** → `no_recomendado` (cross channel) o forced-warning.

Lo strategic layer **non calcola ETA né slip**: produce candidati con `routeZones`
e tempo d'inserimento proposto. La verifica numerica è del route-impact (§B).

### A.2 Input concettuale

```jsonc
{
  "currentOrderDraft": { "zone": "Q2", "hora": "21:00", "horaFlexible": true,
                         "pizzas": 3, "tipoConsegna": "DOMICILIO" },
  "existingGiros":   [ /* giri/ordini futuri dallo snapshot read-only */ ],
  "deliveryChannels": { /* config pura sur/oeste/hub (già esiste) */ },
  "baselines":       { "firstAvailable": {…}, "directa": {…} },
  "fornoState":      { /* ovenLoad per slot, soglie */ },
  "driverState":     { "available_from": "HH:MM", "source": "…" },
  "capacityRules":   { /* maxOrdiniPerGiro per zona, durata max giro */ }
}
```

Tutto **read-only** dallo snapshot (`plannerSnapshot.js`,
`resolveDeliveryFieldsReadOnly.js`). Nessuna lettura DB diretta dal layer.

### A.3 Output — candidate (pre route-impact)

```jsonc
{
  "kind": "agregar",                  // agregar | crear
  "targetGiroId": "giro-q5-2100",     // null se kind=crear
  "channel": "sur",                   // da deliveryChannels.routeChannel(routeZones)
  "routeZones": ["Q2", "Q5"],         // zone candidate, NON ancora ordinate-validate
  "reason": "Q2 di passaggio prima di Q5",
  "baseline": { "firstAvailable": "20:40", "directa": "20:40" },
  "proposedInsertionTime": "20:50"    // stima grezza, il route-impact la conferma
}
```

`channel` deriva **solo** da `deliveryChannels` (singola fonte, niente
duplicazione). Lo status finale (`compatible`/`ajuste`/…) NON è qui: lo decide il
route-impact.

### A.4 Regole (channel policy)

- **non** proporre cross-zone "verde" se i canali sono diversi
  (`isRouteChannelCompatible(routeZones) === false`);
- Q1/Q2/Q5 → **sur**; Q1/Q3/Q4 → **oeste** (Q1 = hub neutro);
- Q5+Q3 / Q5+Q4 / Q2+Q4 → `cross` ⇒ candidato `no_recomendado` o forced-warning,
  **mai** verde;
- **mostrare sempre** `firstAvailable`/`directa` come baseline: lo strategic layer
  non spinge il cliente a ritardare, offre un'alternativa migliore quando esiste;
- ordinamento rotta via `orderZonesByChannel` (config pura, già testata).

> Tutta la classificazione di canale riusa `deliveryChannels.js` così com'è
> (`getZoneChannel`, `routeChannel`, `isRouteChannelCompatible`,
> `orderZonesByChannel`). Lo strategic layer **non** reimplementa la mappa.

---

## B. Route-impact engine

### B.1 Scopo

Dato un candidato giro (zone + ordine da inserire), ricalcolare l'**intera**
rotta. Regola chiave: *inserire un ordine non aggiorna solo quell'ordine —
ricalcola tutte le fermate a valle.*

### B.2 Input

```jsonc
{
  "stops":         [ /* fermate ordinate: ordini esistenti + nuovo */ ],
  "promisedTimes": { "Q5": "21:00", … },
  "fornoOut":      { /* forno_out / ready per stop */ },
  "zoneDurations": { /* ZONE_DELIVERY[].tempoGiro = andata one-way */ },
  "riderCapacity": { /* maxOrdiniPerGiro per zona */ },
  "driverAvailableFrom": "HH:MM",
  "buffers":       { "opsDriverMin": 3 }
}
```

### B.3 Output

```jsonc
{
  "routeEtas": [
    { "zone": "Q2", "label": "Pedido actual", "eta": "20:50", "promised": null,
      "slips": false, "slipLabel": "", "isNew": true },
    { "zone": "Q5", "label": "Las Marinas", "eta": "21:05", "promised": "21:00",
      "slips": true, "slipLabel": "+5", "isNew": false }
  ],
  "capacity":   { "pizzas": "3/6", "routeMin": 22, "limitMin": 30, "state": "ok" },
  "status":     "ajuste",          // compatible | ajuste | no_recomendado | lleno
  "blocked":    false,
  "warning":    "Q5 se mueve +5",
  "explanation": "Inserir Q2 antes de Q5 retrasa Las Marinas 5 min."
}
```

`slipLabel` è **pre-calcolato dal backend** (`eta − promised`); il frontend non fa
aritmetica. Lo status si valuta sull'**intero** `routeEtas`, non sulla sola
fermata nuova.

### B.4 Esempio (route impact)

```
Q2 20:50 → Q5 21:00            compatible   (Q5 resta sul promesso)
Q2 20:50 → Q5 21:05 (+5)       ajuste       (inserire Q2 sposta Q5)
```

### B.5 Riuso del codice esistente (decisione di design)

Il route-impact NON deve duplicare la matematica giro. Opzioni valutate:

| Opzione | Pro | Contro |
|---|---|---|
| Riusare `simulateDriverSchedule` | già sincronizzato col frontend | **aggrega solo same-zone-slot** (`zones.js:337`) → non modella cross-zone single-trip; è "COPIA 1:1" del frontend, modificarlo rompe la sync |
| Riusare `buildRiderBlock` | **già modella multi-zona sequenziale** (legs cliente→cliente) | non puro (`ctx.addOven` muta `ovenLoad`); legato alla shape `manual_route`; produce molto extra |
| **Estrarre `estimateRouteDuration` (puro) + per-stop ETA nuovo** | puro, mirato, niente side-effect | un po' di logica nuova (slip a valle) |

**Scelta consigliata:** riusare la **logica pura** `estimateRouteDuration`
(`planner.js:110`, già pura: `andata_min` come proxy del salto + buffer ops) come
cuore del calcolo legs, e costruire sopra un `routeImpact.js` puro che:

1. ordina le fermate (`orderZonesByChannel` per le candidate, o ordine esplicito);
2. calcola arrivi cumulati (via `estimateRouteDuration`);
3. per ogni fermata: `eta`, `slips`, `slipLabel = +(eta − promised)` (I9-style:
   ritardo sulla promessa + tolleranza, **mai** sulla finestra del giro);
4. `routeMin` = durata totale (partenza→rientro) e `state` capacity (§B.6);
5. `status`/`blocked`/`warning` dalla policy (§B.7).

> NON modificare `simulateDriverSchedule`, `buildRiderBlock` né il planner live.
> Se serve la logica di `estimateRouteDuration` fuori da `planner.js`, **esportarla**
> (oggi è interna, esposta solo via `_internal` per i test) — questa è l'unica
> modifica al planner che il route-impact richiederà, ed è additiva (nuovo export),
> non un cambio di comportamento. Da fare solo in fase implementativa autorizzata.

### B.6 Capacity (multi-dimensione)

Riusa le basi esistenti, **una sola fonte di verità per le soglie**:

| Dimensione | Fonte | Campo |
|---|---|---|
| Pizze vs limite giro | `ZONE_DELIVERY[zona].maxOrdiniPerGiro` (`zones.js`) | `pizzas` `"3/6"` |
| Durata totale vs limite | `estimateRouteDuration().total` | `routeMin`/`limitMin` |
| Tempo max pizza in giro | **soglia da DEFINIRE — non esiste ancora** | (interno) |
| Stato sintetico | classifier | `state` ok \| tight \| full |

> **FINDING (capacity drift).** Esistono **due** sorgenti di `maxOrdiniPerGiro`:
> `ZONE_DELIVERY` in `zones.js` (per-zona: Q1=4, Q2=3, Q3=4, Q4=2, Q5=3) e
> `DEFAULTS.defaultMaxOrdiniPerGiro=3` + `snapshot.zones[...]` in `planner.js`.
> Il route-impact DEVE scegliere **una** fonte (consigliata: `ZONE_DELIVERY`, è il
> domain config reale) e documentarlo, per non divergere dal planner live.

> **FINDING (pizza-quality window).** La "soglia tempo max pizza in giro" è citata
> nel design ma **non esiste alcuna costante nel codice** (verificato: nessun match
> `quality/calidad/maxPizzaMin`). Va **definita** come nuova config in fase
> implementativa; finché non esiste, il route-impact NON deve fingere di calcolarla.

### B.7 Status semantici (decisi dal route-impact, non dal frontend)

| `status` | Significato |
|---|---|
| `compatible` | Nessuna fermata importante slitta oltre soglia, capacity OK. |
| `ajuste` | Inseribile ma impatta una fermata (es. Q5 +5). |
| `no_recomendado` | Canali diversi / qualità a rischio / giro operativo brutto. Forzabile con avviso. |
| `lleno` | Capacità rider o durata giro piena ⇒ `blocked=true`. |

La policy `status → severity/blocked` è **già implementata e testata** in
`premiumPlannerOpportunities.js` (`STATUS_SEVERITY`, `BLOCKING_STATUSES`): il
route-impact produce `status`, il mapper deriva severity/blocked. Niente
duplicazione.

---

## C. Relazione con i moduli esistenti

| Modulo | Resta | Nuovo layer NON deve |
|---|---|---|
| `deliveryChannels.js` | config canali (fonte unica `channel`) | reimplementare la mappa |
| `premiumPlannerOpportunities.js` | assembler/normalizer del contract | ricevere ETA non calcolati |
| `premiumPlannerBridge.js` | ponte da `evaluateNewOrder` (join same-zone) | essere esteso a cross-zone (è un layer diverso) |
| `planner.js` `evaluateNewOrder` | path live attuale | essere modificato o rotto dallo strategic layer |
| `manualGiros.js` | write/apply futuro | essere chiamato in preview |
| `simulateDriverSchedule` | "COPIA 1:1" frontend | essere modificato (riuso read-only o estrazione `estimateRouteDuration`) |

Flusso dati: **strategic layer** → candidate → **route-impact** → input già
calcolato → **`premiumPlannerOpportunities`** → Opportunity contract →
`previewStrategicOpportunities` / `previewManualGiro` (adapter read-only futuri).

> **FINDING (naming `canal` vs `channel`).** Mantenere l'invariante già stabilita:
> `channel` (sur|oeste|cross, direzione rotta) ≠ `canal` (WA/MANUAL, sorgente
> ordine). Lo strategic layer usa SEMPRE `channel`. Già rispettato nei moduli
> esistenti; va ribadito nei nuovi.

---

## D. Revalidate on apply (flusso futuro)

1. **preview read-only** (strategic + route-impact, nessuna scrittura);
2. operatore sceglie un'opportunità;
3. `applyManualGiro` **non scrive subito**;
4. il backend **ricalcola** strategic layer + route-impact sullo stato corrente;
5. se l'output è invariato o accettabile → conferma e scrive;
6. se è cambiato (forno slitta, nuovo ordine, driver occupato, Q5 non più
   puntuale) → restituisce **nuova preview/conferma**;
7. solo dopo, write su `manualGiros.js`.

**Mai applicare una preview stantia.** (Coerente con
`PREMIUM_PLANNER_ENGINE_DESIGN.md` §12.)

---

## E. Test plan offline (futuri)

Tutto a fixture: niente DB/fetch/env/dati reali.

### Strategic layer
1. Q2 current + Q5 future 21:00 → candidate `sur` / `agregar`.
2. Q1 current + Q2+Q5 → candidate `sur` / rotta ordinata.
3. Q3 current + Q5 future → `no_recomendado` cross (canali diversi).
4. nessun giro futuro compatibile → solo `crear` / `directa`.
5. capacity piena → `lleno` / `blocked`.

### Route-impact
1. Q2 inserito prima di Q5, Q5 resta puntuale → `compatible`, `slipLabel:""`.
2. Q2 inserito prima di Q5, Q5 slitta → `ajuste`, `slipLabel:"+5"`.
3. Q1+Q2+Q5, capacity ok → `compatible`.
4. Q1+Q2+Q5, `routeMin` troppo lungo → `lleno`/`no_recomendado`.
5. forno_out di una pizza oltre la partenza → blocco/warning prontezza.
6. driver non disponibile in tempo → blocco/warning rider.

### E2E
strategic candidate → route-impact → `premiumPlannerOpportunities` →
contract shape (`premium-planner-popup-lab-v2`), come l'attuale
`tests/premiumPlannerBridgeE2E.test.js` ma sul percorso cross-zone.

> **FINDING (warning ajuste poco chiaro).** Nell'E2E attuale
> (`premiumPlannerBridgeE2E.test.js` scenario E) il `warning` di un `ajuste` =
> `option.reason` positiva ("aggregabile…"), che **non** comunica il ritardo. Il
> route-impact dovrà produrre un warning esplicito ("Q5 se mueve +5") per gli
> `ajuste`. È una lacuna di copertura/UX da chiudere nel nuovo layer.

---

## F. Non-goals (questa fase)

- nessun endpoint;
- nessuna scrittura DB / migration / env / secret;
- nessun wiring produzione (`index.js`, orchestrator WhatsApp, API dispatcher);
- nessuna logica frontend;
- nessun Google routing in V1 (resta schema a zone);
- **single-rider** (no multi-rider, coerente con la nota di interpretazione V1);
- nessun apply automatico (sempre operatore-in-the-loop).

---

## G. Moduli futuri (riepilogo, NON implementati qui)

| Modulo (futuro) | Tipo | Ruolo |
|---|---|---|
| `src/core/delivery/premiumPlannerStrategic.js` | puro | candidate cross-zone per canale + ranking |
| `src/core/delivery/routeImpact.js` | puro | ETA/slip/capacity/status sull'intera rotta |
| (export) `estimateRouteDuration` da `planner.js` | additivo | riuso legs puri |
| `previewStrategicOpportunities` / `previewManualGiro` | read-only adapter | apertura popup / click su giro |

Implementazione **solo** in fase autorizzata. Niente di tutto questo è wired oggi.
