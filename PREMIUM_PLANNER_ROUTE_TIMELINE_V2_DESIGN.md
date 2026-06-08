# Premium Planner — `routeTimeline v2`

> **Status:** DESIGN CONTRACT — no runtime, no deploy, no write.
> **Scopo:** esporre al frontend una **linea del giro già calcolata dal backend**
> (Pizzería → Q2 → Q5 → Regreso), con orari, ritardi, rischio e messaggio
> operatore. Il frontend **disegna e basta**: nessun calcolo.
>
> **Tipo:** estensione **additiva** e **retrocompatibile** del contract live
> `premium-planner-strategic-preview-v1`. Non sostituisce nulla. Se assente, il
> renderer attuale continua a funzionare.
>
> **Next target tecnico (Step C):** backend pure mapper
> `buildRouteTimeline(...)` + test offline. Questo documento NON contiene codice
> runtime: congela solo lo schema, la semantica, le regole di rischio, i fixture
> canonici e i criteri di test.
>
> **Audit di riferimento:** verdetto `BACKEND_TIMELINE_AUDIT_READY`. Vedi anche
> `PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md` (§A strategic, §B routeImpact),
> `PREMIUM_PLANNER_READONLY_ADAPTER_DESIGN.md`.

---

## 1. Titolo e status

- **Nome:** Premium Planner `routeTimeline v2`.
- **Status:** design contract. No runtime, no deploy, no commit di moduli JS.
- **Versione contract campo:** `"route-timeline-v2"`.
- **Obiettivo unico:** dare al frontend una timeline completa e già risolta,
  così l'operatore vede *il transito* del giro e non solo una card riassuntiva.

---

## 2. Problema che risolve

Oggi, nel contract live:

1. `routeEtas[]` contiene **solo le consegne** (le zone). Esempio reale:
   `[{ zone:"Q5", eta:"21:15", promised:"21:00", slipLabel:"+15", isNew:true }]`.
2. La **partenza** del rider non arriva al frontend: è `startTime`, usato per il
   calcolo ma **non emesso come nodo**.
3. Il **ritorno** non arriva al frontend: il motore `routeImpact` calcola
   `driverReturn` (e `routeMin`), ma il bridge **li scarta** (`premiumPlannerBridge`
   estrae solo `routeEtas/capacity/status/blocked/warning/explanation`).
4. Il frontend **non deve** ricostruire questi orari (è renderer-only): se lo
   facesse, inventerebbe dati → linea bella ma falsa.

Risultato: la linea "Pizzería → Q2 → Q5 → Regreso" **è già calcolata dentro il
backend**, ma non è esposta in forma disegnabile. `routeTimeline v2` chiude
esattamente questo buco di contract — **senza nuove dipendenze dati** per i casi
in-canale: usa numeri che il motore già produce.

---

## 3. Principi duri

- **Backend calcola, frontend disegna.** Ogni orario/ritardo/rischio/margine è
  output del backend.
- **Additivo e retrocompatibile.** `routeTimeline` è un campo *opzionale* dentro
  ogni opportunity (e dentro `bestProposal`). Il contract id resta
  `premium-planner-strategic-preview-v1`; il campo è nuovo, i client vecchi lo
  ignorano.
- **Fallback grazioso.** Se `routeTimeline` manca → il frontend usa il renderer
  attuale (card + `routeEtas`). Mai errore, mai linea vuota inventata.
- **Read-only.** Nessun apply, nessuna scrittura, nessun `manual_giro`. `safety`
  invariato (`readOnly:true, writes:false, pii:"redacted"`).
- **No `Date.now`.** La partenza è `startTime` esplicito; assente → niente
  timeline (blocker `missing_start_time`, come oggi).
- **No orari inventati.** Una tappa senza ETA reale ha `eta:null`, mai uno 0 o
  un orario plausibile.
- **No cross-channel verde inventato.** Canali misti → mai `risk:"ok"`.
- **No same-zone false Premium.** Gli anchor same-zone del current restano
  dominio del planner classico (filtro A1 già in `buildAnchorsFromSnapshot`): non
  generano opportunity Premium e quindi nessuna timeline finta.

