# Premium Planner — `previewManualGiroRoute` (Design Contract)

> **Status:** design contract · **read-only** · **NO runtime code** · **NO deploy** · **NO commit** finché non approvato.
> **Scope:** definire input/output/validazioni/fixture per una nuova action backend read-only che, data una **sequenza di tappe scelta dall'operatore**, restituisce una `routeTimeline` v2 già pronta (ETA, ritardi, rischio, messaggio operatore).
> **Non scope:** implementazione, dispatcher wiring, test runtime, deploy, creazione/apply di giri reali.

Documenti correlati (stesso tema, già presenti nel repo):
`PREMIUM_PLANNER_ROUTE_TIMELINE_V2_DESIGN.md` (shape `route-timeline-v2`),
`PREMIUM_PLANNER_STRATEGIC_LAYER_DESIGN.md` + `PREMIUM_PLANNER_DISPATCHER_WIRING_DESIGN.md` (pattern action `/api` read-only),
`PREMIUM_PLANNER_READONLY_ADAPTER_DESIGN.md`, `PREMIUM_PLANNER_ENGINE_DESIGN.md`.

---

## 1. Titolo e status

- **Action:** `previewManualGiroRoute`
- **Status:** design contract · read-only · no runtime · no deploy.
- **Scopo:** calcolare una `routeTimeline` v2 per una **sequenza di tappe proposta dall'operatore** (es. `Pedido actual Q2 → anchor Q5`), restituendo ETA per tappa, ritardo (slip) vs prometido, rischio di rotta e un `operatorMessage` già redatto. Il frontend la disegna così com'è (renderer-only).

---

## 2. Problema che risolve

Oggi il Premium Planner ha **una sola** modalità di preview lato backend:

- `previewStrategicOpportunities` → **il backend suggerisce** le opportunità (giri/huecos) partendo dagli **anchor reali** dello snapshot read-only. L'operatore sceglie *tra* proposte già generate dal motore.

Manca la modalità inversa, richiesta dal prodotto:

- L'operatore guarda la mappa/linea e dice **"calcolami QUESTO giro"** — clicca una sequenza di zone/tappe (es. Q2 → Q5) e vuole sapere subito se regge e con che tempi.

Vincoli che rendono necessaria una action backend dedicata:

- **Il frontend è renderer-only**: non può calcolare ETA, ritardi, route impact, margini, capacity, status, rischio, compatibilità né orari (vedi §3). Può solo raccogliere i click e mandare la **sequenza** al backend.
- `previewStrategicOpportunities` **non accetta** un set di tappe scelto a mano: decide lui gli anchor. Quindi serve un nuovo contract che riceva `selectedStops` e restituisca una `routeTimeline` vera.

`previewManualGiroRoute` colma esattamente questo: **input = sequenza dell'operatore**, **output = `routeTimeline` v2 calcolata backend-side**.

---

## 3. Principi duri

- **read-only**: nessuna scrittura DB.
- **Nessun `manual_giro` creato** (la action non scrive su `manual_giros`).
- **Nessun ordine creato/modificato**, nessun `cambiaStato`.
- **Nessun WhatsApp** inviato.
- **No PII**: mai nome/telefono/indirizzo in input echo o output. Solo `zone/hora/pizzas/promised/label generica`.
- **Safety block obbligatorio** in ogni risposta (anche errori): `{ "readOnly": true, "writes": false, "pii": "redacted" }`.
- **Frontend renderer-only**: il backend restituisce la `routeTimeline` GIÀ pronta.
- **Nessun `Date.now`**: lo `startTime` è esplicito nell'input (orologio = responsabilità del chiamante/draft, mai del server).
- **Nessun `apply`** in questa fase: la action *valuta soltanto*. La creazione reale del giro e la `revalidate-on-apply` sono un blocco futuro separato (vedi §15).
- **Determinismo**: stessi input → stesso output (mapper puri `routeImpact` + `buildRouteTimeline`).

---

## 4. Nome action e meccanismo

