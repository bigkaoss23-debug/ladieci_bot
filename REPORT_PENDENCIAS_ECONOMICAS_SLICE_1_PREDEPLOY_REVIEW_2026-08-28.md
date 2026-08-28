# PENDENCIAS ECONÓMICAS — SLICE 1: PRE-DEPLOY REVIEW

**Data:** 2026-08-28
**Tipo:** BACKEND, SOLA LETTURA sullo staging. Zero migrazioni. Zero deploy.
**Precede:** `REPORT_PENDENCIAS_ECONOMICAS_SLICE_1_READER_2026-08-28.md` (commit locale `5a05a02`)

---

## A. PROVA DI ISOLAMENTO PER WORKSPACE

**Fatto di schema, verificato via SQL di sola lettura, non assunto:**

| Tabella letta dal reader | Ha `workspace_id`? |
|---|---|
| `ordenes` | **NO** |
| `storico` (archivio legacy) | **NO** |
| `order_financial_events` | **NO** |
| `service_sessions` | **NO** |
| `order_obligations` | **SÌ** |
| `table_sessions` | **SÌ** |

`SELECT count(*) FROM workspaces` → **1** (`a8a1809a-9a1e-4dc3-b661-ed357e8f23dc`). `mesa_singleton_workspace_v1` esegue `RAISE EXCEPTION 'MESA_WORKSPACE_AMBIGUOUS'` nel momento stesso in cui `count(*) FROM workspaces <> 1` — è un'invariante applicata dal DB, non una convenzione applicativa.

**Prima della revisione:** il reader leggeva `order_obligations`/`table_sessions` **senza** filtro `workspace_id`, contando implicitamente sul singleton a livello di intero database. Questo è più debole della convenzione già stabilita altrove nel codice (`mesaDao.js` filtra ESPLICITAMENTE `table_sessions`/`restaurant_tables`/`table_reservations` per `workspace_id`).

**Fix applicato:** `getPendingExposures` ora **richiede** `workspaceId` (fail-closed con lo stesso codice/status di `cashCountService.js`: `ECONOMY_UNAUTHENTICATED`/401), e filtra esplicitamente `table_sessions` e `order_obligations` per `workspace_id=eq.<id>` — esattamente la stessa convenzione di `mesaDao.js`. Per `ordenes`/`storico`/`order_financial_events`/`service_sessions` (che non hanno la colonna), l'isolamento resta l'invariante DB-wide del singleton — **la stessa identica proprietà** su cui si appoggiano già `economicSnapshot.js`, `closeoutReconciliation.js` ed `economiaLedgerAggregate.js`: non è un gap introdotto da questa slice.

**`req.economyContext.workspaceId`** proviene ESCLUSIVAMENTE dal contesto JWT verificato — mai dalla query string: un chiamante non può richiedere di leggere un altro workspace fornendone l'id.

---

## B. RISULTATO DEL TEST CROSS-WORKSPACE

Nuovo test dedicato (4 assert) aggiunto a `tests/pendingExposures.test.js`:

