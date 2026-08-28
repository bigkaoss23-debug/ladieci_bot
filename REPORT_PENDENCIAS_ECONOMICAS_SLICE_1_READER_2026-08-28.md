# PENDENCIAS ECONÓMICAS — SLICE 1: READER CANONICO DI SOLA LETTURA

**Data:** 2026-08-28
**Tipo:** BACKEND, SOLA LETTURA. Zero scritture operative su staging. Zero migrazioni. Zero deploy.
**Baseline verificata:** BE `398a680` (locale = origin = runtime `/version`) · DB ledger **119** · Frontend intoccato
**Repo:** `ladieci-messa-staging-backend` (branch `feature/staging-messa-tables-2026-08-01`)

---

## A. BASELINE VERIFICATA

| Controllo | Risultato |
|---|---|
| HEAD locale | `398a680` |
| HEAD `origin/feature/staging-messa-tables-2026-08-01` | `398a680` (identico) |
| Runtime `/version` (`fearless-reverence-production-80bc.up.railway.app`) | `commit=398a680`, `commitFull=398a68087eb2...`, `branch=feature/staging-messa-tables-2026-08-01` |
| DB ledger (`ladieci_schema_migrations`) | tip = **119**, `verified` |
| Stato economico staging | 59 ordini (order_uid 59/59), 69 eventi, 46 payment_transactions, 8 obligation rows, 0 table_session aperte, 1 service_session aperto — **invariato rispetto all'audit del 28/08** |
| Working tree pre-esistente | solo `.md` di report non tracciati/modificati da sessioni precedenti — non toccati da questa sessione |

Nessuna riga UAT nuova è comparsa da quando l'audit di architettura è stato scritto: la baseline economica è la stessa.

---

## B. FONTE CANONICA RIUSATA

`safeTicket()` (`src/closeout/currentServiceCloseout.js:73`) — **già esportata**, già consumata da tre reader (`economicSnapshot.js`, `economiaLedgerAggregate.js`, `servizio.js`). **Nessun refactor è stato necessario**: la funzione era già completamente riusabile così com'è. Il nuovo reader (`src/economy/pendingExposures.js`) ne diventa il quarto consumatore, importandola verbatim insieme a `round`, `CANCELLED`, `latestObligationsByOrder`.

`unpaidAmount` e `overCollectedAmount`, già calcolati da `safeTicket`, **sono** POR_COBRAR e POR_DEVOLVER. Nessuna seconda aritmetica economica esiste in questo modulo.

---

## C. REGOLA DI ELEGGIBILITÀ NEL CICLO DI VITA