- **Action name:** `previewManualGiroRoute`
- **Dispatch:** ramo nel dispatcher `app.post("/api")` di `index.js` (stesso pattern di `previewStrategicOpportunities`).
- **Auth:** riusa il gate comune `app.use("/api", …)` (header `x-api-key` = `DASHBOARD_API_KEY`) già presente PRIMA di `app.post("/api")`. Nessun gate nuovo.
- **Output:** JSON safe (sezione §7).
- **Errori:** controllati e safe (sezione §6) — mai stacktrace/env/token/PII; il `catch` del POST resta `internal_error` come per le altre action.
- **DB:** di default **nessun accesso**. SELECT read-only **solo se** servono `anchorId` da risolvere (zona/promised non forniti dal client) — vedi §6 e §11; in tal caso via `createReadOnlyRestDb({ sbSelect })` (allowlist SELECT, no PII), come lo strategic layer.

---

## 5. Input contract proposto (v1)

```json
{
  "action": "previewManualGiroRoute",
  "startTime": "20:42",
  "currentOrderDraft": {
    "tipoConsegna": "DOMICILIO",
    "zone": "Q2",
    "hora": "21:00",
    "horaFlexible": false,
    "pizzas": 2
  },
  "selectedStops": [
    { "type": "current_order", "zone": "Q2", "label": "Pedido actual" },
    { "type": "anchor", "zone": "Q5", "anchorId": 123, "promised": "21:00", "label": "Las Marinas" }
  ],
  "includeReturn": true,
  "includeCrossZone": true,
  "capacity": { "pizzas": 3, "limitMin": 30 }
}
```

### Decisione: `selectedStops` come fonte primaria (non solo `selectedZones`)

- **`selectedStops` è il contract v1 canonico.** Trasporta, per ogni tappa, il *ruolo* (`current_order` vs `anchor`), la `promised` (necessaria per calcolare lo slip) e l'eventuale `anchorId`. Solo zone (`selectedZones`) non basta: senza `promised`/`type` il backend non sa quale tappa è il nuovo ordine, né rispetto a cosa misurare il ritardo.
- **`selectedZones: ["Q2","Q5"]` accettato come shorthand LAB** (back-compat / prototipazione): se presente e `selectedStops` assente, il backend espande ogni zona in uno stop `{type:"anchor", zone}` (la zona uguale a `currentOrderDraft.zone` → `current_order`), `promised`/`anchorId` null. È una comodità; **il design punta a `selectedStops`** e la UI definitiva deve mandare `selectedStops`.

### Campi

| Campo | Tipo | Obbligatorio | Descrizione |
|---|---|---|---|
| `action` | string | sì | `"previewManualGiroRoute"`. |
| `startTime` | `"HH:MM"` | sì | Ora di **uscita rider** dalla pizzería. Esplicita, mai `Date.now`. È l'origine del nodo `departure`. |
| `currentOrderDraft` | object | sì | Bozza del nuovo ordine (no-PII). |
| `currentOrderDraft.tipoConsegna` | `"DOMICILIO"`/`"RITIRO"` | sì | Solo `DOMICILIO` produce un giro; `RITIRO` → blocker (un pickup non entra in un giro di consegna). |
| `currentOrderDraft.zone` | string (`Q1..Q5`) | sì | Zona del nuovo ordine. `null`/vuoto → `missing_zone`. |
| `currentOrderDraft.hora` | `"HH:MM"` | no | Ora promessa al cliente del nuovo ordine; usata come `promised` della tappa `current_order` se lo stop non la porta. |
| `currentOrderDraft.horaFlexible` | bool | no | Solo informativo (la flessibilità non cambia il calcolo qui; default `false`). |
| `currentOrderDraft.pizzas` | number | no | Pizze del nuovo ordine; concorre alla capacity totale del giro. Default 0. |
| `selectedStops` | array | sì (o `selectedZones`) | Sequenza ORDINATA di tappe scelte dall'operatore. Vuoto → `empty_selected_stops`. |
| `selectedStops[].type` | `"current_order"`/`"anchor"` | sì | Ruolo della tappa. Esattamente **un** `current_order` (vedi `duplicate_current_order`). `anchor` = ordine già esistente toccato dal giro. Altro valore → `invalid_stop_type`. |
| `selectedStops[].zone` | string (`Q1..Q5`) | sì | Zona della tappa. Sconosciuta → `invalid_zone`. |
| `selectedStops[].anchorId` | number/string | no | Id dell'ordine ancla (se la tappa è un ordine reale). Opzionale: se assente, la tappa è valutata coi soli `zone`/`promised` forniti. |
| `selectedStops[].promised` | `"HH:MM"` | no | Ora promessa di quella tappa (per lo slip). Opzionale; se manca e c'è `anchorId`, può essere risolta via SELECT read-only (§11). Se manca del tutto → tappa senza slip (solo ETA). |
| `selectedStops[].label` | string | no | Etichetta **presentazionale generica** (es. "Las Marinas", "Pedido actual"). MAI nome cliente. Se sospetta PII, il backend la sostituisce con label derivata da zona (`Pedido <zone>`). |
| `includeReturn` | bool | no | Se `true` (default) la timeline include il nodo `return` (Regreso pizzería) e `summary.returnEta`. |
| `includeCrossZone` | bool | no | Se `false`, una rotta cross-channel è scartata a monte (`cross_channel_not_recommended`); se `true` (default) è valutata ma resta `no_recomendado` (vedi §6). |
| `capacity` | object | no | Limiti del giro. `capacity.pizzas` = pizze già nel giro (le `currentOrderDraft.pizzas` si sommano); `capacity.limitMin` = durata massima ammessa del giro. Valori non numerici → `capacity_invalid` (ma `null`/assente = "sconosciuta", NON 0). |