---

## 4. Schema contract proposto

`routeTimeline` è additivo **dentro** ciascuna opportunity (e `bestProposal`):

```jsonc
{
  // ... campi opportunity v1 invariati (id, kind, status, routeEtas, ...) ...
  "routeTimeline": {
    "version": "route-timeline-v2",
    "proposalId": "opp-q2-q5-2100",
    "summary": {
      "directEta": "20:40",                 // baseline.directEta (consegna diretta del nuovo pedido)
      "giroEta": "21:05",                   // ETA dell'ULTIMA consegna del giro (la decisiva)
      "returnEta": "21:18",                 // driverReturn (rientro pizzería)
      "tradeoffLabel": "+25 vs directa · 1 viaje ahorrado"
    },
    "risk": "tight",                        // enum §5
    "operatorMessage": "Se puede: Q2 entra antes, Q5 cede +5. Margen muy justo.",
    "timeline": [
      { "seq": 0, "type": "departure", "zone": null,  "label": "Pizzería",
        "eta": "20:42", "promised": null,    "slipLabel": null, "status": "ok",
        "marginLabel": null, "isNewOrder": false, "isAnchor": false, "warning": null },
      { "seq": 1, "type": "delivery",  "zone": "Q2",  "label": "Pedido actual",
        "eta": "20:50", "promised": null,    "slipLabel": null, "status": "ok",
        "marginLabel": null, "isNewOrder": true,  "isAnchor": false, "warning": null },
      { "seq": 2, "type": "delivery",  "zone": "Q5",  "label": "Pedido Q5",
        "eta": "21:05", "promised": "21:00", "slipLabel": "+5",  "status": "ajuste",
        "marginLabel": "−5 vs prometido", "isNewOrder": false, "isAnchor": true, "warning": "Q5 se mueve +5 min" },
      { "seq": 3, "type": "return",    "zone": null,  "label": "Regreso pizzería",
        "eta": "21:18", "promised": null,    "slipLabel": null, "status": "ok",
        "marginLabel": null, "isNewOrder": false, "isAnchor": false, "warning": null }
    ]
  }
}
```

### Semantica dei campi

**Top-level `routeTimeline`**

| Campo | Tipo | Valori / regola |
|---|---|---|
| `version` | string | costante `"route-timeline-v2"`. Permette evoluzioni future. |
| `proposalId` | string | uguale a `opportunity.id`. Lega la linea alla proposta selezionata. |

**`summary`**

| Campo | Tipo | Semantica |
|---|---|---|
| `directEta` | string `HH:MM` \| null | consegna **diretta sin giro** del nuovo pedido = `baseline.directEta`. null se baseline non disponibile. |
| `giroEta` | string `HH:MM` \| null | ETA dell'**ultima consegna** del giro (la tappa decisiva, tipicamente l'anchor). null se nessuna consegna con ETA. |
| `returnEta` | string `HH:MM` \| null | rientro rider = `driverReturn`. null se travel di ritorno mancante. |
| `tradeoffLabel` | string | frase già redatta. Pattern: `"+{Δ} vs directa"` (Δ = `giroEta − directEta`, minuti) `· 1 viaje ahorrado` se `kind=="agregar"`. Stringa vuota se non calcolabile. |

**`risk`** · string · enum §5 (rollup di proposta).

**`operatorMessage`** · string · **una frase** in spagnolo, già redatta dal
backend, leggibile dall'operatore (no codici, no PII). Composta da
status + slip + margine. Stringa vuota mai: minimo descrittivo.

**`timeline[]`** — array ordinato per `seq` crescente. Sempre presente; minimo 2
nodi (`departure` + `return`) anche per route bloccate.

