# Delivery Planning Orchestrator — SPEC

> Stato: **DECISIONI CHIUSE — pronto per linea di lavoro** (2026-06-04, rev.4 —
> D1–D4 risolte vedi §14; **rev.4** aggiunge il *rider block / manual multi-zone route*,
> vedi §7-bis). Engine puro in `core/delivery/planner.js` + test (61/61 PASS), nessun
> consumatore live, nessun DB, nessun deploy.
> Questo documento definisce la *logica*, non l'implementazione. Sostituisce la
> direzione "un algoritmo unico che calcola tutto" con un **Coordinatore unico che
> interroga agenti specializzati e propone opzioni; l'operatore decide; il backend
> salva un solo piano coerente.**
> Collocazione decisa: **backend autoritativo** (`ladieci-bot`). Il frontend
> *legge* il verdetto, non ricalcola.

---

## 0. Frase madre

```
Gli agenti non decidono la verità finale.
Gli agenti dichiarano, su UNO snapshot condiviso, capacità / vincoli / costi.
Delivery propone le opzioni e i target forno.
Cucina valida ogni opzione su quello stesso snapshot.
Il Coordinatore interseca, ranka e spiega.
L'operatore sceglie l'intento.
Il Coordinatore ricalcola il movibile e salva UN piano coerente.
```

---

## 1. Il problema (la radice unica)

Oggi lo **stato derivato** (`forno_out`, `salida_driver_estimada`, `entrega_estimada`,
`retraso`, `conflicto_driver`, disponibilità/giri) viene **ricalcolato in ~6 posti
diversi, in momenti diversi, con regole diverse**:

- `calcolaFornoOut` → per-ordine, andata propria.
- `simulateDriverSchedule` / `computeDriverFields` → per `zona|slot`, andata worst-case.
- `manual_giros` → terzo asse (`manual_giro_id`).
- frontend: `suggerisciOrario`, `buildDisponibilidad`, `proposeForNewOrder`.

Ogni bug storico è **due di queste derivazioni che si contraddicono** (es. caso `#001`:
`forno_out 19:59` scritto alla creazione vs `salida 19:56` riscritto quando nasce `#002`).
Finché esistono N cervelli, esisterà sempre un nuovo `#001`. Il fix non è un altro
cerotto: è **collassare N derivazioni in 1 Coordinatore + 1 scrittore**.

---

## 2. Principi non negoziabili (INVARIANTI)

Questi valgono ovunque. Sono il cuore del documento.

- **I1 — Il derivato non alimenta mai il derivato.**
  Il Coordinatore calcola **solo dai FATTI GREZZI**:
  `hora`, `andata` (snapshot sull'ordine), `zona`, `pizze/items`, `estado`,
  `manual_giro_id`, stato rider reale (`DRIVER_STATO`), `now`.
  I campi calcolati persistiti in DB sono **proiezione per display**, MAI input di un
  calcolo successivo. (Radice matematica di `#001`.)
  Corollario: anche il valore **arrotondato per display** (anchor di un giro, slot)
  non è mai input di un calcolo — l'arrotondamento è solo presentazione. La feasibility
  e l'aggregazione si decidono sui **minuti reali**, non sullo slot mostrato.

- **I2 — Uno snapshot, una verità.**
  Il Coordinatore scatta **una sola foto** del mondo e la passa agli agenti. Nessun
  agente legge il DB per conto suo. Gli agenti sono **funzioni pure sullo snapshot**.

- **I3 — Agenti = moduli puri dentro una funzione sincrona.**
  Niente servizi che si mandano messaggi, niente bus async. La separazione è di
  *responsabilità* (per testabilità e debuggabilità), non di processo. L'intero piano
  gira sincrono in <1ms su ~30 ordini.

- **I4 — Preview e Commit sono la STESSA engine.**
  La Disponibilidad che vede l'operatore È il calcolo che verrà salvato. Mai due strade.

- **I5 — Il `now` è input esplicito; il Commit ri-esegue e ri-valida.**
  Tra preview e conferma il mondo può cambiare (un ordine si congela). Il commit non si
  fida del verdetto della preview: **ri-gira l'engine sullo snapshot fresco** e
  ri-valida l'opzione scelta. Se non è più fattibile, lo dice all'operatore.

- **I6 — La scelta dell'operatore è un VINCOLO, non la fine.**
  Scegliere "usar giro 18:20" non scrive solo quell'ordine: diventa un vincolo, e il
  Coordinatore **ricalcola tutto il movibile** (rispettando congelati + scelte già
  prese + rider reale) e salva in **una transazione**.

- **I7 — Ogni verdetto porta la sua traccia.**
  Ogni opzione e ogni campo finale espone il **perché** (`reason`/`motivo`). È la
  debuggabilità che è il senso dell'intera architettura.

- **I8 — `forno_out` ≤ partenza del proprio giro, SEMPRE.**
  Tutte le pizze di un giro escono per la partenza del giro (non per l'andata del
  singolo). Invariante verificabile in test.

- **I9 — Il `retraso` si calcola SEMPRE sulla promessa dell'ordine (e sulla sua
  granularità), MAI sulla `delivery_window` del giro.**
  La finestra del giro **descrive**, non **assolve**. Una finestra non può mai
  cancellare un ritardo vero verso il cliente. (Vedi caso Q5 in §13.)