---

## 6. Validazioni input (errori safe)

Tutti gli errori seguono il pattern di `previewStrategicOpportunities.safeError`: **HTTP 200** con `ok:false`, un `blockers:[{code,message}]`, un `error:{code,message,safe:true}`, `input` sanitizzato e `safety` green. Mai stacktrace/env/token/PII. (Errore non previsto a runtime → il `catch` del POST risponde `internal_error`, coerente col resto di `/api`.)

| Codice | Quando | Esito |
|---|---|---|
| `missing_start_time` | `startTime` assente/vuoto | blocker safe |
| `invalid_start_time` | `startTime` non `HH:MM` valido (00–23:00–59) | blocker safe |
| `missing_current_order` | `currentOrderDraft` assente | blocker safe |
| `missing_zone` | `currentOrderDraft.zone` o uno stop senza zona | blocker safe |
| `empty_selected_stops` | `selectedStops` (e `selectedZones`) vuoti/assenti | blocker safe |
| `invalid_stop_type` | `selectedStops[].type` ≠ `current_order`/`anchor` | blocker safe |
| `invalid_zone` | zona non in `Q1..Q5` | blocker safe |
| `duplicate_current_order` | più di una tappa `type:"current_order"` | blocker safe |
| `too_many_stops` | numero tappe oltre il cap (proposto **MAX_STOPS = 5**) | blocker safe |
| `cross_channel_not_recommended` | rotta mischia canali (sur+oeste) **e** `includeCrossZone:false` | blocker safe (con `includeCrossZone:true` → NON blocker, ma `risk:"no_recomendado"`, vedi sotto) |
| `missing_travel_times` | manca una tratta tra due tappe consecutive (`deliveryLegs` non ha il leg → cross-channel, o zona non collegata) | la timeline esce **bloccata** (nodi con `eta:null`, `risk:"blocked"`), MAI ETA inventati |
| `capacity_invalid` | `capacity.pizzas`/`capacity.limitMin` presenti ma non numerici | blocker safe |

Note semantiche:
- **`null`/assente nella capacity NON è 0**: capacity sconosciuta resta "sconosciuta" e non genera un falso `full` (riusa `classifyCapacity` di `routeImpact`).
- **cross-channel**: con `includeCrossZone:true` la rotta viene comunque mappata ma classificata `no_recomendado` (deliveryLegs non ha le tratte cross → la timeline risulterà bloccata/no-eta su quella tratta). Con `includeCrossZone:false` la scartiamo prima con `cross_channel_not_recommended`.
- **`missing_travel_times`** è la differenza chiave rispetto a un errore "duro": non è un 4xx, è una `routeTimeline` *bloccata e onesta* (nodi senza orario, `risk:"blocked"`, `operatorMessage` prudente), così il frontend disegna la linea rossa "no se puede estimar" invece di un verde finto.