| Campo | Tipo | Valori / regola |
|---|---|---|
| `seq` | int ≥ 0 | indice ordinale **stabile** (0 = departure). Il frontend disegna in quest'ordine, non riordina. |
| `type` | string | `departure \| delivery \| return` (§5). Esattamente un `departure` (seq 0) e un `return` (ultimo). |
| `zone` | string \| null | `Q1..Q5` per `delivery`; `null` per `departure`/`return`. |
| `label` | string | etichetta presentazionale **non-PII** (es. "Pizzería", "Pedido actual", "Pedido Q5"). Mai nome cliente. |
| `eta` | string `HH:MM` \| null | orario stimato della tappa. `null` se travel mancante / route bloccata (mai 0, mai inventato). |
| `promised` | string `HH:MM` \| null | promessa originale dell'anchor (= `hora` ordine). `null` per departure/return e per il nuovo pedido flessibile. |
| `slipLabel` | string \| null | `"+N"` se la tappa slitta oltre la promessa (+ tolleranza). `null`/`""` se nessuno slip o nessun `promised`. **Già calcolato** (`routeImpact`). |
| `status` | string | stato **per-tappa**, enum §5. departure/return = `ok` (o `blocked` se l'intera route è bloccata). |
| `marginLabel` | string \| null | margine leggibile della tappa rispetto alla promessa: `"−N vs prometido"` (in ritardo) o `"+N margen"` (in anticipo). `null` se nessun `promised`. **Derivazione v2** (`promised − eta`, backend-side). |
| `isNewOrder` | bool | `true` sulla tappa del pedido in bozza (= `routeEtas[].isNew`). |
| `isAnchor` | bool | `true` su una consegna di un ordine **già esistente** (anchor). Per le `delivery`: `!isNewOrder`. departure/return = `false`. |
| `warning` | string \| null | avviso già redatto per la tappa (es. "Q5 se mueve +5 min"). `null` se nessuno. |

---

## 5. Enum e regole

### `type` (nodo)
`departure | delivery | return`
- `departure`: nodo 0, Pizzería, `eta = startTime` (uscita rider). `zone:null`.
- `delivery`: una consegna (nuovo pedido o anchor). `zone` valorizzata.
- `return`: ultimo nodo, rientro pizzería, `eta = driverReturn`. `zone:null`.

### `risk` (rollup proposta)
`ok | tight | warning | no_recomendado | full | blocked`

| `risk` | Quando | Sorgente engine |
|---|---|---|
| `ok` | route compatibile, nessuno slip, margine comodo | `status:"compatible"` + slack > soglia |
| `tight` | compatibile (nessuno slip) **ma margine molto giusto** | `status:"compatible"` + `min(slackPromessa, limitMin−routeMin) ≤ MARGIN_TIGHT_THRESHOLD_MIN` |
| `warning` | **una tappa slitta** +N (forzabile, promessa sforata ma giro fattibile) | `status:"ajuste"` |
| `no_recomendado` | canali misti, rotta troppo lunga, qualità pizza a rischio | `status:"no_recomendado"` (incl. override cross) |
| `full` | capacità pizze oltre il max | `status:"lleno"` / `capacity.state:"full"` |
| `blocked` | candidato non viabile: travel mancante / cross hard / route impact assente | `blocked:true` + `routeEtas:[]` / `missing_travel_times` |

> `MARGIN_TIGHT_THRESHOLD_MIN`: soglia (consigliata **3 min**) che il mapper usa
> per distinguere `ok` da `tight`. È l'UNICA nuova derivazione di "vicinanza al
> limite": il motore oggi marca `tight`/`durationOver` solo quando si è **già
> oltre** il limite; `routeTimeline` aggiunge il "vicino-ma-non-oltre" da numeri
> esistenti (`routeMin`, `limitMin`, `promised`, `eta`). Backend math, non frontend.

### `status` (per-tappa)
`ok | ajuste | tight | warning | no_recomendado | lleno | blocked`
- `ok`: tappa puntuale (nessuno slip; margine comodo o nessun `promised`).
- `ajuste`: la tappa slitta `slipLabel="+N"` oltre la promessa, entro forzabile.
- `tight`: tappa puntuale ma con `marginLabel` ≤ soglia (margine giusto).
- `warning`: slip importante / vicino a non-recomendado (uso prudente).
- `no_recomendado`: tappa parte di una route non raccomandata (cross / troppo lunga).
- `lleno`: tappa parte di un giro a capacità piena.
- `blocked`: tappa di una route bloccata (eta `null`).

Coerenza: `risk` è il **rollup** del caso peggiore tra le tappe `delivery`
(precedenza: `blocked` > `full`/`lleno` > `no_recomendado` > `warning` > `tight` > `ok`).

### Regole di derivazione
- **slip +N:** se una `delivery` ha `slipLabel="+N"` → `status:"ajuste"`,
  `warning` redatto, contribuisce `risk` ≥ `warning`.
- **`capacity.state`:** `full` → `risk:"full"`, status tappe `lleno`, `blocked`
  considerato per l'apply; `tight`/`durationOver` engine → `risk:"no_recomendado"`
  se OLTRE il limite, `risk:"tight"` se SOTTO ma vicino (soglia).
- **`missing_travel_times`:** `routeImpactInput == null` → timeline minima
  (departure + delivery con `eta:null` + return con `eta:null`), `risk:"blocked"`,
  `operatorMessage` prudente. **Mai ETA fantasma.**
- **same-zone:** non genera opportunity Premium (filtro A1) → nessuna timeline.
- **cross-channel:** override `no_recomendado`/`blocked` (già in
  `mapCandidateToOpportunity`) → `risk` ≥ `no_recomendado`, **mai `ok`/`tight`**.

---

## 6. I 5 fixture canonici

> Numeri coerenti con `deliveryLegs` (Pizzería→Q2=7, Q2→Q5=10, Q5→Pizzería=15,
> Pizzería→Q5=15) e `serviceMin=2`. Tutti **sanitizzati, no-PII**. Sono pronti a
> diventare test del mapper (Step C): `input → expected`.

### A. Compatible pulito (`risk:"ok"`)
**Input sintetico**
```jsonc
{ "startTime":"20:41",
  "currentOrderDraft": { "zone":"Q2", "hora":null, "pizzas":2 },
  "anchors": [ { "zone":"Q5", "hora":"21:00", "pizzas":2 } ],
  "capacity": { "maxPizzas":6, "routeMinLimit":40 } }
```
**Expected timeline**
```jsonc
[ { "seq":0,"type":"departure","zone":null,"label":"Pizzería","eta":"20:41","status":"ok","isNewOrder":false,"isAnchor":false },
  { "seq":1,"type":"delivery","zone":"Q2","label":"Pedido actual","eta":"20:48","promised":null,"slipLabel":null,"status":"ok","isNewOrder":true,"isAnchor":false },
  { "seq":2,"type":"delivery","zone":"Q5","label":"Pedido Q5","eta":"21:00","promised":"21:00","slipLabel":null,"status":"ok","marginLabel":"+0 margen","isNewOrder":false,"isAnchor":true },
  { "seq":3,"type":"return","zone":null,"label":"Regreso pizzería","eta":"21:17","status":"ok","isNewOrder":false,"isAnchor":false } ]
```
**Expected summary** `{ directEta:"20:48", giroEta:"21:00", returnEta:"21:17", tradeoffLabel:"+12 vs directa · 1 viaje ahorrado" }`
**risk/operatorMessage** `risk:"ok"` · `"Compatible: Q2 entra antes de Q5, sin retrasos."`
**L'operatore vede:** linea verde Pizzería → Q2 (nuevo) → Q5 (anchor, puntual) → Regreso, Q5 rispetta le 21:00.
**Il frontend NON deve:** calcolare ETA, dedurre che è verde, sommare i leg.

### B. Ajuste +5 (`risk:"warning"`)
**Input** come A ma `startTime:"20:46"`.
**Expected timeline** (Q2 20:53, Q5 21:05)
```jsonc
[ { "seq":0,"type":"departure","eta":"20:46","status":"ok" },
  { "seq":1,"type":"delivery","zone":"Q2","eta":"20:53","promised":null,"status":"ok","isNewOrder":true },
  { "seq":2,"type":"delivery","zone":"Q5","eta":"21:05","promised":"21:00","slipLabel":"+5","status":"ajuste","marginLabel":"−5 vs prometido","isAnchor":true,"warning":"Q5 se mueve +5 min" },
  { "seq":3,"type":"return","eta":"21:22","status":"ok" } ]
```
**Expected summary** `{ directEta:"20:53", giroEta:"21:05", returnEta:"21:22", tradeoffLabel:"+12 vs directa · 1 viaje ahorrado" }`
**risk/operatorMessage** `risk:"warning"` · `"Se puede, pero Q5 cede +5 min sobre lo prometido (21:00 → 21:05)."`
**L'operatore vede:** linea ámbar, badge `+5` su Q5, promessa sforata ma giro fattibile.
**Il frontend NON deve:** confrontare eta vs promised per ricavare il +5 (arriva già pronto).

### C. Margen muy justo (`risk:"tight"`)
**Input** come A ma `capacity.routeMinLimit:38` (route ~36 min, slack 2 ≤ soglia 3) e Q5 puntuale.
**Expected timeline** identica ad A (nessuno slip), ma `capacity` vicino al limite:
```jsonc
[ { "seq":0,"type":"departure","eta":"20:41","status":"ok" },
  { "seq":1,"type":"delivery","zone":"Q2","eta":"20:48","status":"ok","isNewOrder":true },
  { "seq":2,"type":"delivery","zone":"Q5","eta":"21:00","promised":"21:00","slipLabel":null,"status":"tight","marginLabel":"+0 margen","isAnchor":true },
  { "seq":3,"type":"return","eta":"21:17","status":"ok" } ]
```
**Expected summary** `{ directEta:"20:48", giroEta:"21:00", returnEta:"21:17", tradeoffLabel:"+12 vs directa · 1 viaje ahorrado" }`
**risk/operatorMessage** `risk:"tight"` · `"Se puede, pero margen muy justo: Q5 llega al filo de las 21:00 y la ruta roza el límite."`
**L'operatore vede:** linea ámbar "tight", nessun ritardo ma avviso "margine giusto".
**Il frontend NON deve:** decidere che è tight; la soglia margine è backend.

### D. Cross-channel no recomendado (`risk:"no_recomendado"`/`blocked`)
**Input** nuovo `Q5` (sur) + anchor `Q3` (oeste) → cross; leg `Q5→Q3` assente.
```jsonc
{ "startTime":"20:50",
  "currentOrderDraft": { "zone":"Q5", "hora":null, "pizzas":2 },
  "anchors": [ { "zone":"Q3", "hora":"21:10", "pizzas":2 } ] }
```
**Expected timeline** (nessun ETA: travel mancante)
```jsonc
[ { "seq":0,"type":"departure","zone":null,"label":"Pizzería","eta":null,"status":"no_recomendado" },
  { "seq":1,"type":"delivery","zone":"Q5","eta":null,"promised":null,"status":"no_recomendado","isNewOrder":true },
  { "seq":2,"type":"delivery","zone":"Q3","eta":null,"promised":"21:10","status":"no_recomendado","isAnchor":true },
  { "seq":3,"type":"return","zone":null,"eta":null,"status":"no_recomendado" } ]
```
**Expected summary** `{ directEta:null, giroEta:null, returnEta:null, tradeoffLabel:"" }`
**risk/operatorMessage** `risk:"no_recomendado"` (o `blocked` se si preferisce capacità dura) · `"Canales distintos (sur/oeste): no recomendado. Forzable solo con aviso."`
**L'operatore vede:** linea rossa "No recomendado", zone evidenziate ma **senza orari**.
**Il frontend NON deve:** mostrarla verde, inventare ETA, suggerire che conviene.

### E. Lleno / capacity (`risk:"full"`)
**Input** nuovo `Q2` (3 pizzas) + anchor `Q5` (4 pizzas) = 7 > max 6.
```jsonc
{ "startTime":"20:41",
  "currentOrderDraft": { "zone":"Q2", "hora":null, "pizzas":3 },
  "anchors": [ { "zone":"Q5", "hora":"21:00", "pizzas":4 } ],
  "capacity": { "maxPizzas":6, "routeMinLimit":40 } }
```
**Expected timeline** (orari calcolabili, ma capacità piena)
```jsonc
[ { "seq":0,"type":"departure","eta":"20:41","status":"ok" },
  { "seq":1,"type":"delivery","zone":"Q2","eta":"20:48","status":"lleno","isNewOrder":true },
  { "seq":2,"type":"delivery","zone":"Q5","eta":"21:00","promised":"21:00","status":"lleno","isAnchor":true },
  { "seq":3,"type":"return","eta":"21:17","status":"ok" } ]
```
**Expected summary** `{ directEta:"20:48", giroEta:"21:00", returnEta:"21:17", tradeoffLabel:"+12 vs directa · 1 viaje ahorrado" }`
**risk/operatorMessage** `risk:"full"` · `"Giro lleno: 7/6 pizzas. No entra más en este giro."`
**L'operatore vede:** linea rossa "capacidad llena 7/6", non si aggiunge.
**Il frontend NON deve:** dedurre il pieno; e **mai** `full` quando `maxPizzas`
è `null` (capacità ignota → `risk` su soli tempi, vedi §5 / test 6).

---

## 7. Regole di mapping dal v1 attuale

Il mapper `buildRouteTimeline` userà **dati già esistenti** (nessuna nuova fonte
per i casi in-canale):

| v2 | Sorgente v1 (già calcolata) |
|---|---|
| nodo `departure.eta` | `routeImpactInput.startTime` (= `startTime`) |
| nodi `delivery` | `routeImpact.routeEtas[]` (eta/promised/slipLabel/label/zone) |
| `delivery.eta / promised / slipLabel` | pass-through da `routeEtas[]` |
| `delivery.isNewOrder` | `routeEtas[].isNew` |
| `delivery.isAnchor` | `!routeEtas[].isNew` |
| nodo `return.eta` | `routeImpact.driverReturn` **(oggi droppato dal bridge — va NON droppato)** |
| `summary.directEta` | `baseline.directEta` |
| `summary.giroEta` | ETA dell'ultima `delivery` |
| `summary.returnEta` | `driverReturn` |
| `summary.tradeoffLabel` | composto da `giroEta − directEta` (+ "1 viaje ahorrado" se `kind=="agregar"`) |
| `risk` | da `status` + `capacity.state` + soglia margine (`routeMin`/`limitMin`) |
| `status` per-tappa | da slip della tappa + rollup route |
| `marginLabel` | `promised − eta` (backend math, helper `routeImpact.toMin/fromMin`) |
| `operatorMessage` | composto da `warning` + `explanation` + slip/margine |
| `warning` per-tappa | `routeImpact.warning` (per la tappa che slitta) |

Note operative per Step C:
- Il mapper riceve l'**impact completo** (`buildRouteImpact(routeImpactInput)`),
  non solo i 6 campi del bridge: serve `driverReturn` e `routeMin`. ⇒ o si chiama
  `buildRouteImpact` direttamente nel mapper, o si estende
  `buildRouteImpactOpportunityFields` per includere `driverReturn`/`routeMin`.
- Niente lettura di `startTime` dall'orologio: arriva dall'input.

---

## 8. Test plan per Step C (pure mapper offline)

Test deterministici, zero IO. Casi minimi:

1. **emits departure & return** — timeline ha `type:"departure"` (seq 0, eta=startTime) e `type:"return"` (ultimo, eta=driverReturn).
2. **preserves delivery order** — `delivery` nodes in ordine di `seq`, identico all'ordine `routeEtas`.
3. **marks new vs anchor** — `isNewOrder` su `isNew:true`; `isAnchor` su `!isNew`.
4. **exposes slip labels** — `slipLabel` pass-through, nessun ricalcolo eta−promised nel mapper (riusa quello dell'impact).
5. **computes risk tight** — compatibile + slack ≤ soglia → `risk:"tight"`; slack > soglia → `risk:"ok"`.
6. **no false full when capacity null** — `maxPizzas:null` → `risk` MAI `full`; resta su tempi (`ok`/`tight`/`warning`).
7. **cross-channel no recomendado** — input cross → `risk ∈ {no_recomendado, blocked}`, nessun nodo verde, ETA possono essere `null`.
8. **missing travel times blocked/safe** — `routeImpactInput:null` → timeline minima con `eta:null`, `risk:"blocked"`, `operatorMessage` prudente, nessun ETA fantasma.
9. **no `Date.now`** — output identico a parità di input, indipendente dall'orario reale (grep anti-`Date.now`/`new Date` nel modulo).
10. **no DB/fetch/env** — modulo puro, zero import runtime (solo helper puri: `routeImpact`, `deliveryChannels`).
11. **deterministic output** — stesso input → stesso output (snapshot test sui 5 fixture A–E).
12. **summary coerente** — `giroEta` = ultima delivery; `returnEta` = return node; `directEta` = baseline.

---

## 9. Frontend implications (futuro renderer, non in questo blocco)

- Se `opportunity.routeTimeline` esiste → disegna la **linea** (departure →
  delivery… → return) con orari, badge slip, colore da `risk`/`status`.
- Se manca → usa la **card attuale** (`routeEtas` + summary v1). Nessun errore.
- Click su una proposta → **seleziona** e illumina la sua timeline + zone su
  mappa (estende il `selectedOppId` già esistente).
- CTA `Aplicar propuesta` resta **no-op** nel LAB.
- **Nessuna aritmetica frontend:** orari/ritardi/margine/risk arrivano pronti.
- **Nessuna scrittura.** Read-only, badge `read-only ✓ · sin escrituras`.
- Posizione del nuovo ordine ("antes de Q5 / entre Q2 y Q5 / después") = lettura
  di `seq` + `isNewOrder`, **non** calcolo.

---

## 10. Rischi e non-goals

**Non-goals (questo contract NON fa):**
- non implementa `apply` / `applyManualGiro`;
- non crea `manual_giro`;
- non tocca il DB (né lettura aggiuntiva: usa l'impact già calcolato);
- non risolve geo real-time / Google routing;
- non cambia la travel matrix (`deliveryLegs`);
- non sostituisce il planner classico same-zone (`evaluateNewOrder`).

**Rischi da presidiare:**
- *Frontend che inventa* → regola "no `routeTimeline` ⇒ no linea".
- *Linea bella ma falsa con anchor vuoti* → badge `source` (`offline-readonly`
  vs `mock`) dominante; `opportunities:[]` resta vuoto, non finto.
- *Confondere preview con apply* → CTA no-op, `safety.writes:false`.
- *Cross-channel verde* → mai `risk:"ok"` su canali misti.
- *False `full`* → `maxPizzas` null ⇒ mai `full` (test 6).
- *`marginLabel` ingannevole* → è `promised − eta`; per il nuovo pedido senza
  `promised` resta `null`, non un margine inventato.
- *Buco legs intra-oeste* (`Q1→Q3`, `Q1→Q4` assenti) → quelle route cadono in
  `missing_travel_times`/`blocked` finché la matrice non viene estesa (fuori
  scope qui, segnalato).

---

## 11. Prossimo micro-blocco raccomandato

**Step C — backend pure mapper `buildRouteTimeline(...)` + test offline.**

- **Modulo nuovo (probabile):** `src/core/delivery/routeTimeline.js` — puro,
  zero IO, `buildRouteTimeline(impact, candidate, currentOrder, opts)` →
  l'oggetto `routeTimeline` di §4. Riusa `routeImpact` (per `driverReturn`,
  `toMin/fromMin`) e `deliveryChannels` (label/sequenza). Niente `Date.now`,
  niente DB/fetch/env.
- **Modulo da estendere (minimo):** `routeImpact.js` →
  `buildRouteImpactOpportunityFields` include `driverReturn`/`routeMin` (oggi
  scartati), oppure il mapper chiama `buildRouteImpact` direttamente.
- **Wiring (solo dopo i test):** `previewStrategicOpportunities.js` allega
  `routeTimeline` a ciascuna opportunity e a `bestProposal` — **additivo**, il
  contract id resta `premium-planner-strategic-preview-v1`.
- **Test nuovo:** `tests/routeTimeline.test.js` — i 12 casi del §8 sui 5 fixture
  A–E del §6.
- **Frontend:** invariato in Step C (solo backend). Il renderer timeline è un
  blocco successivo (Step D).

Nessun deploy, nessun apply, nessuna scrittura in Step C: solo mapper puro + test.