---

## 3. Modello del dominio

### 3.1 Fatti grezzi (input, mai derivati)

| Fatto | Sorgente | Note |
|---|---|---|
| `hora_richiesta` | operatore/cliente | cosa vuole il cliente |
| `hora_promessa` | operatore (al momento della conferma) | promessa DURA (vedi §6) |
| `andata_min` | geo-resolver (Delivery) | snapshot sull'ordine, **non** rifetchato a ogni ricalcolo |
| `zona` | geo-resolver | |
| `items` / `n_pizze` | ordine | la Cucina ragiona in pizze |
| `estado` | macchina a stati | determina congelamento (§5) |
| `manual_giro_id` | operatore | vincolo di grouping |
| `forzado` | operatore | override con costo (§6) |
| `DRIVER_STATO` (`partito_alle`, zona) | realtà | l'evento reale è legge (§7) |
| `now` | clock | input esplicito |

### 3.2 Valori derivati (output, proiezione display)

`forno_out`, `salida_driver_estimada`, `entrega_estimada`, `retraso_estimado_min`,
`conflicto_driver`, `giro_id`. **Scritti solo dal CommitWriter, tutti insieme.**

A livello di **giro** (non di singolo ordine):
`giro_anchor` (etichetta arrotondata), `delivery_window` (`[prima, ultima consegna]`
reale), `count`. Anch'essi proiezione (mai input — I1).

A livello di **rider block** (manual_route, §7-bis): `block_start`, `block_end`,
`duration_min`, `duration_source` (`manual`|`estimated`), `estimated_duration_min`,
`route_order`, `zones`, `coherent`, `status`, `issues[]`, `options[]`, `warnings[]`.
Sui membri: `rider_block` (id del block). Tutti proiezione (mai input — I1).

### 3.3 Il giro: `anchor` (etichetta) vs `delivery_window` (verità)

Tre cose **separate**, da non confondere mai:

| Campo | Cos'è | Uso |
|---|---|---|
| `giro_anchor` | `hora_promessa` più presto del giro, **arrotondata allo slot** (es. `20:00`) | etichetta UI leggibile ("Giro Q5 20:00") |
| `delivery_window` | `[min(entrega), max(entrega)]` **dalla simulazione, al minuto reale** | verità operativa; può essere larga (Q5 multi-stop) |
| `retraso` (per ordine) | `max(0, entrega_reale − fine_tolleranza_promessa)` | conflitto reale verso il cliente |

- L'anchor è **solo presentazione**: non entra in nessun calcolo (I1).
- La window è **reale**: se il rider Q5 parte 20:37 e consegna 20:51→21:03, la window
  è `20:51–21:03`, non una scatola cosmetica `20:35–20:45`.
- Quando la window finisce **dopo** l'anchor, quel salto **è** il segnale visivo del
  ritardo (anchor 20:35, window 20:51–21:03 → si vede che è in ritardo).
- Modalità di display: principale pulita `Q5 · Giro 20:00 · 3 entregas`; sotto, se
  serve, `ventana 20:00–20:09`. Se c'è ritardo, **non si nasconde**:
  `Q5 · Giro 20:35 · ventana 20:51–21:03 · retraso +16`.

### 3.4 Slot pieno → `próximo slot` (derivato, mai una griglia fissa)

La simulazione è **continua** (timeline del rider). Gli slot/anchor sono **etichette
applicate dopo**, arrotondando tempi reali. Non si allocano gli ordini in caselle
rigide `20:00 / 20:15 / 20:30`.