---

## 7. Output contract

Riusa **`route-timeline-v2`** come payload disegnabile.

```json
{
  "ok": true,
  "contract": "premium-planner-manual-giro-route-preview-v1",
  "source": "offline-readonly",
  "mode": "read_only",
  "input": {
    "startTime": "20:42",
    "zones": ["Q2", "Q5"]
  },
  "routeTimeline": {
    "version": "route-timeline-v2",
    "proposalId": "manual-q2-q5-2042",
    "summary": {
      "directEta": "20:50",
      "giroEta": "21:05",
      "returnEta": "21:18",
      "tradeoffLabel": "+15 vs directa · 1 viaje combinado"
    },
    "risk": "tight",
    "operatorMessage": "Se puede: Q2 entra antes, Q5 cede +5. Margen muy justo.",
    "timeline": []
  },
  "warnings": [],
  "blockers": [],
  "safety": { "readOnly": true, "writes": false, "pii": "redacted" }
}
```

| Campo | Descrizione |
|---|---|
| `ok` | `true` se la action ha prodotto una timeline (anche bloccata); `false` solo per errori di validazione safe (§6). |
| `contract` | `"premium-planner-manual-giro-route-preview-v1"` (nuovo, distinto dallo strategic v1). |
| `source` | `"offline-readonly"` (motore puro, nessun calcolo live PII). |
| `mode` | `"read_only"`. |
| `input` | Echo **sanitizzato**: solo `startTime` + `zones` (lista zone in ordine). MAI label/PII/anchorId reali in chiaro oltre alle zone. |
| `routeTimeline` | Oggetto `route-timeline-v2` (vedi `PREMIUM_PLANNER_ROUTE_TIMELINE_V2_DESIGN.md`): `version`, `proposalId`, `summary{directEta,giroEta,returnEta,tradeoffLabel}`, `risk`, `operatorMessage`, `timeline[]` con nodi `departure`/`delivery`/`return` (`seq,zone,label,eta,promised,slipLabel,status,marginLabel,isNewOrder,isAnchor,warning`). |
| `warnings` | Avvisi non bloccanti già redatti (es. slip su una tappa). Array di `{code,message}`. |
| `blockers` | Bloccanti già redatti (es. `missing_travel_times`, `cross_channel_not_recommended`). Array di `{code,message}`. |
| `safety` | `{readOnly:true, writes:false, pii:"redacted"}`. |

`proposalId` proposto: deterministico e no-PII, es. `manual-<zonesKebab>-<startTimeCompact>` (`manual-q2-q5-2042`).

---

## 8. Relazione con `routeTimeline-v2`

- `previewManualGiroRoute` **non introduce un nuovo renderer**: produce esattamente lo shape `route-timeline-v2` che il frontend `RouteTimeline` già sa disegnare (linea Pizzería → entregas → Regreso, badge ETA sui nodi, colori per status).
- Il backend calcola la timeline con i mattoni PURI esistenti: **`deliveryLegs` → `buildRouteImpact` → `buildRouteTimeline`** (vedi §11).
- Se `routeTimeline` manca o ha `timeline:[]`, il frontend fa **fallback safe** (rende `null`, UI attuale intatta) — comportamento già implementato lato renderer.
- Coerenza garantita: stessa famiglia di `risk`/`status`/`operatorMessage` dello strategic, quindi le stesse classi visuali del renderer valgono per entrambe le sorgenti.

---

## 9. Differenza da `previewStrategicOpportunities`

| | `previewStrategicOpportunities` | `previewManualGiroRoute` |
|---|---|---|
| Iniziativa | **Backend suggerisce** opportunità | **Operatore propone** la sequenza |
| Fonte tappe | Anchor reali dallo snapshot read-only | `selectedStops`/`selectedZones` dal click UI (+ `anchorId` opz.) |
| Output | Lista `opportunities[]` (+ `routeTimeline` additivo) | **Una** `routeTimeline` per la rotta proposta |
| Contract | `premium-planner-strategic-preview-v1` | `premium-planner-manual-giro-route-preview-v1` |
| Scrittura | Nessuna (read-only) | Nessuna (read-only) |
| Crea giro? | No | No (apply futuro separato) |
| DB | SELECT snapshot read-only | Nessun DB di default; SELECT solo per risolvere `anchorId` (§11) |