| Test | Prova |
|---|---|
| **W1** | Un ordine Mesa il cui `table_session_id` appartiene a un ALTRO workspace (con un saldo reale di 40 €) **non appare mai** in `porCobrar`/`porDevolver` — finisce correttamente in `requiereRevision` con `MISSING_TABLE_SESSION` |
| **W2** | Una riga `order_obligations` di un ALTRO workspace per un ordine diverso **non viene mai letta**, anche quando nasconderebbe denaro reale (provato: `currentObligation` resta 50 — il `totale` legacy — mai 20, il valore della riga estranea; l'esposizione reale di 30 € viene comunque trovata, non fatta sparire) |
| **W3** | Una richiesta senza `workspaceId` (assente, stringa vuota, o non-stringa) viene rifiutata con `ECONOMY_UNAUTHENTICATED`/401, esattamente come il guard di `cashCountService.js` |
| **W4** | Ogni query `table_sessions`/`order_obligations` fatta durante l'intera esecuzione porta `workspace_id=eq.<workspace autenticato>` |

Tutti e 4 **PASS**. Suite completa `pendingExposures.test.js`: **36/36 pass** (31 originali + 4 workspace + 1 sulla forma delle query, vedi §D). `pendingExposuresLiveStagingSpecimen.test.js` (4/4) è stato aggiornato con il vero `workspace_id` letto dal vivo (`a8a1809a-…`) — la prova sui dati reali resta valida con lo stesso workspace autentico.

---

## C. SCOPO ESATTO DELLA QUERY SUL LIBRO ECONOMICO

**Prima della revisione:**
```
select("order_financial_events", "order=created_at.asc&limit=20000")
```
- Database intero? **Sì**, senza alcun filtro oltre al `limit`.
- Workspace intero? Equivalente a "database intero" oggi (nessuna colonna `workspace_id` esiste su questa tabella, quindi non c'è nulla su cui distinguere workspace diversi anche volendo).
- Vincolato per data? No.
- Vincolato per id candidati (ordine/sessione)? No — **deliberatamente**, per non perdere un id di ordine completamente svanito (non solo riciclato).
- Indici a supporto? **Nessuno** aiuta questa forma. `order_financial_events_order_created_idx` è `(order_id, created_at)` — un indice composito che NON accelera un `ORDER BY created_at` senza filtro su `order_id`. La query eseguiva quindi una scansione sequenziale completa **più** un sort completo, ad ogni singola richiesta.
- Complessità attesa con la crescita: O(n log n) per il sort, O(n) per il trasferimento righe, **ripetuto ad ogni apertura di Economía → Pendientes**.

---

## D. VALUTAZIONE DI SCALA E FIX APPLICATO

**Esito: B — ottimizzazione di sola lettura implementata, nessuna migrazione, nessun indice nuovo.**

Il libro economico viene ora letto in **due chiamate distinte, con scopi diversi**:

1. **Popolazione primaria** (`porCobrar`/`porDevolver` + `requiereRevision` dell'archivio legacy) — `selectEventsForIds`: filtrata per `order_id IN (...)`, esattamente la stessa forma già usata da `economicSnapshot.js`. Questa forma **è già supportata da un indice live esistente** (`order_financial_events_order_created_idx`, verificato — nessuna modifica di schema necessaria). Copre il 100% dei casi che contano economicamente: ogni ordine reale e ogni riga d'archivio hanno già il proprio id noto in anticipo.

2. **Scansione degli orfani** (`ORPHANED_LEDGER_EVENT`) — `selectAllEventsForOrphanScan`: **resta** una lettura completa e non filtrata, perché è geneticamente un anti-join ("quali righe non corrispondono a NESSUN ordine conosciuto") che nessun indice su questo schema può trasformare in una ricerca vincolata senza una funzione lato server (una vera migrazione). **Unica ottimizzazione possibile senza toccare lo schema, applicata:** rimosso il `order=created_at.asc` — nessun consumatore di questa lettura ha bisogno dell'ordine cronologico globale (il raggruppamento per orfano calcola il proprio `max()` indipendentemente dall'ordine di arrivo), quindi Postgres non deve più materializzare e ordinare l'intera tabella, solo trasmetterla in streaming.

**Perché questo è "l'architettura minima sicura" possibile in questa slice:** la stragrande maggioranza del lavoro (la parte che decide POR_COBRAR/POR_DEVOLVER) è ora vincolata e indicizzata; resta un'unica lettura O(n) — la scansione orfani — che è l'UNICA parte per cui una vera soluzione limitata richiederebbe una funzione RPC lato server con un anti-join SQL (`NOT EXISTS`), esplicitamente fuori perimetro per questa slice.

**Nuovo test che blocca una regressione silenziosa** (`pendingExposures.test.js`, sezione "scale"): con una lettura isolata, verifica che ESATTAMENTE una chiamata a `order_financial_events` sia senza `order_id=in.` (la scansione orfani) e che quella stessa chiamata non richieda un sort — se un domani qualcuno reintroducesse una lettura completa anche per il percorso primario, questo test fallirebbe immediatamente.

**Soglia di sicurezza onesta per questa slice:** l'endpoint è una schermata operatore a bassa frequenza (aperta poche volte per turno, non un percorso ad alto traffico). Alla scala reale odierna (69 righe) il costo è trascurabile; anche a qualche decina di migliaia di righe (mesi/anni di storico di un singolo ristorante) la sola-scansione-orfani resta economica. **Una vera soluzione limitata per la scansione orfani (una piccola funzione RPC con anti-join lato database) è un lavoro reale di slice successiva, che richiede una migrazione — qui viene segnalato, non implementato**, come esplicitamente richiesto.

---

## E. DECISIONE SUL NOME DELLA ROTTA

**Verificato: ogni rotta REST del backend, senza eccezione, usa un sostantivo inglese.** `/floor`, `/reservations`, `/sessions/:id/account`, `/sessions/:id/payments`, `/sessions/:id/refunds`, `/sessions/:id/adjustments` (Mesa); `/snapshot`, `/reconciliation`, `/cash-counts` (Economía). **Zero precedenti** di una rotta backend in spagnolo in tutto il repository — l'unica occorrenza di "pendiente/pendientes" nel codice sorgente sono commenti o stringhe di etichetta rivolte all'operatore (`roleRegistry.js`, messaggi WhatsApp), mai un percorso di rotta o un identificatore JS.

**Decisione: `GET /api/economy/v1/pendencies` resta invariata.** È già il nome corretto secondo la convenzione del progetto — un rename a `pendientes` romperebbe quella convenzione (introdurrebbe la prima rotta spagnola del backend), e `pending-exposures` sarebbe più verboso di ogni sibling esistente (`/snapshot`, non `/economic-snapshot-report`). Nessuna modifica al codice per questo punto.

---

## F. REGRESSIONE FINALE

| Suite | Risultato |
|---|---|
| Suite completa backend | **292 pass / 1 fail** — stesso identico fallimento pre-esistente e non correlato (`getOrdenesArchivadosSesionAuthorizationParity`) |
| `check-domain-language.js` | OK, 705 file, nessuna nuova occorrenza |
| `pendingExposures.test.js` | **36/36** (31 + 4 workspace + 1 forma-query) |
| `pendingExposuresLiveStagingSpecimen.test.js` | **4/4** (aggiornato con il workspace reale) |
| `economyReadOnlyAndLifecycleIsolation.static.test.js` | **22/22**, invariato |

---

## G. COMMIT LOCALE

Nuovo commit locale creato sopra `5a05a02` (il commit della Slice 1), sullo stesso branch. File toccati in questa revisione:
- `src/economy/pendingExposures.js` (workspace isolation + refactor delle query)
- `src/economy/economyHttpHandlers.js` (`workspaceId` filettato dal contesto auth)
- `tests/pendingExposures.test.js` (5 nuovi assert: isolamento + forma query)
- `tests/pendingExposuresLiveStagingSpecimen.test.js` (workspace reale aggiunto)
- Questo report

Nessun altro file toccato.

---

## H. STATO PUSH

# **NON PUSHATO.**

---

PENDENCIAS_SLICE_1_PREDEPLOY_READY