Quando un giro non può accogliere un nuovo ordine, il `próximo slot` proposto **=
quando il rider è davvero libero per quella zona (dalla simulazione), arrotondato in
su** a un'etichetta leggibile. **Mai** una griglia fissa tipo "+15".
> Controesempio reale: giro Q5 parte 20:37, rientro ≈ 21:05 → il prossimo giro Q5 è
> ~21:10, **non** 20:15. Un "+15" cosmetico prometterebbe l'impossibile.

**"Pieno" ha tre cause distinte** (ognuna col suo `reason`, I7), perché il proprietario
e il `próximo slot` cambiano:

| Causa | Rilevata da | `próximo slot` = |
|---|---|---|
| **Forno pieno** (≥4 pizze/slot) | KitchenAgent | prossima disponibilità forno |
| **Giro pieno** (`maxOrdiniPerGiro`) | DeliveryAgent | prossimo giro (rider libero) |
| **Non aggregabile per tempo** (pizza esce dopo la partenza) | DeliveryAgent | prossimo giro (rider libero) |

---

## 4. Componenti

```
PlannerCoordinator
 ├─ SnapshotProvider        (scatta 1 foto del mondo)
 ├─ DeliveryOptionsAgent    (genera opzioni + target forno)
 ├─ KitchenAvailabilityAgent(valida ogni target forno, in pizze, su tutto)
 └─ CommitWriter            (salva 1 piano coerente in transazione)
```

### 4.1 SnapshotProvider
- **Fa:** una sola lettura del mondo → oggetto immutabile `{ ordiniAttivi, congelati,
  ritiri, ginInCorso, driverStato, geo, now }`.
- **Non fa:** nessun calcolo di timing.

### 4.2 DeliveryOptionsAgent (parla per PRIMO — non decide, *enumera*)
- **Domanda a cui risponde:** "Per questo ordine, quali strade di consegna esistono e
  per ognuna *per quando* serve la pizza?"
- **Output:** lista di candidate
  ```
  { type: "separate"|"join_giro", zona, target_consegna, target_forno,
    giro_id?, andata_min, source: google|cache|fallback|manual, confidence }
  ```
- **Non fa:** non sa se la cucina ce la fa; non scrive nulla.
- **Nota geo (I1 + bug indirizzi):** se `confidence` è bassa (es. `partial_match`),
  l'opzione resta ma marcata → il Coordinatore propone con warning, mai numero finto.

### 4.3 KitchenAvailabilityAgent (valida opzione per opzione)
- **Domanda a cui risponde:** "Riesci a far uscire N pizze entro `target_forno`?"
- **Ragiona in PIZZE e vede TUTTO (anche RITIRO):** la capacità slot (4/10min) è
  condivisa. Un giro multi-pizza può sforare uno slot → la cucina anticipa.
- **Output per candidate:**
  ```
  { ok: bool, forno_out_reale, capacita: "x/4", congelato: bool, reason }
  ```
- **Non fa:** non calcola andata, non decide il giro.

### 4.4 PlannerCoordinator (l'unico punto di decisione)
- Interseca Delivery × Kitchen sullo **stesso snapshot**, ranka, spiega.
- Produce il **verdict** (§8) per la UI e per il commit.
- In commit (I6): prende la scelta operatore come vincolo, **ricalcola il movibile**,
  emette il piano completo.

### 4.5 CommitWriter
- Scrive **tutti** i campi derivati di **tutti** gli ordini toccati in **una
  transazione**. Unico scrittore dei derivati. Gestisce la serializzazione (§9.3).

---

## 5. Stati & congelamento

`MARGINE_COTTURA = 5 min` (D1, chiuso). Tre livelli:

| Livello | Condizione | Cosa può fare il Coordinatore |
|---|---|---|
| **MOVIBILE** | `estado ∈ {NUEVO, POR_CONFIRMAR}` **e** `forno_out > now + 5` | riposiziona liberamente (hora, giro, sequenza) |
| **SEMI-CONGELATO** | `estado = EN_COCINA` **e** `forno_out > now + 5` | può ancora ri-sequenziare/spostare **in avanti** (mai prima), **ma flaggato** "già in cucina" e con warning all'operatore — non si stringe di nascosto |
| **CONGELATO DURO** | `forno_out ≤ now + 5` **oppure** `estado ∈ {LISTO, EN_ENTREGA, RETIRADO}` | **intoccabile**: input fisso (parete) |