Entrambe: read-only, no PII, safety green, `source:"offline-readonly"`, motore puro.

---

## 10. Fixture canonici

Per ogni fixture: **input** (sanitizzato), **expected routeTimeline nodes**, **expected risk**, **expected operatorMessage** (indicativo), **cosa vede l'operatore**, **cosa NON succede**. Gli ETA sono illustrativi (i numeri reali escono dal motore `routeImpact`).

### A. Q2 → Q5 — ok/tight (canale sur)
- **Input:** `startTime "20:42"`, `currentOrderDraft {zone:"Q2", hora:"21:00", pizzas:2}`, `selectedStops:[{type:current_order,zone:"Q2"},{type:anchor,zone:"Q5",promised:"21:00"}]`, `includeReturn:true`, `capacity:{pizzas:1,limitMin:30}`.
- **Expected nodes:** `departure Pizzería 20:42` → `delivery Q2 (isNewOrder) ~20:50` → `delivery Q5 (isAnchor) ~21:05 slip +5` → `return ~21:18`.
- **Expected risk:** `tight` (o `warning` se lo slip supera la soglia) — dipende da ETA reali, MAI verde se Q5 slitta.
- **operatorMessage:** ≈ "Se puede: Q2 entra antes, Q5 cede +5. Margen muy justo."
- **Operatore vede:** linea Pizzería → Q2 → Q5 → Regreso con ETA per tappa e badge slip su Q5.
- **NON succede:** nessun giro creato, nessuna scrittura, hora del draft invariata.

### B. Q1 → Q2 → Q5 — tre tappe sur
- **Input:** `startTime "20:30"`, current `Q1`, stops `[current Q1, anchor Q2 promised 20:55, anchor Q5 promised 21:10]`, `capacity:{pizzas:2,limitMin:35}`.
- **Expected nodes:** `departure` → `delivery Q1 (new)` → `delivery Q2 (anchor)` → `delivery Q5 (anchor)` → `return`. Tre nodi `delivery` con `seq` 1/2/3.
- **Expected risk:** `ok`/`tight` secondo durata vs `limitMin`.
- **operatorMessage:** ≈ "Compatible: Q1, Q2 y Q5 en un solo giro sur."
- **Operatore vede:** linea a 3 fermate, numeri tappa ①②③.
- **NON succede:** nessun apply, nessun `manual_giro`.

### C. Q3 → Q4 — canale oeste, ajuste/ok
- **Input:** `startTime "20:40"`, current `Q3`, stops `[current Q3, anchor Q4 promised 21:00]`, `capacity:{pizzas:2,limitMin:30}`.
- **Expected nodes:** `departure` → `delivery Q3 (new)` → `delivery Q4 (anchor)` → `return`.
- **Expected risk:** `ok` (o `ajuste/warning` se Q4 slitta).
- **operatorMessage:** ≈ "Compatible por canal oeste: Q3 antes de Q4."
- **Operatore vede:** rotta oeste valida.
- **NON succede:** nessuna scrittura.

### D. Q5 → Q3 — cross-channel
- **Input:** `startTime "20:40"`, current `Q5`, stops `[current Q5, anchor Q3 promised 21:00]`, `includeCrossZone:true`.
- **Expected nodes:** rotta **bloccata** sul leg Q5→Q3 (cross): nodi con `eta:null` dove la tratta manca; `return` null.
- **Expected risk:** `no_recomendado` (o `blocked`).
- **operatorMessage:** ≈ "Canales distintos: no recomendado. Forzable solo con aviso."
- **Operatore vede:** linea rossa "no recomendado", nessun orario finto.
- **Variante** `includeCrossZone:false`: risposta `ok:false` con blocker `cross_channel_not_recommended` (scartata a monte).
- **NON succede:** nessun verde inventato sulla tratta cross.

