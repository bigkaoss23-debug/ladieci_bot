# Delivery Proposal Rules V1 — Reconciliation (backend)

**Documento di riconciliazione, non un design astratto.** Regole numeriche e
deterministiche per le 3–4 proposte del Premium Planner, **riscritte contro il
codice reale** dopo aver letto per intero i moduli implementati. Sostituisce la
prima stesura "inventata" (vedi [§9 Divergenze](#9-divergenze-rispetto-alla-prima-stesura)).

Fonti lette (codice reale, non i design doc stantii):

- `src/core/delivery/strategicOpportunities.js` — generatore candidati.
- `src/core/delivery/routeImpact.js` — motore ETA/slip/status/capacity.
- `src/agents/previewStrategicOpportunities.js` — adapter read-only **wired**.
- `index.js:350` — wiring azione `previewStrategicOpportunities`.
- `tests/routeImpact.test.js`, `tests/strategicOpportunities.test.js`,
  `tests/previewStrategicOpportunities*.test.js` — output verificati.

> **Principio di questo documento:** dove il codice già decide, lo **citiamo**
> (file:funzione); dove manca, lo marchiamo **GAP**. Niente tassonomie alternative,
> niente metriche fantasma, niente score inventato.

---

## 0. Stato reale del motore (cosa è già implementato e NON va duplicato)

| Capacità | Dove (reale) | Note |
|---|---|---|
| Generazione candidati cross-zone | `strategicOpportunities.buildStrategicCandidates` (`strategicOpportunities.js:235`) | un `agregar` per anchor; un `crear` se nessun anchor |
| Classificazione canale sur/oeste/cross | via `deliveryChannels.routeChannel` (`strategicOpportunities.js:96`) | fonte unica canale |
| Ordinamento fermate per canale | `orderZonesByChannel` (`strategicOpportunities.js:173`) | sur Q1→Q2→Q5, oeste Q1→Q3→Q4 |
| Blocco cross / travel mancante | `blockedCandidate` (`strategicOpportunities.js:195`) | mai 0 fantasma sui leg |
| ETA / slip / routeMin per rotta | `routeImpact.buildRouteImpact` (`routeImpact.js:226`) | rotta intera ricalcolata |
| Status engine (4 livelli) | `classifyRouteImpact` (`routeImpact.js:176`) | `compatible\|ajuste\|no_recomendado\|lleno` |
| Capacity state | `classifyCapacity` (`routeImpact.js:143`) | `ok\|tight\|full\|desconocida` |
| Gerarchia status → rank | `STATUS_RANK` + `rankOpportunities` (`previewStrategicOpportunities.js:57,303`) | blocked-last, poi per status |
| Riconciliazione cross-channel | `previewStrategicOpportunities.js:286–296` | cross → status forzato `no_recomendado`, `blocked=true` |
| Esclusione stati terminali | `TERMINAL_STATES` (`previewStrategicOpportunities.js:45`) | RETIRADO/CANCELADO/… |
| Esclusione same-zone | `buildAnchorsFromSnapshot` (`previewStrategicOpportunities.js:176`) | same-zone = dominio planner classico |
| Baseline diretta | `firstAvailable`/`bestProposal` (`previewStrategicOpportunities.js:428`) | candidato `crear` (anchor=null) |
| Contract + safety + wiring | `premium-planner-strategic-preview-v1`, read-only, no PII, `index.js:350` | startTime esplicito, mai `Date.now` |

**Conseguenza:** il "generatore automatico delle proposte" **esiste già**. Quello
che manca è più stretto e sta nella [§7 Gap reali](#7-gap-reali-cosa-manca-davvero).

---

## 1. Status — i 4 reali, niente tassonomia alternativa

Fonte primaria = `classifyRouteImpact` (`routeImpact.js:176`). Precedenza esatta
come nel codice:

| Status | Quando (codice) | `blocked` |
|---|---|---|
| `lleno` | pizze > `maxPizzas` (`_pizzasFull`) | **true** |
| `no_recomendado` | `routeMin > routeMinLimit` (`_durationOver`) **o** qualità pizza a rischio | false |
| `ajuste` | almeno una fermata slitta (`anySlip`) | false |
| `compatible` | nessuno slip, capacity ok | false |

`blocked=true` **solo** per `lleno` nel motore. La riconciliazione cross-channel
(§4) forza inoltre `blocked=true` sui candidati cross a livello adapter.

`capacity.state` è un asse separato (`routeImpact.js:143`): `ok | tight | full |
desconocida`. `desconocida` = limite pizze assente → **non** trattato come pieno
(no `lleno` falso). `tight` = durata oltre limite o qualità a rischio.

### 1.1 Sfumature UI = derivate, non stati engine

Se la UX vuole più di 4 toni, si derivano **dallo status + una magnitudine già
calcolata**, senza inventare stati nel motore:

```
toneUI(opportunity):
  status == compatible              → tono "verde"
  status == ajuste,  maxSlip ≤ 5    → tono "giallo-chiaro"   (deriva da slipLabel)
  status == ajuste,  maxSlip > 5    → tono "giallo"
  status == no_recomendado          → tono "arancione"
  status == lleno / blocked         → tono "grigio/bloccato"
```

`maxSlip` = max degli `slipMin` già in `routeEtas[].slipLabel` (`routeImpact.js:124`).
**Questo è layer di presentazione**, non un nuovo status: gli stati restano 4.

> **IPOTESI V1:** la soglia 5 min per spezzare `ajuste` in due toni è di
> presentazione e va validata. Non cambia nulla nel motore.

---

## 2. Ranking — `priority` reale + `STATUS_RANK`, niente score inventato

Esistono **due** meccanismi reali, già in uso:

1. **`priority`** (`strategicOpportunities.js:212`) sui candidati, prima del route
   impact: `10` = in-canale viabile · `90` = cross · `100` = travel mancante /
   indecidibile. Minore = migliore. `buildStrategicCandidates` ordina per questo.
2. **`STATUS_RANK`** (`previewStrategicOpportunities.js:57`) =
   `{compatible:0, ajuste:1, no_recomendado:2, lleno:3}`, applicato da
   `rankOpportunities` (`:303`): **prima i non-`blocked`**, poi per status, tie-break
   stabile sull'ordine d'ingresso.

Questo realizza già la regola **"lo stato comanda, lo score ordina"**: un
`no_recomendado` non supera mai un `ajuste`, perché il primo criterio di sort è
blocked/status, non un punteggio.

> **GAP (intra-status):** dentro lo stesso status il tie-break è **l'ordine
> d'ingresso** (`:313`), non la qualità rotta. `priority` è dichiarato
> *placeholder* (`strategicOpportunities.js:211`) e codifica **solo** la viabilità
> di canale, non lo slip/routeMin. Quindi due candidati `ajuste` con +2 e +9 min
> oggi possono uscire nell'ordine sbagliato. → [§7.4](#74-ranking-fine-intra-status).

**NON** reintrodurre lo score con penalità 100/200/300 della prima stesura: era un
secondo ranking in competizione con `priority`/`STATUS_RANK` reali.

---

## 3. Slip — assoluto (reale) vs incrementale (NON esiste)

Due metriche da non confondere:

- **Slip assoluto** = `eta − (promised + tolleranza)`, clamp a ≥0.
  `computeStopSlip` (`routeImpact.js:89`). È **ciò che il motore calcola oggi** e
  produce `slipLabel "+N"`. È riferito alla **promessa** della fermata, mai alla
  finestra del giro (I9-style).

- **Delay incrementale** = di quanto una fermata esistente peggiora **a causa
  dell'inserimento** (rotta con il nuovo ordine − rotta senza). **NON esiste nel
  codice.** `routeImpact` non ha il concetto di "rotta baseline senza inserimento".

> **Implicazione operativa:** un anchor già in ritardo sulla propria promessa
> mostra `slip` > 0 **anche senza** il nuovo ordine. Lo slip assoluto **non
> attribuisce** quel ritardo all'inserimento. Le regole V1 usano **lo slip
> assoluto** (l'unica metrica reale). Il delay incrementale resta una **metrica
> futura da implementare** ([§7.5](#75-delay-incrementale-metrica-futura)), non una
> regola disponibile. **Il vecchio `maxAnchorDelayMin` è ritirato.**

Numeri verificati (`tests/routeImpact.test.js`): on-time → `slips=false`,
`slipLabel=""`; +5 → `slipLabel="+5"`; entro tolleranza → no slip.

---

## 4. Cross-channel — riconciliazione già implementata

La regola "cross mai verde" **è già nel codice**, su due livelli:

1. **Strategic** (`strategicOpportunities.js:192–195`): canale `cross` o
   indecidibile o travel mancante → `blockedCandidate=true`, `channel="cross"`,
   `reason` esplicita. Nessun ETA inventato.
2. **Adapter** (`previewStrategicOpportunities.js:286–296`): poiché `routeImpact`
   **non conosce il canale** e potrebbe dire `compatible` su una rotta cross senza
   slip, l'adapter **forza** `status="no_recomendado"`, `severity="blocked"`,
   `blocked=true` per i candidati cross. La decisione strategica vince.

Quindi la "riconciliazione `blockedCandidate` ↔ status `routeImpact`" che i commenti
dei moduli chiamano *"wiring futuro"* (`strategicOpportunities.js:36`) **è in realtà
già fatta nell'adapter**: quel commento è stantio.

Regola V1 (allineata, non nuova):

- cross / travel mancante → **mai `compatible`**, sempre `no_recomendado` + `blocked`;
- mostrabile come **informativo / sconsigliato** (Bottone 4, §6), mai come
  inserimento verde;
- `includeCrossZone=false` (input) → i candidati cross vengono **scartati** del
  tutto (`mapCandidateToOpportunity` ritorna null, `:246`).

---

## 5. Anchor — cosa il codice filtra già, cosa NO

`buildAnchorsFromSnapshot` (`previewStrategicOpportunities.js:161`) **filtra già**:

- solo `tipo_consegna == DOMICILIO` (`:169`);
- esclude `TERMINAL_STATES` = RETIRADO, COMPLETADO/COMPLETATO, CANCELADO, ANULADO,
  ENTREGADO (`:45,171`);
- richiede `zona` valida (`:172`);
- esclude la bozza corrente (`:174`);
- esclude **same-zone** del current (`:176`) — strategic serve solo cross-zone.

**NON filtra** (→ GAP, §7):

- **finestra temporale** rispetto alla `hora` del nuovo ordine — nessun controllo
  su quanto è lontana la promessa dell'anchor;
- **`EN_ENTREGA` / rider già partito** — **non** è in `TERMINAL_STATES`, quindi un
  anchor il cui rider è già uscito **diventa comunque candidato** per "inserire
  prima". Operativamente impossibile (EN_ENTREGA = il rider ha lasciato la sede).

---

## 6. Selezione bottoni — il layer mancante (regole V1)

Oggi l'adapter ritorna `firstAvailable`, `bestProposal` e `opportunities[]`
**ranked ma non limitati**, senza ruolo-bottone. La selezione in 3–4 bottoni è il
**pezzo da definire** (GAP §7.3). Regole deterministiche proposte, espresse **sui
campi reali** (`status`, `blocked`, `channel`, `priority`, `STATUS_RANK`):

Input: `opportunities[]` già `rankOpportunities`-ordinate + `bestProposal` (diretto).

- **Bottone 1 — Direct** = `bestProposal` (candidato `crear`, anchor=null).
  Sempre presente se input minimo valido. `kind=direct`.
- **Bottone 2 — Miglior inserimento** = prima opportunity con `kind=agregar`,
  `blocked=false`, `status ∈ {compatible, ajuste}`, canale non-cross, **minor
  STATUS_RANK** (già in cima alla lista ordinata). `kind=insertion`.
- **Bottone 3 — Alternativa prudente** = compare **se** il Bottone 2 è `ajuste`
  (o assente): seconda migliore `compatible/ajuste` non-cross, oppure il Direct
  posticipato. `kind=alternative`.
- **Bottone 4 — Sconsigliato deterministico** = compare **se** esiste almeno una
  opportunity `blocked=true` con `status=no_recomendado` **non** per travel
  mancante (tipicamente cross o `routeMin` over). `kind=not_recommended`.

Gestione N≠4 (deterministica):

- input minimo valido ma nessun anchor (`no_anchors` warning, `:445`) → **solo
  Bottone 1** + messaggio.
- nessun `no_recomendado` mostrabile → **niente Bottone 4** (non inventarlo).
- molte candidate → **max 4**; le extra restano in `opportunities[]` per un
  "altre opzioni" futuro (non V1).
- `missing_travel_times` → resta nei warnings/blockers, **non** diventa Bottone 4.

> Mapping `kind` ∈ {direct, insertion, alternative, not_recommended} **non esiste
> ancora** sulle opportunity (oggi `kind` = `agregar|crear` dal candidato). È parte
> del layer di selezione da implementare (§7.3).

---

## 7. Gap reali (cosa manca davvero)

### 7.1 Filtro finestra temporale anchor
`buildAnchorsFromSnapshot` non filtra per prossimità alla `hora` del nuovo ordine.
**Proposta V1:** anchor considerabile se `hora_nuovo −15 ≤ promessa_anchor ≤
hora_nuovo +45`. **IPOTESI** da validare; oggi tutti gli anchor cross-zone
non-terminali passano.

### 7.2 Esclusione `EN_ENTREGA` (rider già partito) — **safety**
`EN_ENTREGA` non è in `TERMINAL_STATES`. Un anchor con rider già uscito può
diventare candidato "inserire prima" → operativamente impossibile. **Fix
proposto:** escludere `EN_ENTREGA` (e stati equivalenti "rider in strada") dagli
anchor, o degradarli a **solo informativi**, mai inseribili. Priorità alta: è
correttezza, non estetica.

### 7.3 Layer di selezione 3–4 bottoni
La logica §6 (ruolo-bottone, cap a 4, `kind` direct/insertion/alternative/
not_recommended) **non esiste**. È il gap principale e il vero lavoro V1.

### 7.4 Ranking fine intra-status
Dentro lo stesso status il tie-break è l'ordine d'ingresso; `priority` è un
placeholder solo-canale. Serve un criterio intra-status (es. minor `maxSlip`, poi
minor `routeMin`) per non mostrare il +9 prima del +2. **Da definire**, riusando i
campi reali, non un nuovo score.

### 7.5 Delay incrementale (metrica futura)
Se serve attribuire all'inserimento il peggioramento di un anchor (vs rotta senza
inserimento), va **implementata** una baseline-senza-inserimento in `routeImpact`.
Oggi c'è solo lo slip assoluto. Metrica nuova, non una regola disponibile.

### 7.6 Sorgente capacity lato server
`routeImpact` è agnostico sui limiti; l'adapter li prende da `input.capacity`
(request). Se il client non passa `maxPizzas`/`routeMinLimit`, lo state è
`desconocida` e `lleno` non scatta mai. **Proposta:** iniettare i limiti da
`ZONE_DELIVERY` (`zones.js`) lato server come fonte di verità, non dal client.

---

## 8. Fixture (campi reali, output dai moduli/test)

Tutte usano i campi effettivi: candidato (`channel`, `priority`,
`blockedCandidate`, `routeImpactInput`) e impact (`status`, `slipLabel`,
`routeMin`, `capacity.state`). Numeri da `tests/routeImpact.test.js` dove indicato.

### A — Nessun anchor compatibile
- **Input:** current Q2 promised 21:00; snapshot senza anchor cross-zone non-terminali.
- **Candidati:** solo `crear` (anchor=null), `channel=sur`, `priority=10`,
  `blockedCandidate=false`.
- **Impact (direct):** `status=compatible`.
- **Adapter:** `firstAvailable`/`bestProposal` valorizzati; `opportunities=[]`;
  warning `no_anchors` (`:445`).
- **Bottone finale:** **solo Bottone 1 (Direct)** + "No hay pedidos ancla".
- **NON deve:** generare Bottone 2/3/4 vuoti.

### B — Q2 nuovo + Q5 anchor → `compatible`  *(routeImpact test scenario 1)*
- **Input:** start 20:43; stops Q2(promised 20:50, travel 7) → Q5(promised 21:00,
  travel 8); capacity 3/6.
- **Candidato:** `agregar`, `channel=sur`, `priority=10`, `blockedCandidate=false`.
- **Impact:** Q2 eta 20:50, Q5 eta 21:00, nessuno slip; `status=compatible`;
  `routeMin=34`; `capacity 3/6 state=ok`.
- **Bottone finale:** 1 (Direct) + 2 (Insertion, verde).
- **NON deve:** mostrare slip se Q5 resta puntuale; nessun Bottone 4.

### C — Q2 nuovo + Q5 anchor → `ajuste` +5  *(routeImpact test scenario 2)*
- **Input:** come B ma Q5 travel 13.
- **Impact:** Q5 eta 21:05, `slipLabel="+5"`, Q2 non slitta; `status=ajuste`;
  warning "Q5 se mueve +5".
- **toneUI:** `ajuste, maxSlip=5` → giallo-chiaro (§1.1).
- **Bottone finale:** 1 (Direct) + 2 (Insertion ajuste, "+5") + 3 (Alternativa
  prudente, perché B2 è `ajuste`).
- **NON deve:** mostrare l'`ajuste` come verde; il warning "+5" deve essere
  esplicito.

### D — Q1→Q2→Q5 → `ajuste`  *(routeImpact test scenario 5)*
- **Input:** start 19:50; Q1(promised 20:00, travel 10) → Q2 new(promised 20:05,
  travel 8) → Q5(promised 20:25, travel 13).
- **Impact:** Q1 20:00 no slip, Q2 20:10 `+5`, Q5 20:25 no slip; `status=ajuste`.
- **Candidato:** `channel=sur`, ordinato `orderZonesByChannel` Q1→Q2→Q5.
- **Bottone finale:** 1 (Direct) + 2 (Insertion sur, ajuste) (+3 prudente).
- **NON deve:** ordine cross; Q1 hub classificato cross.

### E — Q3 nuovo + Q5 anchor → cross `no_recomendado`
- **Candidato:** `routeZones=[Q5,Q3]`/[Q3,Q5], `channel=cross`, `priority=90`,
  `blockedCandidate=true`, reason "Canales distintos".
- **Adapter:** riconciliazione cross (`:289`) → `status=no_recomendado`,
  `blocked=true` (anche se routeImpact da solo direbbe compatible).
- **Bottone finale:** 1 (Direct oeste, pulito) + 4 (Sconsigliato cross).
- **NON deve:** cross in Bottone 2; mai verde. Se `includeCrossZone=false` →
  candidato scartato, niente Bottone 4.

### F — Anchor `EN_ENTREGA` → **GAP attuale**
- **Input:** current Q2; anchor Q5 con `estado=EN_ENTREGA`.
- **Comportamento ATTUALE (bug):** `EN_ENTREGA` ∉ `TERMINAL_STATES` → l'anchor
  **passa** `buildAnchorsFromSnapshot` e genera un candidato "inserire prima" di un
  rider già uscito.
- **Comportamento ATTESO (§7.2):** anchor escluso o solo-informativo; **Bottone 1
  (Direct)** unico inseribile.
- **NON deve:** proporre di anteporre una fermata a un rider in strada. *(Fixture
  che documenta un gap da chiudere, non il comportamento corrente.)*

### G — Capacity full → `lleno`  *(routeImpact test scenario 3)*
- **Input:** stops con pizze totali 7, `maxPizzas=6`.
- **Impact:** `status=lleno`, `capacity 7/6 state=full`, `blocked=true`, warning
  "Giro lleno: 7/6 pizzas".
- **Bottone finale:** 1 (Direct) (+ eventuale 3 "crear nuevo giro" se modellato).
  L'opportunity `lleno` è `blocked` → **fuori** dai bottoni principali (`rankOpportunities`
  la manda in fondo).
- **NON deve:** aggregare oltre `maxPizzas`; `lleno` mostrato come verde.
- **NOTA:** se `maxPizzas` non è passato → `state=desconocida`, **non** `lleno`
  (§7.6): rischio reale se i limiti non arrivano dal server.

### H — Molte candidate → max 4 con `rankOpportunities`
- **Input:** current Q2; anchor → 2 `compatible`, 1 `ajuste`, 1 cross
  `no_recomendado`, 1 `lleno`.
- **rankOpportunities (`:303`):** non-blocked prima, poi per `STATUS_RANK`
  (compatible 0 < ajuste 1 < no_recomendado 2 < lleno 3); cross/`lleno` (blocked)
  in fondo.
- **Bottone finale:** 1 (Direct) + 2 (miglior `compatible`) + 3 (secondo
  `compatible` o `ajuste`) + 4 (cross `no_recomendado`). `lleno` e le extra fuori.
- **NON deve:** un `no_recomendado` superare un `ajuste`; più di 4 bottoni.
- **GAP §7.4:** l'ordine tra i due `compatible` oggi è l'ordine d'ingresso, non il
  minor slip — da migliorare.

---

## 9. Divergenze rispetto alla prima stesura

| Tema | Prima stesura (ritirata) | Riconciliazione (questo doc) |
|---|---|---|
| Status | scala inventata a 6 livelli `ok<tight<warning<no_recomendado<full<blocked` | **4 status reali** `compatible\|ajuste\|no_recomendado\|lleno` (`routeImpact.js:176`); sfumature = tono UI derivato (§1.1) |
| Ranking | score inventato `×3/×4` + penalità 100/200/300 | **`priority`** (`strategicOpportunities.js:212`) + **`STATUS_RANK`/`rankOpportunities`** (`previewStrategicOpportunities.js:57,303`) |
| Slip | `maxAnchorDelayMin` come regola disponibile | **ritirato**; solo **slip assoluto** reale (`routeImpact.js:89`); incrementale = metrica futura (§7.5) |
| Cross-channel | regola "da implementare" | **già implementata** (`previewStrategicOpportunities.js:286–296`) — documentata, non riscritta |
| "Generatore proposte" | "ora serve costruirlo" | **esiste** (`buildStrategicCandidates`); manca solo selezione bottoni (§7.3) |
| Capacity | soglie inventate | da `classifyCapacity` reale (`ok\|tight\|full\|desconocida`); gap = sorgente limiti (§7.6) |
| Fixture | campi teorici non calcolati | campi reali + numeri da `tests/routeImpact.test.js` |

---

## 10. Riepilogo: già fatto vs da fare

**Già implementato (NON duplicare):** generazione candidati cross-zone; canale
sur/oeste/cross; route impact (ETA/slip/routeMin/capacity); 4 status engine;
`STATUS_RANK` + `rankOpportunities` ("stato comanda, score ordina"); riconciliazione
cross-channel; esclusione stati terminali e same-zone; baseline diretta; contract
read-only `premium-planner-strategic-preview-v1` **wired** (`index.js:350`); safety
no-PII / startTime esplicito.

**Da implementare davvero:**
1. **(§7.2, safety)** escludere `EN_ENTREGA`/rider partito dagli anchor.
2. **(§7.3)** layer di selezione 3–4 bottoni + `kind` direct/insertion/alternative/
   not_recommended + cap a 4.
3. **(§7.1)** filtro finestra temporale anchor (−15/+45, ipotesi).
4. **(§7.4)** ranking fine intra-status (minor slip → minor routeMin).
5. **(§7.6)** sorgente capacity da `ZONE_DELIVERY` lato server.
6. **(§7.5, opzionale)** metrica delay incrementale se serve.

---

## 11. Raccomandazione prossimo step

Partire dal **gap di correttezza** (§7.2, `EN_ENTREGA`) — è un bug operativo, non
estetica, ed è un cambio piccolo e localizzato in `buildAnchorsFromSnapshot` /
`TERMINAL_STATES`. Poi il **layer di selezione bottoni** (§7.3), che è il vero
valore V1 e si appoggia interamente a output già calcolati. Il resto (finestra
temporale, ranking fine, capacity source) sono raffinamenti successivi.

Tutto in fase implementativa autorizzata: questo documento **non** tocca runtime.

---

## 12. Non-goals (V1)
- nessun apply / scrittura (solo preview read-only);
- single-rider (coerente con la nota d'interpretazione V1);
- nessun Google routing (schema a zone);
- nessuno score inventato (si usano `priority`/`STATUS_RANK` reali);
- nessuna metrica non calcolata dal codice spacciata per regola.

---

## 13. Nota di stato implementativo (aggiornamento 2026-06-09)

Aggiunta dopo la stesura del corpo: parte dei gap qui descritti è stata chiusa.
Le sezioni §6/§7.2/§7.3 vanno lette come **storiche** (descrivevano il "da fare"
al momento della riconciliazione), non più come stato attuale.

| Gap | Stato | Riferimento |
|---|---|---|
| §7.2 — esclusione `EN_ENTREGA`/rider già partito dagli anchor | **fatto** | commit `2fb79d0` (`NON_INSERTABLE_ANCHOR_STATES`) |
| §6/§7.3 — selector 3–4 bottoni (direct/insertion/alternative/not_recommended) | **fatto (puro)** | commit `6ebfca5` (`deliveryProposalSelector.js`) |
| wiring read-only del selector → `proposals[]` additivo nell'adapter | **fatto** | commit `3c0ec3a` (additive-only, smoke offline PASS) |
| §7.4 — ranking fine intra-status | **aperto** | `priority` resta placeholder solo-canale |
| §7.1 — filtro finestra temporale anchor (−15/+45) | **aperto** | ipotesi non implementata |
| §7.5 — delay incrementale | **aperto** (opzionale) | solo slip assoluto reale |
| §7.6 — sorgente capacity da `ZONE_DELIVERY` server-side | **aperto** | limiti oggi dall'input |

`proposal.priority` è emesso come `null` (**reserved/future**): le opportunity non
portano `priority` (sta sul candidato strategico); la propagazione è un cambio
futuro, non incluso. `proposals[]` è **additive-only** accanto a `opportunities[]`
(invariato); nessun deploy, nessun cambio frontend.