- I congelati duri sono **pareti**: il Coordinatore schedula il movibile *attorno* a
  loro, non li tocca.
- Poiché le soglie dipendono da `now`, vedi **I5**: il commit ri-valuta i livelli sullo
  snapshot fresco (un ordine può essere passato a CONGELATO DURO tra preview e commit).

---

## 6. `hora`: proposta vs promessa, e forzature

- **Alla creazione:** l'engine *propone* la prima `hora` fattibile (`hora_richiesta`
  come desiderata).
- **Alla conferma:** diventa `hora_promessa` = vincolo **DURO**. L'engine ci schedula
  attorno; se non ce la fa **segnala `retraso`**, non sposta di nascosto.
- **Granularità della promessa = tolleranza** (questo definisce `retraso`):
  - *Promessa a slot* (normale): "sobre las 20:00 / giro de las 20:00" →
    tolleranza = lo slot. Consegnare 20:07 = OK, nessun ritardo.
  - *Promessa al minuto* (eccezione): "20:30 preciso, devo uscire" →
    tolleranza ≈ 0. Consegnare 20:40 = ritardo vero.
  È molto più intelligente del "+10 per tutti sempre": niente conflitti falsi sui
  +3/+5, ma niente ritardi nascosti oltre la tolleranza. La modalità **a slot** è quella
  normale (anche il bot WA promette "verso le 20:00", più onesto del falso-preciso).
  **Default (D4, chiuso): promessa a slot da 10 min**, `anchor` arrotondato a 10
  (es. `20:00`). La promessa al minuto è solo eccezione esplicita.
- **Forzature (operatore comanda — §autorità):**
  - `forzar hora` (consegna a HH:MM anche se l'engine consiglia altro)
  - `forzar giro` (dentro questo giro anche se non ideale)
  L'engine **obbedisce ma propaga il costo/rischio** (es. "giro parte con pizza X non
  pronta, −3 min") e lo **persiste** + traccia `forzado` (così Cocina/Entregas lo
  mostrano). L'ordine forzato diventa vincolo per il ricalcolo del resto.
  **I dati forzati NON sono "puliti"** (D3, chiuso): esclusi da learning/statistiche e
  da training geo-cache — sono override umani, non verità del modello.

---

## 7. Objective & conflitti

- **Un solo rider = una sola timeline sequenziale.** Il problema è sequenziare giri su
  una macchina sola con gate forno a monte.
- **Priorità (D2, chiuso): FIFO sulla `hora_promessa`** — l'ordine in cui un
  pizzaiolo ragiona e che il cliente capisce.
  **Tie-breaker** (a parità di `hora_promessa`):
  `congelato > forzato (manual override) > giro già scelto > created_at`.
- **Conflitto inevitabile** (es. due zone promesse alla stessa ora) → l'engine **non
  nasconde**: assegna `retraso` e lo espone (vedi caso reale Q5 #004–#006).
- **Realtà batte simulazione:** se il rider è *davvero* partito (`partito_alle`), il
  giro in corso è input fisso; si simula solo da "rider libero al rientro" in poi.

---

## 7-bis. Manual multi-zone route / Rider block

> Aggiunto rev.4 (2026-06-04). Estende l'engine puro con il concetto di **rider block**.
> Nessun consumatore live toccato: solo `core/delivery/planner.js` + test.

### 7b.1 Automatic giro vs Manual route

Esistono **due** modi di raggruppare consegne in un solo giro:

| | **Automatic giro** | **Manual route (rider block)** |
|---|---|---|
| Chi decide | l'engine | **l'operatore / il rider** |
| Aggregazione | stessa **zona** + **slot** + compatibilità forno/tempo | esplicita: "fai questi ordini insieme" |
| Zone | una sola zona | **può attraversare zone diverse** (Q1+Q2+Q5) |
| Spezzabile dall'engine | sì (l'engine ottimizza) | **NO** — è un vincolo forte, non si spezza da solo |
| Durata | derivata (andata worst-case + buffer) | **manuale** (se indicata) **oppure** stimata dalla sequenza |
| Ritorno in pizzeria | implicito tra giri | **niente rientri** tra un cliente e l'altro: route sequenziale |