### E. missing startTime — blocker safe
- **Input:** `{ currentOrderDraft:{zone:"Q2"}, selectedStops:[…] }` (senza `startTime`).
- **Expected:** `ok:false`, blocker `missing_start_time`, `error.safe:true`, `safety` green, `routeTimeline` assente/null.
- **Operatore vede:** messaggio "falta la hora de salida", fallback UI.
- **NON succede:** nessun calcolo, nessuna scrittura.

### F. missing travel times — bloccato/safe
- **Input:** `startTime "20:42"`, current `Q2`, stops `[current Q2, anchor Q5]`, ma una tratta richiesta non esiste in `deliveryLegs` (es. zona isolata) → travel time null.
- **Expected nodes:** timeline **bloccata**: `departure` con eta (se nota) ma `delivery`/`return` con `eta:null`; `risk:"blocked"`.
- **operatorMessage:** ≈ "Sin tiempos de viaje fiables: no se puede estimar la ruta. Forzable con aviso."
- **blockers:** `[{code:"missing_travel_times"}]`.
- **Operatore vede:** linea bloccata, no ETA.
- **NON succede:** nessun ETA inventato.

### G. capacity full — full/lleno (no falso full da null)
- **Input:** `startTime "20:30"`, current `Q2 pizzas:4`, stops `[current Q2, anchor Q5]`, `capacity:{pizzas:5, limitMin:30}` (4+5 oltre il limite del giro) — oppure `limitMin` superato dalla durata.
- **Expected risk:** `full` (capacity piena) — nodi con stato `lleno`.
- **operatorMessage:** ≈ "Giro lleno: N pizzas. No entra más en este giro."
- **Contrapposto:** con `capacity` assente/`null` → **NON** deve risultare `full` (capacity sconosciuta).
- **Operatore vede:** badge "lleno", no inserimento.
- **NON succede:** nessun falso `full` quando i limiti sono `null`.

---

## 11. Piano implementazione **backend** (futuro Step C2 — NON ora)

Senza scrivere codice adesso:

- **Nuovo modulo agent**: `src/agents/previewManualGiroRoute.js` (speculare a `previewStrategicOpportunities.js`).
- **Pipeline pura riusata** (nessun nuovo motore):
  1. Sanitizza input (`startTime`, `currentOrderDraft`, `selectedStops`) — riusa helper no-PII (`normZone`, `horaOrNull`, `safetyBlock`, `safeError`).
  2. Ordina/normalizza le tappe; classifica canale con **`deliveryChannels`** (`routeChannel`/`isRouteChannelCompatible`/`orderZonesByChannel`).
  3. Costruisci i travel times con **`deliveryLegs.buildTravelTimesForPath`** (leg mancante → tratta null → ramo `missing_travel_times`).
  4. Componi gli `stops` e chiama **`routeImpact.buildRouteImpact({ stops, startTime, returnTravelMin, toleranceMin, capacity })`**.
  5. Mappa con **`routeTimeline.buildRouteTimeline({ proposalId, startTime, routeImpact, stops, baseline, kind, channel, status, blocked, warning, explanation })`**.
  6. Avvolgi nel contract `premium-planner-manual-giro-route-preview-v1` (+ `warnings`/`blockers`/`safety`).