Implementata come **terzo allowlist**, deliberatamente distinto da:
- `src/utils/orderStateMachine.js` (governa il workflow cucina/consegna — esclude RETIRADO di proposito, non ancora cablato in nessun path live);
- `src/core/delivery/planner.js` (governa se il planner deve ancora instradare l'ordine — domanda di scheduling, non economica).

```js
NON_MESA_TERMINAL_STATES = {RETIRADO, COMPLETADO, COMPLETATO, ENTREGADO, CHIUSO_FORZATO, CANCELADO, ANULADO}

isOperationallyOver =
  MESA      → table_sessions.status !== 'open'
  NON-MESA  → estado ∈ NON_MESA_TERMINAL_STATES
```

**Regola anti-artefatto** (audit §D.2 regola 4): un ordine cancel-like (incluso CHIUSO_FORZATO) con `netCollected === 0` è escluso — residuo operativo del force-close, non un debito. Provata dal vivo: l'ordine `#379` (force-closed, obligation 27,50, zero incassato sotto la propria sessione) è correttamente escluso.

**Anti-fals-positivo, misurato:** applicando SOLO il saldo grezzo al roster di test si ottengono 8+ esposizioni; applicando questa regola ne restano solo quelle realmente eleggibili — esattamente il rapporto (8→2) osservato nell'audit sui dati reali di staging.

---

## D. CONTRATTO API / READER

```
GET /api/economy/v1/pendencies?direction=&from=&to=&q=
```

Autenticazione e ruolo: **stesso `READ_ROLES`** già usato da `/snapshot`/`/reconciliation`/`/cash-counts` (admin, operator, owner, cashier, legacy_operator) — **non è stato cablato** il `capabilityRegistry` V3-A (ancora "FOUNDATION ONLY, UNWIRED"), come richiesto esplicitamente dal brief.

Risposta:

```json
{
  "ok": true,
  "generatedAt": "...",
  "porCobrar": [ ... ],
  "porDevolver": [ ... ],
  "requiereRevision": [ ... ],
  "counts": { "porCobrar": N, "porDevolver": M, "requiereRevision": K }
}
```

Tre gruppi separati (non una lista piatta) per rendere **strutturalmente impossibile** che una riga Class B venga trattata come una pendenza normale. Filtri minimi: `direction`, `from`/`to` (finestra semi-aperta su `originalDate`), `q` (ricerca libera su cliente/tavolo/display). Ordinamento deterministico: esposizione più vecchia prima, tie-break su `orderUid`.

**Campo per campo, il modello canonico** (§6 del brief) è implementato integralmente: `direction`, `orderUid`, `amount`, `currentObligation`, `netCollected`, `originalDate`, `originalBusinessDate`, `lastMovementAt`, `ageDays`, `channel`, `display{orderNumber,tableNumber,tableName,commandNumber}`, `customer{name,phone}`, `allowedActions`, `identityConfidence`.

---

## E. POR_COBRAR

```
currentObligation > netCollected  →  amount = currentObligation - netCollected
```

Nessuna nuova riga persistita. La risoluzione parziale è automatica: ricalcolando con più eventi, l'importo scende da solo; a zero la riga scompare dal gruppo normale (non viene marcata).

---

## F. POR_DEVOLVER

```
netCollected > currentObligation  →  amount = netCollected - currentObligation
```

**`allowedActions`** è calcolato onestamente: `['REFUND']` **solo** su canale MESA (dove `mesa_post_refund_v1` è già live e accetta di proposito una Mesa chiusa — per costruzione di schema, ogni euro Mesa passa da una `payment_transactions` row reale, quindi non serve un'altra query per provarlo); `[]` altrove, perché l'unico percorso non-Mesa (`order_refund` legacy) non ha parametro importo, un solo rimborso per sessione, ed è ora contenuto contro ordini transaction-backed — dichiararlo disponibile sarebbe stato disonesto verso il frontend.

---

## G. REQUIERE_REVISION — le tre popolazioni reali, misurate

| Sorgente | Reason code | Prova |
|---|---|---|
| Ordine con `order_uid`/`service_session_id` mancante | `MISSING_STABLE_IDENTITY` | mai vero oggi (0/59), ma gate reale non un'assunzione |
| Mesa con `table_sessions` non risolvibile | `MISSING_TABLE_SESSION` | fail-closed difensivo |
| Riga dell'archivio storico legacy (nessuna colonna `order_uid` nello schema) | `LEGACY_ARCHIVE_NO_STABLE_IDENTITY` | verificato: `storico` ha zero colonne `order_uid` — decisione strutturale, non euristica |
| Evento del ledger che non combacia con NESSUN ordine (né `ordenes` né l'archivio) | `ORPHANED_LEDGER_EVENT` | **provato dal vivo**: esiste esattamente 1 riga così su staging — `#999004`/sessione `d20ee320`, 5,00 € |

**Scoperta durante l'implementazione, corretta prima del commit:** la prima versione del reader filtrava `order_financial_events` per gli id degli ordini conosciuti (come fa `economicSnapshot.js` per la sua finestra temporale) — questo trova SOLO gli orfani che condividono un numero-display con un ordine ATTUALMENTE esistente (collisione da riciclo, il caso N-6 classico), ma **non** un id completamente svanito. Il test con lo scenario sintetico l'ha rivelato subito. **Fix applicato**: il reader legge l'intero `order_financial_events` una sola volta (69 righe oggi — scala esplicitamente dichiarata nel codice, stesso limite di `selectOrders`), più semplice e strettamente più corretto alla scala attuale.

**Mai indovinare:** nessuna di queste righe riceve `allowedActions`, e nessuna riga Class B entra mai in `porCobrar`/`porDevolver`.

---

## H. METADATA CLIENTE E RICERCA

`normalizeCustomer()` usa **la stessa condizione** che genera i valori sintetici Mesa (`table_session_id` presente — non un pattern-match su "Mesa "/"MESA-", che potrebbe coincidere con un vero nome): per ogni ordine Mesa, `customer = {name: null, phone: null}`, **sempre**. Provato dal vivo sull'ordine reale `#999034` (`nombre="Mesa 6"`, `tel="MESA-98794C63"`) → `customer` risulta `null/null`. Per non-Mesa, stringhe vuote/blank vengono normalizzate a `null`; un cliente reale (`Maria Lopez`, `+34600111222`) sopravvive verbatim.

---

## I. MODELLO DI AUTORIZZAZIONE — SOLO LETTURA

Riusato `READ_ROLES` esistente. **Nessuna capability nuova**, nessun collegamento al `capabilityRegistry` V3-A. La decisione su chi potrà futuramente incassare/rimborsare (§H dell'audit di architettura — in particolare se `cashier` potrà rimborsare, oggi bloccato sia in JS che in SQL) resta esplicitamente **rinviata**, come richiesto.

---

## J. PROVA DAL VIVO SU STAGING (SOLA LETTURA)

**Nota tecnica onesta:** questo backend non ha una credenziale `service_role` Supabase locale (i segreti di staging vivono solo su Railway — vedi memoria `railway-backend-mapping`), quindi non è possibile far girare `sbSelect` reale via HTTP da questa sessione. La verifica è stata fatta rileggendo le righe VERE via SQL di sola lettura (Supabase MCP) e **rigiocandole attraverso il reader vero** — la stessa disciplina che `economicSnapshotWindow.test.js` usa già per le proprie "live staging rows". Nuovo file: `tests/pendingExposuresLiveStagingSpecimen.test.js`, **4/4 pass**.

| Specimen reale | Verificato |
|---|---|
| `#999034` (Mesa 6, order_uid `68a3c44f…`) | currentObligation **60,00** (revisione 3, non 85 originale) · netCollected **70,00** (85 pagato − 15 rimborsato) · **POR_DEVOLVER 10,00** — combacia esattamente con l'incidente `OVER_COLLECTED_AT_CLOSE` da 1000 cents registrato dal vivo · `allowedActions: ['REFUND']` · cliente `null/null` |
| `#999001` (force-closed, order_uid `3b4e25ac…`) | currentObligation **100,00** (legacy, nessuna riga `order_obligations`) · netCollected **50,00** (10+10+10+20) · **POR_COBRAR 50,00** |
| `#379` (ordine corrente, stesso numero display riciclato) | **escluso correttamente** — CHIUSO_FORZATO con zero euro sotto la propria sessione (il vero pagamento da 25,00 € appartiene a un'altra sessione) |
| `#379` (riga archiviata, sessione `c9d5aaa7…`) | **si risolve a zero** (25,00 obbligazione − 25,00 incassato via il match composito) — non appare né in Pendientes né in `requiereRevision`: soldi reali ritrovati, non persi, nulla da rivedere |

Questo secondo `#379` è la prova dal vivo della trappola N-6 (numero display riciclato): due ordini reali diversi condividono "#379", un pagamento reale appartiene all'ordine archiviato sotto una sessione diversa, e il match composito lo attribuisce correttamente **senza** farlo colare sull'ordine corrente omonimo né perderlo come orfano.

---

## K. PROVA DI ZERO SCRITTURE

- Test statico dedicato (`economyReadOnlyAndLifecycleIsolation.static.test.js`, aggiornato): il file sorgente non nomina `sbInsert`/`sbUpsert`/`sbUpdate`/`sbDelete`/`sbRpc`, e importa **solo** `sbSelect` da `utils/supabase`.
- Stesso test: nessun simbolo di lifecycle del servizio (`mesa_close_session_v1`, `close_service_session_v3`, ecc.) è nominato nel nuovo file.
- Test runtime (`pendingExposures.test.js`, scenario O): l'intera esecuzione non chiama mai `select('service_incidents', ...)`.
- Test runtime (scenario T): ogni chiamata `select()` fatta durante l'intera suite tocca solo le sei tabelle attese (`ordenes`, `storico`, `order_financial_events`, `order_obligations`, `service_sessions`, `table_sessions`).

---

## L. REGRESSIONE

| Suite | Prima (baseline provata) | Dopo |
|---|---|---|
| Suite completa backend | 290 pass / 1 fail (`getOrdenesArchivadosSesionAuthorizationParity`, pre-esistente) | **292 pass / 1 fail** — stesso identico fallimento pre-esistente, **+2** dai due nuovi file di test |
| `check-domain-language.js` | OK, 702 file | **OK, 705 file, nessuna nuova occorrenza** |

Il test statico `economyReadOnlyAndLifecycleIsolation.static.test.js` è stato **aggiornato** (non solo lasciato passare): il conteggio GET passa da 3 a 4, il conteggio route totali da 4 a 5, il nuovo file entra nell'elenco dei moduli sorvegliati per isolamento dal lifecycle, e le due tabelle aggiuntive (`order_obligations`, `table_sessions` — già registrate nel resource registry, verificato) sono state aggiunte all'elenco richiesto. 22/22 pass dopo l'aggiornamento.

---

## M. COMMIT LOCALE

Commit locale creato su questo stesso branch (`feature/staging-messa-tables-2026-08-01`). **NON pushato**, come richiesto.

File toccati (solo questi — verificato via `git status`):
- `src/economy/pendingExposures.js` (nuovo)
- `src/economy/economyHttpHandlers.js` (route + handler aggiunti)
- `tests/pendingExposures.test.js` (nuovo, 31 assert)
- `tests/pendingExposuresLiveStagingSpecimen.test.js` (nuovo, 4 assert su dati reali)
- `tests/economyReadOnlyAndLifecycleIsolation.static.test.js` (aggiornato)
- Questo report + l'audit di architettura (`.md`)

Nessun altro file toccato. Il file `.md` di report pre-esistente segnato come modificato nel working tree apparteneva a una sessione precedente e non è stato toccato da questa.

---

## N. MIGRAZIONE

# **NO.**

Zero DDL. Ogni colonna necessaria esisteva già (`order_obligations.gross_amount/revision/order_uid`, `order_financial_events.type/amount/created_at/service_session_id`, `ordenes.order_uid/created_at/table_session_id/estado`, `table_sessions.status`). Le due tabelle aggiuntive lette (`order_obligations`, `table_sessions`) erano già registrate nel resource registry H1B per GET — verificato, non assunto.

---

## O. PUSH / DEPLOY

# **NON PUSHATO. NON DEPLOYATO.**

Come richiesto esplicitamente. Il commit resta locale su questo branch, pronto per revisione.

---

## P. RINVIATO AD ALTRE SLICE (non toccato in questa sessione)

- **Writer di incasso tardivo** (POR_COBRAR il giorno dopo) — l'unico vero gap implementativo, richiede una nuova funzione DB modellata su `mesa_post_refund_v1` e una migrazione.
- **Decisione di autorizzazione sul rimborso** — se `cashier` potrà mai rimborsare (oggi bloccato sia in JS che in SQL).
- **BUG A** (`Economía Devuelto = 0`) — root-caused nell'audit di architettura (`obligation.refunded` invece di `receipts.refunded`), non corretto qui.
- **Historial UI** rotta — non toccata.
- **`SESSION_AGGREGATE_CANONICALIZATION_DEBT`** — `projectSessionAccount` resta line-based a livello di sessione; non toccato.
- **Riparazione Class B** — nessuna riga storica è stata backfillata o corretta; solo resa visibile in sola lettura.
- **Payment Hub cleanup** (`Detalles económicos ▾`, rinomina "Corrección de importe") — non toccato.
- **Redesign Economía** (tab Pendientes nel frontend, Actividad/Alertas) — non toccato: questa sessione è stata rigorosamente backend/reader.

---

PENDENCIAS_ECONOMICAS_SLICE_1_READER_AWAITING_DEPLOY