Caso reale: *"Dammi questi 3 ordini anche se sono in zone diverse, li faccio in un solo
giro in ~15 minuti."* → `pizzeria → A(Q1) → B(Q2) → C(Q5)`, durata 15 min, il rider **non
torna** in pizzeria tra un cliente e l'altro.

### 7b.2 Definizione: un rider block

Un `manual_giro` di tipo `manual_route` è un **rider block**:

```text
manual_giro {
  id,
  type: "manual_route",
  order_ids,                 // ordini che compongono il giro (anche zone diverse)
  route_order?,              // sequenza cliente→cliente (default: order_ids)
  block_start?,              // HH:MM partenza dichiarata (autoritativa se presente)
  manual_duration_min?,      // durata operativa dichiarata dal rider/operatore
  created_by_operator?,      // default true
  force?: true|false         // vincolo forte: l'engine obbedisce e propaga il costo
}
```

Un rider block:
- occupa il rider da **`block_start`** a **`block_end` = `block_start + durata`**;
- contiene ordini **anche di zone diverse** (warning `multi_zona`);
- ha una **route sequenziale** cliente→cliente (nessun rientro intermedio);
- ha una durata **manuale** (`manual_duration_min`) o **stimata** dalla sequenza;
- è un **vincolo forte** quando creato dall'operatore (l'engine non lo riordina/spezza);
- **impedisce** al planner di inserire altri delivery dentro `[block_start, block_end]`,
  salvo **override esplicito** dell'operatore.

### 7b.3 Route sequenziale & durata (manuale vs stimata)

- **`route_order`** definisce l'ordine dei clienti. La consegna dello stop `i` avviene a
  `block_start + cum(i)`, dove `cum` è il tempo cumulato lungo la catena (NIENTE ritorno
  in pizzeria tra stop — il salto verso lo stop `i` usa `andata_min(i)` come proxy +
  buffer operativo per consegna).
- **`manual_duration_min` presente → AUTORITATIVA.** `block_end = block_start + durata`.
  Gli arrivi per-stop sono **scalati** sulla durata effettiva (resta coerente col
  `block_end` dichiarato). Se la durata manuale è molto diversa dalla stima →
  warning **`duracion_manual_vs_estimada`** (default: scarto > 5 min **e** > 30%).
- **`manual_duration_min` assente → stimata** dalla sequenza con i dati di andata/fallback
  disponibili (`estimateRouteDuration`).

### 7b.4 `block_start`: dichiarato vs stimato

- **dichiarato** (`block_start` presente): autoritativo. Se il rider non è ancora libero
  a quell'ora → warning **`rider_ocupado`** (l'operatore comanda, D3), ma il costo si
  propaga, non si nasconde.
- **stimato** (assente): parti per consegnare il primo stop intorno alla sua promessa,
  **mai prima** che il rider sia libero (pavimento = `driver.libero_desde` + walls dei
  congelati). `block_start = max(rider_libero, min(promessa) − primo_leg)`.

### 7b.5 Impatto su Disponibilidad (timeline rider)

Il rider block diventa un **wall** sulla timeline del rider: `[block_start, block_end]`.
- Gli **automatic giri** vengono sequenziati **attorno** ai block (i block hanno priorità,
  sono vincoli operatore): nessun automatico cade dentro un block.
- **Invariante:** il rider non ha mai due **block/trip sovrapposti** (`rider_overlaps`
  deve essere vuoto; vedi §10).
- Tutte le pizze del block **escono a `block_start`** (I8): `forno_out = block_start` per
  ogni membro; occupano gli slot forno a quell'istante (capacità condivisa, §10).

### 7b.6 Impatto su commit / ricalcolo del movibile

- Il block è un **vincolo forte** nel ricalcolo (I6): il movibile si schedula attorno ai
  block, mai dentro. `force: true` ⇒ l'engine **obbedisce** e propaga i warning (D3).
- I dati del block, se forzati, **non** alimentano learning/statistiche (D3).
- Preview === commit (I4): il block è ricostruito dallo stesso engine sullo snapshot.

### 7b.7 Modifiche successive & coerenza

Quando un ordine **dentro** un block cambia (es. `hora` +30) il planner **ricalcola il
servizio attivo** e valuta la **coerenza** del block. Un block è incoerente se almeno un
membro genera un `issue`:

| `issue.type` | Quando | Significato |
|---|---|---|
| `pizza_not_ready` | `forno_out` committato del membro > `block_start` | pizza non pronta alla partenza (I8 violato) |
| `cliente_fuera_slot` | `entrega` > `promessa + tolleranza` (I9) | consegna in ritardo verso il cliente |
| `orden_desfasada` | `entrega` troppo **prima** della promessa (oltre `riderBlockEarlyToleranceMin`, default 15) | l'ordine è fuori sync col block (es. hora spostata in avanti) |

Se incoerente, il block espone `coherent: false` e un set di **opzioni** per l'operatore
(non sceglie l'engine):

```
options: [
  { action: "quitar_orden" },       // togli dal block l'ordine in conflitto
  { action: "mover_bloque" },       // sposta block_start per recuperare prontezza/slot
  { action: "mantener_forzado" },   // mantieni forzato accettando i warning
  { action: "preguntar_operador" }  // chiedi priorità all'operatore
]
```

`status` del block: `coherent` | `forced` (incoerente ma `force:true`) | `needs_decision`
(incoerente, serve scelta operatore).

### 7b.8 Warning e forzature

- `multi_zona` — il block attraversa zone diverse (informativo).
- `duracion_manual_vs_estimada` — durata manuale lontana dalla stima.
- `rider_ocupado` — `block_start` cade prima che il rider sia libero.
- `block_incoherente` — almeno un `issue` aperto.
- `pizza_not_ready` / `cliente_fuera_slot` / `orden_desfasada` — sui singoli ordini.

L'engine **non spegne mai** un warning silenziosamente: la finestra del block **descrive**,
non **assolve** (coerente con I9). L'operatore può forzare; il costo resta tracciato.

---

## 8. Contratto di output del Coordinatore

La UI **non calcola** `No agregable` / `Usar giro`: li **legge** da qui.

```json
{
  "selected":    { "type": "separate", "hora": "18:25", "forno_out": "18:17", "status": "valid" },
  "recommended": { "type": "join_giro", "giro_id": "q2_1820", "anchor": "18:20",
                   "delivery_window": "18:20–18:24", "hora": "18:20",
                   "required_forno_out": "18:12", "kitchen_status": "ok",
                   "delivery_status": "ok", "reason": "más cercano y compatible" },
  "options": [
    { "type": "separate",  "hora": "18:00", "status": "blocked",     "reason": "forno lleno hasta 17:58" },
    { "type": "join_giro", "hora": "18:20", "status": "recommended", "reason": "aggregabile, +0 ritardo" },
    { "type": "separate",  "hora": "18:25", "status": "valid",       "reason": "prima separata libera" }
  ],
  "warnings": [],
  "snapshot_now": "2026-06-03T18:00:11Z"
}
```

Mapping UI (la patch frontend attuale legge questo):
- `status: recommended` + `type: join_giro` → riga `Usar giro HH:MM →` + box `Giro recomendado`.
- `status: blocked` su un giro → riga `No agregable` (+ `reason` nel tooltip).
- `selected.type: separate` → `Entrega separada seleccionada: HH:MM`.
- `type: join_block` + `requires_override` → il nuovo ordine cadrebbe in un **rider block**:
  inseribile solo con override esplicito; di default la separata è marcata
  `blocked_by_rider_block` e proposta **dopo** `block_end`.

### 8.1 Rider block nel Plan (`buildPlan`)

`buildPlan` espone i rider block in `plan.blocks` (e nello stream unificato `plan.trips`
con `type: "manual_route"`). Forma di un block:

```json
{
  "id": "BLK:mg1", "type": "manual_route", "manual_giro_id": "mg1",
  "zones": ["Q1","Q2","Q5"], "zona": null,
  "created_by_operator": true, "force": true,
  "block_start": "20:00", "block_end": "20:15",
  "duration_min": 15, "duration_source": "manual", "estimated_duration_min": 39,
  "route_order": ["A","B","C"], "delivery_window": ["20:02","20:13"],
  "anchor": "20:00", "departure": "20:00", "rientro": "20:15",
  "pizze": 3, "count": 3, "members": ["A","B","C"],
  "coherent": true, "status": "coherent", "issues": [], "options": [],
  "warnings": ["duracion_manual_vs_estimada","multi_zona"]
}
```

`plan.rider_overlaps` = lista di coppie di id che si sovrappongono sulla timeline rider
(deve essere **vuota** — invariante §10). Ogni ordine membro porta `rider_block: <id>`,
`forno_out = block_start` (I8) e il proprio `retraso` sulla promessa (I9).

---

## 9. Persistenza

### 9.1 I derivati sono una proiezione
Le colonne `forno_out`, `salida_driver_estimada`, … sono **cache di display**, scritte
solo dal CommitWriter, **mai rilette come input** (I1).

### 9.2 Ricalcolo del movibile (I6)
Su ogni mutazione (crea / modifica hora|items|zona|indirizzo / cambio stato / giro
manuale / evento rider reale): il Coordinatore ricalcola **l'intero set movibile** della
serata e scrive in batch. Costo trascurabile (~30 ordini).

### 9.3 Concorrenza (multi-operatore + bot WA)
Backend autoritativo ⇒ un solo processo. Il `ricalcolaPiano(serata)` va **serializzato**
(lock/coda per service-day) così due commit concorrenti non si sovrascrivono. Da
definire il meccanismo in fase implementativa.

### 9.4 Freschezza del display (nessun ticker richiesto)
Persistenza event-driven + **preview sempre live**. Il display tollera staleness minore;
i punti di decisione (preview/commit) sono sempre ricalcolati sul `now`.

---

## 10. Invarianti verificabili (checklist test)

- [ ] `forno_out` ≤ partenza del proprio giro, per **ogni** membro (I8).
- [ ] pizze per slot 10-min ≤ 4, contando **domicilio + ritiro**.
- [ ] il rider non ha mai due giri sovrapposti.
- [ ] `entrega` ≥ `forno_out` + `andata`.
- [ ] nessun campo derivato è input di un altro calcolo (I1).
- [ ] preview(stesso snapshot) === ciò che il commit persiste (I4).
- [ ] un ordine congelato non cambia mai `forno_out`/`giro` per effetto di un nuovo ordine.
- [ ] `delivery_window` = `[min(entrega), max(entrega)]` reali del giro (mai una scatola fissa).
- [ ] `retraso` calcolato sulla promessa+tolleranza, **mai** sulla `delivery_window` (I9).
- [ ] l'`anchor` arrotondato non entra in nessun calcolo di feasibility/aggregazione (I1).
- [ ] `próximo slot` = rider-libero da simulazione, arrotondato in su; mai griglia fissa.
- [ ] "pieno" distingue forno-pieno / giro-pieno / non-aggregabile, ognuno col suo `reason`.
- [ ] un **rider block** (manual_route) non viene mai spezzato/riordinato dall'engine.
- [ ] nessun delivery automatico cade dentro `[block_start, block_end]` (salvo override).
- [ ] `rider_overlaps` è vuoto: nessun block/trip rider sovrapposto.
- [ ] ogni membro del block ha `forno_out = block_start` (I8) e `retraso` sulla promessa (I9).
- [ ] un block incoerente espone `coherent:false` + `options` (mai "tutto ok" silenzioso).

---

## 11. Mapping del codice esistente

| Oggi | Domani |
|---|---|
| `simulateDriverSchedule`/`computeDriverFields` | base del Coordinatore (già ~70% giusto) |
| `calcolaFornoOut` (per-ordine) | assorbita: forno = partenza giro (KitchenAgent) |
| `proposeForNewOrder`, `suggerisciOrario` | eliminate → `preview(snapshot, ordine)` |
| frontend `buildDisponibilidad` (logica) | thin: legge il verdict §8 |
| `manual_giros` | resta **input** (vincolo), non calcolo |
| risync sparsi (`risincronizzaGiro`, planDriverScheduleSync) | un solo `ricalcolaPiano(serata)` |

---

## 12. Linea di lavoro (strangler — NIENTE big-bang, siamo live)

1. **Engine puro in `core/`** (`buildPlan(snapshot) → Plan`) + test sugli scenari reali
   (§13). Zero consumatori cambiati. Nessun deploy.
2. **Dietro l'API esistente:** `previewOrderTiming` chiama il nuovo engine e fa **A/B**
   contro il comportamento attuale su dati veri (log diff, nessuna scrittura nuova).
3. **Un solo scrittore:** instradare tutte le mutazioni su `ricalcolaPiano(serata)`;
   spegnere le vecchie derivazioni **una a una** quando l'engine le copre.
4. **Frontend legge il verdict;** si cancellano le derivazioni locali.
5. **Cleanup finale:** rimuovere `proposeForNewOrder`/`suggerisciOrario`/fallback legacy.

Ogni passo è isolato, reversibile, verificabile a fari spenti.

---

## 13. Test obbligatori (scenari reali già osservati)

1. **#001 multi-stop:** 2 ordini stessa zona/slot, andate diverse (1 e 4 min) →
   `forno_out` di entrambi = partenza giro (NON 19:59 vs 19:56).
2. **Q5 conflitto (dati reali):** 3 ordini `hora_promessa 20:35`, rider parte 20:37,
   `entrega` 20:51→21:03. La `delivery_window` reale è `20:51–21:03` e il `retraso ~16`
   deve restare **ROSSO** — una finestra cosmetica `20:35–20:45` NON deve assorbirlo (I9).
3. **Manual giro che spazza due slot** (es. mg_260603_2 con 20:00 e 20:30) → il
   Coordinatore lo tratta come catena coerente o lo splitta con warning.
4. **No agregable:** nuovo forno > partenza giro + margine → opzione `blocked`.
5. **Cambio 18:15 → 18:00:** separata `blocked` (forno pieno) + giro `recommended`.
6. **Congelamento durante il commit (I5):** opzione valida in preview, un ordine si
   congela prima della conferma → commit la ri-valida e avvisa.
7. **Rider realmente partito:** `partito_alle` sovrascrive la partenza simulata.
8. **`próximo slot` onesto:** giro Q5 pieno con rientro rider ≈21:05 → il prossimo slot
   proposto è ~21:10, **non** un "+15" fisso (20:50). Distinguere la causa (giro pieno
   vs forno pieno) nel `reason`.

### 13-bis. Manual route / rider block (rev.4 — `core/delivery/planner.js`)

| # | Scenario | Atteso |
|---|---|---|
| M1 | 3 ordini Q1/Q2/Q5, route manuale, durata 15 | un solo rider block; `block_start` coerente; `block_end = start+15`; nessun trip separato per zona; rider timeline occupata |
| M2 | block 20:00–20:15, nuovo delivery vuole 20:05 | non inserito nel block; separata `blocked_by_rider_block` proposta dopo `block_end`; join nel block solo con `requires_override` |
| M3 | un membro ha `forno_out` dopo `block_start` | `issue pizza_not_ready`; block `needs_decision`; mai "tutto ok" silenzioso |
| M4 | consegna interna oltre la granularità promessa | `retraso` calcolato su promessa+slot (I9), non assorbito dalla window; `issue cliente_fuera_slot` |
| M5 | ordine nel block cambia `hora` +30 | block incoerente; `issue orden_desfasada`; `options` quitar/mover/forzar/preguntar; timeline non sporca |
| M6 | nessun manual_giro (regressione) | automatic giro intatto; `forno_out` condiviso 19:56; `type: automatic` |
| M7 | block + ordine automatico in zona diversa | `rider_overlaps` vuoto; l'automatico parte ≥ `block_end` |

> Stato test: **61/61 PASS** (31 esistenti + 30 nuovi per il rider block).

---

## 14. Decisioni del locale — TUTTE CHIUSE (rev.3, 2026-06-03)

- ✅ **D1 — Congelamento** (§5): `MARGINE_COTTURA = 5 min`. EN_COCINA = semi-congelato.
  `forno_out ≤ now + 5` **o** `estado ∈ {LISTO, EN_ENTREGA, RETIRADO}` = congelato duro.
- ✅ **D2 — Priorità** (§7): FIFO sulla `hora_promessa`. Tie-breaker:
  `congelato > forzato > giro già scelto > created_at`.
- ✅ **D3 — Forzatura** (§6): operatore comanda sempre; engine obbedisce, mostra
  costo/rischio, traccia `forzado`. Dati forzati esclusi da learning/statistiche.
- ✅ **D4 — Promessa** (§6): default promessa a slot da **10 min**, `anchor` leggibile
  (es. `20:00`), `delivery_window` reale `[prima, ultima consegna]`, `retraso` vs
  promessa + granularità. Promessa al minuto solo come eccezione esplicita.
- ✅ `delivery_window` = `[prima, ultima consegna]` reale (mai cosmetica).
- ✅ `giro_anchor` = `hora_promessa` più presto del giro, arrotondata allo slot (etichetta).
- ✅ `retraso` sempre sulla promessa, mai sulla window (I9).

> **Tutte le decisioni sono chiuse. Lo spec è pronto per la linea di lavoro: §12 passo 1
> (engine puro in `core/` + test, a fari spenti).**
```