- **Dispatcher**: aggiungi il ramo `action === "previewManualGiroRoute"` in `app.post("/api")` di `index.js`, dopo il gate auth comune; `catch` → `internal_error` come le altre.
- **DB**: di default **nessuno**. SELECT read-only via `createReadOnlyRestDb({ sbSelect })` **solo** se `anchorId` presenti e `promised`/`zone` da risolvere (allowlist su `ordenes`, no PII).
- **Test offline**: nuovo `tests/previewManualGiroRoute.test.js` che copre i fixture A–G + safety grep (no fetch/DB/Date.now nel modulo puro, no PII nell'output, contract id, ramo missing_travel_times, no falso full).
- **Safety**: read-only, no DB write, no `manual_giros`, no WhatsApp, no `Date.now`, output sanitizzato.

---

## 12. Piano implementazione **frontend** (futuro — NON ora)

- I click su zona/stop nella mappa/linea costruiscono `selectedStops` (ordine = ordine di click; `current_order` = la zona del draft).
- Chiamata `api.previewManualGiroRoute(input)` (read-only) — nessun calcolo client.
- Render della `routeTimeline` ricevuta col componente `RouteTimeline` già esistente (linea + nodi + ETA + colori per status).
- Stati `loading`/`fallback` come per lo strategic (loading banner; se `!routeTimeline` → UI attuale, no crash).
- **CTA / "Aplicar" resta no-op** in questa fase.
- **Apply reale** (creazione `manual_giro`) = blocco separato e successivo (vedi §15).

---

## 13. Non-goals

- Non crea un giro manuale (`manual_giros`).
- Non applica/conferma la proposta.
- Non modifica ordini, non cambia stato.
- Non invia WhatsApp.
- Non risolve geocoding reale (nessun `geo_cache`).
- Non calcola nulla nel frontend.
- Non sostituisce `previewStrategicOpportunities` (modalità complementare).
- Non sostituisce il planner classico same-zone (`evaluateNewOrder`).

---

## 14. Rischi

- **`selectedZones` troppo povero** rispetto a `selectedStops`: senza `type`/`promised` il backend non sa qual è il nuovo ordine né come misurare lo slip → tenere `selectedStops` come contract primario.
- **`anchorId` non risolto**: id inesistente/non leggibile → trattare la tappa coi soli `zone`/`promised` forniti, mai errore PII; se nessuno dei due, slip non calcolabile (solo ETA).
- **missing travel times**: tratte cross/zone isolate → timeline bloccata onesta, mai ETA inventato.
- **cross-channel troppo permissivo**: `includeCrossZone:true` non deve "verdeggiare" una rotta cross → resta `no_recomendado`/bloccata.
- **Frontend che prova a calcolare**: violazione dell'architettura renderer-only → ribadito nei principi (§3) e nel piano FE (§12).
- **Operatore che confonde preview con apply**: il contract è esplicito read-only/no-write; `operatorMessage` e UI devono dire "preview" finché non esiste l'apply.
- **Stale data tra preview e apply (futuro)**: la preview fotografa lo stato a `startTime`; l'apply futuro dovrà **revalidare** (giro/anchor potrebbero essere cambiati). La `revalidate-on-apply` è esplicitamente un blocco successivo.

---

## 15. Raccomandazione finale

- **Prossimo micro-blocco consigliato:** implementazione backend read-only `previewManualGiroRoute` + `tests/previewManualGiroRoute.test.js` (fixture A–G), **solo backend**, riusando `deliveryChannels` + `deliveryLegs` + `routeImpact` + `buildRouteTimeline`.
- **Ordine:** (1) backend read-only + test offline → (2) deploy controllato Railway (come per gli ultimi blocchi) → (3) frontend click-zona che chiama la action e disegna la `routeTimeline`.
- **Apply / creazione `manual_giro` reale:** solo molto dopo, in un blocco dedicato con `revalidate-on-apply`, conferma esplicita e gestione scritture.

---

### Appendice — moduli puri di riferimento (già nel repo, NON modificati da questo doc)

- `src/core/delivery/deliveryChannels.js` — canali sur (Q1→Q2→Q5) / oeste (Q1→Q3→Q4) / cross; `routeChannel`, `isRouteChannelCompatible`, `orderZonesByChannel`.
- `src/core/delivery/deliveryLegs.js` — tratte same-channel; cross-channel **assenti di proposito** → `null` → `missing_travel_times`; `buildTravelTimesForPath`.
- `src/core/delivery/routeImpact.js` — `buildRouteImpact({stops,startTime,returnTravelMin,toleranceMin,capacity})`, `toMin`/`fromMin`, `classifyCapacity`.
- `src/core/delivery/routeTimeline.js` — `buildRouteTimeline(...)` → shape `route-timeline-v2`.
- `src/agents/previewStrategicOpportunities.js` — pattern action read-only: `safeError`, `safetyBlock`, sanitize no-PII, contract/source/mode.
- `index.js` — gate auth `app.use("/api", …)` PRIMA di `app.post("/api")`; `catch` → `internal_error`.
