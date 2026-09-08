# REPORT — CHECK-CENTRIC UNIVERSAL CASH V1
## IMPLEMENTAZIONE LOCALE — La Dieci, staging

**Data:** 2026-09-07 · **Baseline BE** `9d65fac` · **Baseline FE** `8c95e17` · **DB** `tdikhfeinufaahagmpjz` (ledger **121**, invariato)
**NO PUSH · NO DEPLOY · NO APPLY SU STAGING DB · PRODUZIONE INTOCCATA**

Autorità: brief "CLAUDE CODE — SONNET · CHECK-CENTRIC UNIVERSAL CASH V1 IMPLEMENTATION" (2026-09-07), che
risolve le 3 decisioni owner ancora aperte in `REPORT_CHECK_CENTRIC_UNIVERSAL_CASH_V1_CONTRACT_2026-09-07.md`
e le 7 decisioni owner di `REPORT_SERVICIO_UNIVERSAL_CASH_INTEGRATION_AUDIT_2026-09-07.md` (entrambi
pre-esistenti, letti da questo lavoro, non riscritti).

---

## 1. BASELINE

Entrambi i worktree sono stati creati da zero con `git worktree add` dai commit esatti congelati dal brief:

- **Backend**: `/Users/bigart/Downloads/ladieci-check-centric-cash-backend`, branch
  `feature/check-centric-universal-cash-v1`, da `9d65fac` (repo `ladieci-bot`).
- **Frontend**: `/Users/bigart/Downloads/ladieci-check-centric-cash-frontend`, branch
  `feature/check-centric-universal-cash-v1`, da `8c95e17` (repo `LaDieciBotV2-github`).

Nessuno dei due worktree preesistenti e "retained" (`ladieci-finalizar-closeout-wt`,
`ladieci-messa-staging-frontend`) è stato toccato.

---

## 2. MIGRAZIONE 122 — CONTRATTO ESATTO

File: `migrations/2026-09-07_check_centric_universal_cash_v1_migration_122.sql` (+`.ROLLBACK.sql`).
**Non applicata.** Ledger resta 121. Nessuna migrazione 123.

### 2.1 Schema

| oggetto | prima | dopo |
|---|---|---|
| `payment_transactions.table_session_id` | `NOT NULL` | nullable + `CHECK (table_session_id IS NOT NULL OR service_session_id IS NOT NULL)` |
| `payment_allocations.table_order_line_id` | `NOT NULL` | nullable + `CHECK (table_order_line_id IS NOT NULL OR order_uid IS NOT NULL)` |
| `payment_allocations.order_uid` | assente | `uuid NULL`, FK → `order_entities(order_uid)` (**non** `ordenes` — quell'indice è parziale, non FK-addressable) |
| `payment_allocations_transaction_order_uq` | assente | `UNIQUE (payment_transaction_id, order_uid) WHERE table_order_line_id IS NULL` — chiude l'hazard NULL-distinti su `payment_allocations_transaction_line_uq` |
| `auth_audit_event_chk` | 24 valori | +`ORDER_PAYMENT_REFUNDED`, +`ORDER_COMMERCIAL_ADJUSTMENT` |

Zero backfill: 0 righe pre-esistenti con `table_session_id`/`table_order_line_id` NULL (provato nel `$guard$`
e ri-verificato nel `$post$`). Tutte le `ALTER` sono metadata-only su PG 17.6.

### 2.2 Nuove funzioni (tutte `service_role`-only)

| funzione | ruolo di gate | invariante chiave |
|---|---|---|
| `order_post_payment_v1` | **admin, operator** (gate Servicio esistente, NON allargato a PAYMENT_ROLES Mesa) | `full`/`custom_amount` soltanto; nessuna covers/linea; una transazione → una allocazione `order_uid`-targettizzata; rifiuta un ordine tavolo (`table_session_id IS NOT NULL`) |
| `order_post_refund_v1` | **admin, owner** (= Mesa REFUND_ROLES) | stesso tender forzato, remaining da `reverses_transaction_id`, rifiuta una transazione Mesa (`table_session_id IS NOT NULL`), mai `order_obligations` |
| `order_apply_commercial_adjustment_v1` | **admin, owner** (= Mesa ADJUSTMENT_ROLES) | delega **integralmente** a `order_obligation_apply_adjustment_v1` (zero logica di obbligazione duplicata); `netCollected` da `order_financial_events`, non da `payment_allocations` (§17: un incasso legacy event-only non deve leggersi come zero) |

### 2.3 Un'unica riga modificata in `mesa_post_refund_v1`

```
- IF v_original.table_session_id <> p_table_session_id THEN
+ IF v_original.table_session_id IS DISTINCT FROM p_table_session_id THEN
```
`CREATE OR REPLACE` (stessa firma → grant invariati). Comportamentalmente identico per ogni transazione
Mesa esistente (mai NULL); chiude l'unico varco NULL-unsafe che una transazione check-centric avrebbe
potuto sfruttare per eludere l'asserzione di scope.

### 2.4 `order_initial_payment_v1` — creazione-time canonicalizzata

Stesso trigger, stesse guardie (`INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER`, `INITIAL_PAYMENT_LEGACY_FLAG_PRESENT`),
**stessa chiave di idempotenza deterministica** `pay-order-<id>` — cambia solo lo *scrittore*, da
`order_mark_paid` (legacy, event-only, auth `session_version`) a `order_post_payment_v1` (canonico,
transaction-backed, auth `sid_hash`). Un requisito nuovo: l'intent ora richiede anche `sid_hash`
(vedi §4).

### 2.5 Guard/post-condition

`$guard$` rifiuta su drift/doppia applicazione e fa lo snapshot di: 4 conteggi riga (`payment_transactions`,
`payment_allocations`, `ordenes`, `order_financial_events`) + `md5(prosrc)` di **10** funzioni che devono
restare byte-identiche (`mesa_post_payment_v1`, `mesa_close_session_v1`, `mesa_post_commercial_adjustment_v1`,
`order_obligation_apply_adjustment_v1`, `order_canonical_obligation_v1`, `order_has_economic_evidence_v1`,
`paid_order_economic_mutation_guard_v1`, `service_session_assign_financial_event`, `_ledger_write_payment`,
`order_mark_paid`). `$post$` ri-verifica ogni hash, i conteggi, lo shape esatto dei 3 CHECK/indici, i grant
service_role-only sulle 3 nuove funzioni, il fix in `mesa_post_refund_v1`, il repoint di
`order_initial_payment_v1`, e zero backfill.

### 2.6 Rollback — hard-stop

`$guard$` del rollback rifiuta se esiste **una sola** riga `payment_transactions` con `table_session_id IS NULL`
o `payment_allocations` con `table_order_line_id IS NULL`/`order_uid IS NOT NULL`. Nessun `DELETE`, nessuna
disattivazione del trigger append-only (`mesa_append_only_v1`). Pulito solo nella finestra prima del primo
pagamento check-centric.

---

## 3. ARCHITETTURA — UN LEDGER, PIÙ ADAPTER

Nessuna nuova tabella, nessun secondo ledger, nessuna duplicazione di `_ledger_write_payment`/
`rider_collect_and_complete_stop`. `order_post_refund_v1` **non** è una chiamata diretta a
`mesa_post_refund_v1`: il suo loop di riversamento allocazioni fa `JOIN table_order_lines`, che
un'allocazione check-centric non ha mai (differenza strutturale provata, non incidentale — §L del
report contratto) — quindi è un vero adapter (stessa tabella, stessi invarianti, logica riscritta
per il caso a-singola-allocazione). `order_apply_commercial_adjustment_v1` è invece un wrapper
**letterale** attorno al nucleo condiviso, zero logica duplicata.

---

## 4. BACKEND NODE — WIRING

Nuovo modulo `src/cash/` (cashDao.js, cashService.js, cashHttpHandlers.js, cashHttpIntegration.js),
struttura gemella di `src/tables/mesa*.js` ma per un target diverso (un check, non una sessione tavolo):

- Router montato a `/api/cash/v1`, dietro `CASH_HTTP_ENABLED` (disabilitato di default, come Mesa).
- 4 rotte: `GET /checks/:orderUid`, `POST .../payments`, `.../refunds`, `.../adjustments`.
- Stesso meccanismo `sid_hash` di Mesa (`src/auth/sidHash.js`, **riusato**, non reimplementato):
  auth middleware `cashAuth` costruisce `req.cashContext` esattamente come `mesaContext`.
- `canonicalHash` e `projectOrderFinancial` **importati da `mesaService.js`** (quest'ultimo ora
  esportato apposta) — non reimplementati.
- 3 nuove entry in `supabaseResourcePolicy.js` (H1B, altrimenti fallirebbero chiuse senza traccia):
  `rpc/order_post_payment_v1`, `rpc/order_post_refund_v1`, `rpc/order_apply_commercial_adjustment_v1`.
- `src/financial/initialPaymentIntent.js`: aggiunge `sid_hash` all'intent via lo stesso `sidHash()`
  condiviso, calcolato da `authCtx.sid` — lo **stesso** campo JWT che `legacyAuthGuard.js` mette già
  su ogni `req.authCtx`. Nessuna nuova infrastruttura di auth.
- **`index.js`: nessuna modifica a `updateEstado`.** Opzione A confermata dall'audit: se il frontend
  smette di inviare `metodo_pago`, `collecting` è già `false` lato backend — zero rischio, zero righe
  toccate in quell'azione.

---

## 5. FRONTEND — SUPERFICIE CASSA CONDIVISA

`components/mesa/MesaAccountBalance.jsx` è stato riusato **senza alcuna modifica**.
`MesaPaymentsList.jsx` e `MesaCommercialAdjustments.jsx` hanno guadagnato **due prop iniettabili**
(`api`, `describeError`), con default `mesaApi`/`describeMesaError` — ogni chiamante Mesa esistente
resta byte-identico (provato dall'intera suite Mesa che passa invariata). Il nuovo
`components/cash/CheckCashPanel.jsx` li compone contro `cashApi` invece di duplicarli.

```
CheckCashPanel({ orderUid, displayOrderId, canRefund, canAdjust, allowDelivery, onClose, onDelivered })
  ├─ MesaAccountBalance         (riuso as-is)
  ├─ pagamento full/custom_amount (nuovo, minimo — niente covers, niente linee)
  ├─ legacyPayments             (nuovo — visibile, mai rimborsabile da qui, §16/§T)
  ├─ MesaPaymentsList           (riuso, api=cashApi)
  └─ MesaCommercialAdjustments  (riuso, api=cashApi)
```

`TabListos.jsx`: il popup inline "¿Cómo paga?" (con `DescuentoInput`) è **rimosso**, non solo nascosto
(provato staticamente: `DescuentoInput`, `pendingPago`, `finalizar(metodo)` assenti dal file). Il bottone
"🛍 Retirado" di un ordine non pagato ora apre `onOpenCash(order)`. Il percorso "già pagato" (bottone
diretto, invariato) continua a chiamare `onRetirado` con `o.metodo_pago` esattamente come prima.

**Scoperta non ovvia**: `ListosUnificado.jsx` passa sempre `hideRetirados` a `TabListos`, quindi il ramo
`isDone` di `TabListos` (incluso il mio "Abrir en caja") **non è mai raggiunto** nell'app reale — la
superficie terminale realmente visibile per Recogida/Delivery è `ListosArchivados.jsx`. "Abrir en caja"
è stato aggiunto lì (dove è davvero raggiungibile), oltre che in `TabListos.jsx` (per coerenza/futuri
chiamanti). Senza questa verifica, il re-entry §24 sarebbe stato codice morto.

`ServicioPage.jsx`: nuovo stato `cashOrder` (stesso pattern di `ticketOrder`/`setTicketOrder`), nuova
funzione `confirmEntregaFromCash` — **non** riusa `setRetirado` perché quest'ultima inghiotte i propri
errori (li notifica e basta); `confirmEntregaFromCash` rilancia l'eccezione, così il pannello cassa ha
qualcosa da catturare per §20 caso E/F (resta aperto, mostra un retry). Nessun `metodo_pago` è mai
inviato da questo percorso.

---

## 6. CREAZIONE-TIME `ya_pagado` — CANONICALIZZATA

`order_initial_payment_v1` chiama ora `order_post_payment_v1` invece di `order_mark_paid`. La stessa
chiave `pay-order-<id>` è riusata come `client_request_id`, quindi un replay della creazione dell'ordine
fa replay del pagamento invece di un doppio addebito — stesso meccanismo esatto, scrittore diverso.
`src/financial/initialPaymentIntent.js` calcola `sid_hash` da `authCtx.sid` (già presente in
`req.authCtx` su entrambi i punti di creazione ordine in `index.js`, **zero modifiche** a quei call site).

---

## 7. RIDER — DEBITO NOTO, NON TOCCATO

`_ledger_write_payment` e `rider_collect_and_complete_stop` sono byte-identici (hash verificato nel
`$post$` della migrazione). Nessuna delle due colonne rilassate è mai letta da quel percorso. Il rider
resta `LEGACY_EVENT_ONLY_WRITER` / `FAST_FOLLOW`, esplicitamente fuori scope.

---

## 8. RUOLI — NESSUN ALLARGAMENTO

| capacità | ruolo (invariato rispetto a Servicio pre-slice) |
|---|---|
| pagare (check-centric) | admin, operator |
| rimborsare (check-centric) | admin, owner |
| correggere importe (check-centric) | admin, owner |
| vedere la cassa (check-centric) | admin, operator, owner *(nuova scelta minima — sola lettura, mai un'azione monetaria)* |

Nessuna eredità del set più ampio `PAYMENT_ROLES` di Mesa (admin, operator, owner, cashier,
legacy_operator).

---

## 9. IDEMPOTENZA

`client_request_id` identifica **un movimento di denaro**, non l'ordine: due pagamenti sullo stesso
ordine richiedono due id freschi; un retry dello stesso pagamento riusa lo stesso id
(`payment_transactions_idempotency_uq (workspace_id, client_request_id)`, condiviso da payment e
refund, esattamente come Mesa). `requestHash` è calcolato via `canonicalHash` (hash JSON a chiavi
ordinate) sul payload semantico — riusato da `mesaService.js`, non reimplementato. Provato a livello
unit (stesso payload → stesso hash) in `checkCentricCashService.test.js`.

---

## 10. TEST — SWEEP COMPLETO

### 10.1 Backend — mirati (nuovi)

| file | esito |
|---|---|
| `tests/checkCentricUniversalCashV1Migration.test.js` | **103/103** — testo della migrazione/rollback, invarianti, byte-identità Mesa |
| `tests/checkCentricCashService.test.js` | **18/18** — ruoli, sid_hash, idempotenza, read model (incl. bug reale trovato e corretto, vedi §12) |
| `tests/checkCentricCashDaoWiring.test.js` | **35/35** — mapping esatto parametri RPC, registro H1B |
| `tests/checkCentricCashHttp.test.js` | **12/12** — routing, mapping errori, auth middleware |
| `tests/n3CanonicalInitialPayment.test.js` (aggiornato) | **85/85** — incl. 4 nuovi test per `sid_hash` |

**Totale nuovo/aggiornato: 253 assert, 0 fallimenti.**

### 10.2 Backend — suite completa

`node tests/*.test.js` per tutti i **306** file: **305 PASS**, **1 FAIL**
(`tests/getOrdenesArchivadosSesionAuthorizationParity.test.js`, 3 assert su 21).
**Provato pre-esistente e indipendente da questo lavoro**: stesso identico fallimento (18 passed, 3
failed) rieseguito sul worktree pristino `ladieci-finalizar-closeout-wt`, commit `9d65fac`, **mai
toccato da questa sessione**. È un confronto contro `git show HEAD:<file>` che ha senso solo nel commit
originale che introdusse `getOrdenesArchivadosSesion`; su qualunque HEAD successivo il diff-vs-sé-stesso
mostra zero azioni nuove invece di una. Non soppresso, non modificato.

### 10.3 Frontend

Aree toccate: **101/101** (7 suite: TabListosCashWiring, CheckCashPanel, MesaPaymentsList,
MesaCommercialAdjustments, PaymentHubDuplicate, TabListosMesaExclusion.static, ServicioPageListosUnificadoWiring.static)
+ **5/5** (ListosArchivados.test.js, aggiornato con 2 nuovi test).

**Suite completa**: `npx react-scripts test --watchAll=false` → **150 suite / 2255 test, tutti PASS**,
0 regressioni.

### 10.4 Build + guardrail

- `npm run build` (con env non-prod esplicite, valori locali di verifica) → **`Compiled successfully.`**
- `[check-domain-language]` → **OK — 371 file controllati, nessuna nuova occorrenza** (3 nuove
  occorrenze genuine annotate con `language-guard: allow-legacy`, riuso verbatim di vocabolario
  esistente: `tipo_consegna`/`RITIRO` in un fixture di test, `COMPLETATO` nel mirror `wa_msgs`).
- `tests/migrationManifestOrder.test.js` → **4/4**, la migrazione 122 è correttamente inclusa
  esattamente una volta.

### 10.5 Limite dichiarato — nessuna prova comportamentale su DB reale

Nessun test in questa sessione ha eseguito DDL o DML contro `tdikhfeinufaahagmpjz`, nemmeno in una
transazione con `ROLLBACK` garantito ("rollback-forced probe", tecnica usata da slice precedenti). La
prova che il vincolo `payment_allocations_transaction_order_uq` rifiuti davvero una doppia allocazione,
che l'idempotenza regga sotto un vero replay HTTP, che il trigger `ordenes_paid_at_creation_payment_v1`
si comporti come atteso su un vero INSERT — tutto questo resta **statico** (verificato sul testo SQL) in
questa sessione, per rispettare alla lettera il vincolo "NO STAGING DB APPLY". Il passo naturale
successivo, se l'owner lo autorizza esplicitamente, è un **Supabase database branch** (isolato,
disponibile via MCP, cancellabile) per una verifica comportamentale reale prima della promozione —
non eseguito qui senza quell'autorizzazione esplicita.

---

## 11. INVENTARIO SCRITTORI DI PAGAMENTO (post-migrazione, proiettato)

| # | superficie | scrittore | classificazione |
|---|---|---|---|
| 1 | Mesa Payment Hub | `mesa_post_payment_v1` | CANONICAL_TRANSACTION_WRITER *(invariato)* |
| 2 | **Servicio/Banco/Retiro — interattivo** | `order_post_payment_v1` | **CANONICAL_TRANSACTION_WRITER (nuovo)** |
| 3 | Rider | `_ledger_write_payment` | LEGACY_EVENT_ONLY_WRITER — **FAST_FOLLOW dichiarato** |
| 4 | **Creazione ordine "ya pagado" (non-tavolo)** | `order_post_payment_v1` (via trigger) | **CANONICAL_TRANSACTION_WRITER (canonicalizzato)** |
| 5 | Mesa Refund V1 | `mesa_post_refund_v1` | CANONICAL_TRANSACTION_WRITER *(una riga NULL-safe)* |
| 6 | **Servicio Refund V1** | `order_post_refund_v1` | **CANONICAL_TRANSACTION_WRITER (nuovo)** |
| 7 | Mesa Corregir importe | `mesa_post_commercial_adjustment_v1` | canonico (obbligazione, non incasso) *(invariato)* |
| 8 | **Servicio Corregir importe** | `order_apply_commercial_adjustment_v1` | **canonico (nuovo, wrapper)** |
| 9 | `order_refund`/`order_void`/`order_import_legacy_payment` | — | legacy, non raggiungibili dall'operatore *(invariato)* |

**Nessun secondo scrittore legacy "normale" resta per Servicio.** L'unico debito noto e dichiarato è il
rider (#3).

---

## 12. DIMENSIONE CODICE / DUPLICAZIONE

| repo | righe aggiunte | righe rimosse | di cui test |
|---|---|---|---|
| Backend | 3282 | 4 | ~750 (4 file nuovi + aggiornamento N-3) |
| Frontend | 896 | 83 | ~400 (2 file nuovi + aggiornamento ListosArchivados) |

**Riuso reale, non duplicazione**: `canonicalHash`, `projectOrderFinancial`, `sidHash`,
`createMesaRequestId`, `MesaAccountBalance`, `MesaPaymentsList`, `MesaCommercialAdjustments`,
`mesaSurface.jsx` (design tokens), `order_obligation_apply_adjustment_v1` (nucleo aggiustamento),
l'intera logica di `order_canonical_obligation_v1`. Le uniche righe genuinamente "duplicate" sono
nella migrazione SQL stessa: il corpo completo di `mesa_post_refund_v1` (Postgres richiede il corpo
intero per un `CREATE OR REPLACE`, anche quando cambia una sola riga) e del rollback di
`order_initial_payment_v1` (stesso vincolo). Non c'è un secondo motore di pagamento, nessuna
tabella duplicata, nessuna logica di refund/obbligazione reimplementata da zero.

**Bug reale trovato e corretto durante lo sviluppo dei test**: `cashService.js`'s `money()` helper
convertiva erroneamente centesimi→euro moltiplicando invece di dividere (`Math.round(v*100)/100`
invece di `Math.round(v)/100`), gonfiando ogni importo di 100×. Individuato dal test
`buildCheckAccount computes total/paid/outstanding/overCollected exactly like the canonical formulas`
prima di qualunque commit — esattamente il motivo per cui i test comportamentali (non solo statici)
erano richiesti dal brief.

---

## 13. COMMIT LOCALI

- **Backend**: `1db251e` su `feature/check-centric-universal-cash-v1` (16 file, 3282+/4-).
- **Frontend**: `fa3be47` su `feature/check-centric-universal-cash-v1` (11 file, 896+/83-).

Nessun push. Nessun deploy.

---

## 14. #999035 — INVARIATO

Letto in sola lettura in fase di analisi (già noto da `REPORT_SERVICIO_UNIVERSAL_CASH_INTEGRATION_AUDIT_2026-09-07.md`),
mai scritto. `payment_transaction_id` resta NULL. Nessun backfill, nessuna transazione fabbricata.

---

### RIEPILOGO CAMPI RICHIESTI

A. BASELINE — **PASS**
B. BACKEND LOCAL BRANCH — `feature/check-centric-universal-cash-v1` (repo `ladieci-bot`)
C. FRONTEND LOCAL BRANCH — `feature/check-centric-universal-cash-v1` (repo `LaDieciBotV2-github`)
D. MIGRATION — 122
E. MIGRATION APPLIED — NO
F. SCHEMA CONTRACT — **PASS**
G. NEW TABLES — NONE
H. PAYMENT ENGINE — EXISTING_ENGINE_GENERALIZED
I. CHECK PAYMENT WRITER — `order_post_payment_v1`
J. SERVICIO ENTREGADO — CANONICAL_CASH
K. TERMINAL RETIRADO REENTRY — IMPLEMENTED (in `ListosArchivados.jsx`, la superficie realmente raggiungibile — vedi §5)
L. CREATION-TIME YA_PAGADO — CANONICAL
M. RIDER — LEGACY_FAST_FOLLOW
N. MESA PAYMENT — UNCHANGED (md5 byte-identico, provato)
O. MESA REFUND NULL-SAFE FIX — **PASS**
P. REFUND V1 CHECK-CENTRIC — **PASS**
Q. COMMERCIAL ADJUSTMENT CHECK-CENTRIC — **PASS**
R. PAYMENT TRANSACTION PROVENANCE — **PASS**
S. ALLOCATION ORDER_UID — **PASS**
T. IDEMPOTENCY — **PASS** (unit-level; comportamento DB reale non verificato, vedi §10.5)
U. PARTIAL / SPLIT — **PASS** (logica statica provata; round-trip DB reale non eseguito, vedi §10.5)
V. ROLE GATES — **PASS**
W. #999035 — UNCHANGED
X. PAYMENT WRITER INVENTORY — **PASS**
Y. MESA REGRESSION — **PASS** (0 regressioni, suite Mesa completa + full frontend/backend suite)
Z. TARGETED TESTS — 253/253 backend nuovi/aggiornati, 106/106 frontend nuovi/aggiornati
AA. FULL BACKEND — 305/306 (1 fallimento pre-esistente provato indipendente, vedi §10.2)
AB. FRONTEND — 2257/2257 (150/150 suite) [corretto 2026-09-07 dal fast-follow sotto: il numero originale era inesatto di 2]
AC. BUILD — **PASS**
AD. MIGRATION MANIFEST — **PASS**
AE. BACKEND LOCAL COMMIT — `1db251e`
AF. FRONTEND LOCAL COMMIT — `fa3be47`
AG. PUSH — NO
AH. DEPLOY — NO
AI. DB LEDGER — 121 (invariato)
AJ. PRODUCTION — UNTOUCHED
AK. CODE SIZE / DUPLICATION — vedi §12; riuso reale (non duplicazione) su ogni componente/funzione condivisibile
AL. KNOWN DEBT — RIDER_LEGACY_PAYMENT_FAST_FOLLOW; verifica comportamentale su DB reale differita in attesa di autorizzazione esplicita a un Supabase branch (§10.5)

---

## `CHECK_CENTRIC_UNIVERSAL_CASH_V1_IMPLEMENTED_LOCAL_AWAITING_REVIEW`

---

# FAST-FOLLOW — ALREADY-PAID RETIRADO

**Data**: 2026-09-07 · **Commit frontend**: `e416800` · **Backend**: `1db251e` (invariato) · **Ledger DB**: 121 (invariato)

## FF.1 Stato recuperato dalla sessione interrotta

La sessione precedente aveva esaurito i crediti a lavoro quasi completo. Nel worktree
frontend (`ladieci-check-centric-cash-frontend`, HEAD `fa3be47`) sono state trovate
**3 modifiche non committate**, tutte parte del fast-follow e tutte conservate:

| File | Stato trovato |
|---|---|
| `ServicioPage.jsx` | `metodo_pago \|\| undefined` + mirror locale preservato — **già corretto** |
| `ordenes/TabListos.jsx` | bottone già passato a `handleRetirado(o)` — **già corretto** |
| `ordenes/TabListosCashWiring.test.js` | test "already paid" già riscritto sul contratto lifecycle-only |

Nessun `reset` / `checkout` / `stash` / `clean`: si è ripartiti esattamente da lì.
Mancavano i test che la sessione stava scrivendo e la verifica di non-regressione.

## FF.2 Root cause (verificata sul codice reale, non assunta)

Il bottone "Retirado" di un ordine già pagato rispediva il metodo di pagamento
dell'ordine stesso (`handleRetirado(o, o.metodo_pago)`). La catena:

```
TabListos → ServicioPage.setRetirado → api.updateEstado
→ index.js:1104  collecting = estado === "RETIRADO" && isCollectionMethod(metodo_pago)
→ operatorPayments.registerPayment → writer legacy
```

Divergenza **provata** leggendo `src/financial/registerOperatorPayment.js:122-128`:

- ordine pagato **LEGACY** → il writer risponde `AUTH_LEGACY_IMPORT_REQUIRED`,
  `registerPayment` ritorna `{ok:true, alreadyPaidLegacy:true}` → la transizione passava;
- ordine pagato **CANONICAMENTE** → il writer canonico ha già creato l'unico payment
  basis che SQL ammette per `(service_session_id, order_id)`; la chiamata legacy usa
  la chiave `pay-order-<id>` che non combacia con quella evidenza, quindi non è un
  replay ma `AUTH_BASIS_EXISTS` → `index.js` risponde **409** → **l'ordine non poteva
  più uscire da LISTO**.

Il difetto era quindi invisibile su ordini legacy e bloccante solo sul modello canonico
introdotto da questa stessa V1.

## FF.3 Correzione

1. `TabListos.jsx` — il bottone chiama `handleRetirado(o)`: nessun metodo, nessuno sconto.
2. `ServicioPage.jsx` — `setRetirado` inoltra `metodo_pago || undefined` e **non** `|| ""`.

Il punto 2 è load-bearing e non cosmetico, provato su due sorgenti reali:

- `api.js:522` → `if (metodo_pago !== undefined) body.metodo_pago = metodo_pago;`
  → `""` **viene serializzato**, solo `undefined` omette il campo;
- `src/agents/agentOrdini.js:828` → `if (extras.metodo_pago !== undefined)
  upd.metodo_pago = extras.metodo_pago || "";`
  → un `""` arriva al DB e **azzera il metodo di pagamento reale** dell'ordine.

Per la stessa ragione il mirror ottimistico locale conserva `o.metodo_pago`
invece di sovrascriverlo con un valore vuoto.

`isCollectionMethod` (`index.js:76`) richiede un metodo presente in `PAYMENT_METHODS`:
`""` non lo è, quindi `collecting` resta **false** e nessun writer di pagamento viene
raggiunto — la transizione è puramente di lifecycle.

## FF.4 Test

**Nuovo** `ordenes/alreadyPaidRetiradoLifecycleOnly.test.js` (8 test). Testa il livello che
gli altri non raggiungono: **la richiesta realmente messa sul filo** (`global.fetch`
mockato contro il modulo `api` reale, stesso pattern di `apiAuthLogoutScope.test.js`).
Asserisce che:

- la chiave `metodo_pago` è **assente** dal body (`"metodo_pago" in body === false`, non
  "undefined": il backend copia la chiave se è *presente*);
- il body è esattamente `{action, estado, id}` — nessun `cobrado`/`ya_pagado`/sconto/importo;
- **la cash API canonica non viene mai chiamata** (nessuna fetch su `/api/cash/v1/…`
  né su `/payments`; esattamente 1 fetch totale);
- guardia di regressione: `""` *verrebbe* serializzato — documenta la trappola evitata;
- un incasso reale continua a spedire il suo metodo (percorso non pagato intatto).

Tre asserzioni di sorgente legano questo livello a `ServicioPage.jsx`
(`metodo_pago || undefined`, mirror preservato, `onRetirado={setRetirado}`): la pagina è
di 2103 righe con ~40 import e non è montabile in jsdom — è la ragione per cui **ogni**
test ServicioPage di questo repo è `.static`. La cucitura è quindi esplicita e verificata,
non assunta.

**Esteso** `TabListosCashWiring.test.js` (5 → 9 test): scenario canonico creation-time
(ordine creato `ya_pagado`, senza mirror legacy → handover lifecycle-only, `metodo` e
`descuento` entrambi `undefined`), prova che il metodo memorizzato non viene mai
inoltrato, non-regressione parziale, e backstop sorgente contro il ripristino di
`handleRetirado(o, o.metodo_pago)`.

**Aggiornato** `ListosUnificado.test.js:378` — asseriva il contratto **buggy**
(`toHaveBeenCalledWith("P1", "efectivo", undefined)`). Aggiornato al contratto
lifecycle-only; l'intento del test (raggiungibilità via filtro Takeaway) è invariato.
Nessuna asserzione non correlata è stata indebolita.

## FF.5 Non-regressione

| Caso | Esito | Prova |
|---|---|---|
| NON PAGATO → CheckCashPanel | UNCHANGED | `TabListosCashWiring` |
| PARZIALE → CheckCashPanel | UNCHANGED | nuovo test (`ya_pagado:false` è l'unico discriminante) |
| PAGATO → RETIRADO lifecycle-only | **FIXED** | nuovo test + transport test |
| Cash panel chiuso → nessun RETIRADO | UNCHANGED | `CheckCashPanel` §20 caso D |
| Pagamento fallito → nessun RETIRADO automatico | UNCHANGED | `CheckCashPanel` §20 caso E |
| Pagamento OK + RETIRADO KO → nessuna compensazione | UNCHANGED | `CheckCashPanel` §20 caso F |
| Terminale "Abrir en caja" (`allowDelivery:false`) | UNCHANGED | `CheckCashPanel` + `ListosArchivados` |

`confirmEntregaFromCash` resta lifecycle-only e **non è stato toccato**.

## FF.6 Osservazione aperta (nessuna azione presa — fuori scope)

`confirmEntregaFromCash` (`ServicioPage.jsx:1035`) passa ancora `""` come metodo. È
**innocuo sul blocco 409** (`isCollectionMethod("")` è false → `collecting` false), ma per
`agentOrdini.js:828` quel `""` viene scritto sul record. Nei percorsi realmente
raggiungibili il pannello cassa apre solo ordini non ancora saldati, il cui mirror legacy
è già vuoto, quindi **non c'è perdita di dato oggi**. Resta la stessa trappola latente
corretta in `setRetirado`. Non modificato: è codice di `fa3be47` già rivisto e fuori dal
blocker. Da valutare in un fast-follow separato.

## FF.7 Integrità backend / migration

- Backend HEAD `1db251e`, `git diff 1db251e` **vuoto**: zero byte di produzione modificati.
- Migration 122 **byte-identica** al commit (`git diff` sulla cartella `migrations/` vuoto).
  `sha256` = `aa901e7f…08ac9` (forward), `0af7b8e6…d38ad` (rollback).
- **Nessuna migration 123.** Ledger DB fermo a **121**. Nessuna scrittura su DB staging.

## FF.8 Risultati

- Targeted: 10 suite / **85 test** PASS.
- **Full frontend: 151 suite / 2269 test PASS** (0 fail), stabile con e senza `--runInBand`.
- Build: **`Compiled successfully.`** — 438.1 kB gzip. Domain-language guard OK (373 file).
  Rimosso dopo il build il generato gitignorato `netlify/functions/_publicEnvGenerated.js`.

**Discrepanza segnalata (corretta)**: §AB di questo report registrava `2255/2255 (150/150)`
come baseline `fa3be47`. Questo fast-follow aggiunge **+1 suite e +12 test** (8 nuovi + 4
aggiunti a `TabListosCashWiring`; `ListosUnificado` invariato nel conteggio), quindi la
baseline reale era **2257/150**, non 2255. Verificato che solo 5 file differiscono da
`fa3be47` e che nessun altro file di test è non tracciato: l'aritmetica è chiusa e il
numero registrato in §AB era semplicemente inesatto di 2. §AB sopra è stato corretto a
`2257/2257`. Nessun test fallisce.

## FF.9 Esito

- Nuovo commit frontend: **`e416800`**
- Storia: `8c95e17` → `fa3be47` → **`e416800`** (nessun amend di `fa3be47`)
- Backend: `1db251e` invariato · Migration 122 invariata · Ledger 121
- **PUSH: NO · DEPLOY: NO · PRODUCTION: UNTOUCHED**

## `CHECK_CENTRIC_UNIVERSAL_CASH_V1_FAST_FOLLOW_FIXED_LOCAL_AWAITING_REVIEW`

---

# MICRO FAST-FOLLOW — CONFIRM ENTREGA MIRROR PRESERVATION

**Data**: 2026-09-07 · **Commit frontend**: `d81bd08` · **Backend**: `1db251e` (invariato) · **Ledger DB**: 121 (invariato)

## MF.1 Root cause

Il fast-follow precedente (`e416800`) ha corretto `setRetirado` ma non aveva toccato
l'unico altro chiamante di `api.updateEstado(…, RETIRADO, …)`: `confirmEntregaFromCash`,
che passava ancora `""` esplicito:

```js
const res = await api.updateEstado(order.id, ORDER_STATES.RETIRADO, "", null);
```

`""` **non** rischia un 409 — `isCollectionMethod("")` è `false` (`index.js:76`), quindi
`collecting` non scatta mai. Ma `api.js:522` omette `metodo_pago` dalla richiesta **solo**
per `undefined`; un `""` esplicito viene comunque serializzato, e
`agentOrdini.js:828` (`if (extras.metodo_pago !== undefined) upd.metodo_pago =
extras.metodo_pago || ""`) lo scrive verbatim sopra il valore esistente.

**Sequenza realmente raggiungibile**: ordine Servicio non pagato → apre CheckCashPanel →
il pagamento canonico corregge correttamente il mirror di compatibilità
(`efectivo`/`tarjeta`/`bizum`/`MIXTO`) → l'operatore conferma la consegna →
`confirmEntregaFromCash` è l'**unico** handler che `CheckCashPanel.onDelivered` chiama
(sia "Confirmar entrega" su un conto saldato sia "Entregar sin cobrar" su uno non pagato
condividono la stessa prop) → quella richiesta di consegna avrebbe azzerato il mirror che
il pagamento aveva appena scritto, una scrittura più tardi.

## MF.2 Correzione

Una riga, stesso pattern già stabilito in `setRetirado`:

```diff
- const res = await api.updateEstado(order.id, ORDER_STATES.RETIRADO, "", null);
+ const res = await api.updateEstado(order.id, ORDER_STATES.RETIRADO, undefined, null);
```

**Verifica §6 del brief** — esiste un percorso "deliver unpaid" distinto? No: sia
"Confirmar entrega" (`CheckCashPanel.jsx:216` circa) sia "Entregar sin cobrar" chiamano la
stessa prop `onDelivered`, cablata in `ServicioPage.jsx:1878` esclusivamente a
`confirmEntregaFromCash`. Un solo punto di chiamata, una sola riga da correggere — nessun
percorso "deliver unpaid" separato esiste da correggere a parte.

## MF.3 Test

Estesa `alreadyPaidRetiradoLifecycleOnly.test.js` (8 → 12 test) con due describe block:

- **`confirmEntregaFromCash (...) is lifecycle-only`** — transport test (stesso pattern di
  fetch mockato contro il modulo `api` reale): la richiesta serializzata da
  `api.updateEstado(id, "RETIRADO", undefined, null)` non contiene `metodo_pago`
  (`"metodo_pago" in body === false`), il body è esattamente `{action, estado, id}`;
  più una guardia di regressione che documenta cosa produceva la vecchia chiamata con `""`.
- **`the ServicioPage seam for confirmEntregaFromCash`** — due asserzioni di sorgente:
  la chiamata usa `undefined` e non più `""`, e `onDelivered` è cablato esclusivamente a
  `confirmEntregaFromCash` (lega questo livello al comportamento reale di
  `CheckCashPanel.test.js`, che già prova che sia "Confirmar entrega" sia "Entregar sin
  cobrar" chiamano `onDelivered`).

Nessuna modifica a: logica di pagamento cassa, canonical writer, lifecycle backend,
economia di `CheckCashPanel`, fix already-paid di `TabListos` (`e416800`, non riaperto),
terminal re-entry, componenti Mesa.

## MF.4 Risultati

- Targeted (CheckCashPanel/TabListosCashWiring/alreadyPaidRetiradoLifecycleOnly/
  ListosUnificado/ListosArchivados/ServicioPageListosUnificadoWiring): **6 suite / 76 test PASS**.
- **Full frontend: 151 suite / 2273 test PASS** (2269 + 4 nuovi in questo micro fast-follow).
- Build: **`Compiled successfully.`** — 438.1 kB gzip (+3 B, coerente con la modifica di un
  singolo carattere `""` → `undefined`). Domain-language guard OK.
- Backend `1db251e` invariato (`git diff` vuoto), migration 122 byte-identica, **nessuna
  migration 123**, ledger fermo a **121**.

## MF.5 Esito

- Nuovo commit frontend: **`d81bd08`**
- Storia: `8c95e17` → `fa3be47` → `e416800` → **`d81bd08`** (nessun amend)
- Backend: `1db251e` invariato · Migration 122 invariata · Ledger 121
- **PUSH: NO · DEPLOY: NO · PRODUCTION: UNTOUCHED**

## `CHECK_CENTRIC_UNIVERSAL_CASH_V1_MIRROR_FIX_LOCAL_AWAITING_FINAL_REVIEW`

---

# STAGING PROMOTION (IN PROGRESS — PAUSED BEFORE MIGRATION 122 APPLY)

**Data**: 2026-09-07

## SP.1 Identità autorizzate risolte

- **Backend full SHA**: `1db251ee0a27e2e05f5292378b3ab05ca41f373c`
- **Frontend full SHA**: `d81bd08990a0fded1d400c60f01dd0a04d63ba6a`
- Catena FE verificata esatta: `8c95e17` → `fa3be47` → `e416800` → `d81bd08`
- Ancestry BE verificata: `9d65fac` → `1db251e` (un solo commit)

## SP.2 Identità Migration 122 (dai byte committati in `1db251e`)

| | |
|---|---|
| forward | `2026-09-07_check_centric_universal_cash_v1_migration_122.sql` |
| sha256 | `aa901e7f2607f173783fc50e07c71beb118c7d69b9e93d3cf818cabc22608ac9` |
| sha256:16 | `aa901e7f2607f173` |
| bytes | 86 706 (1516 righe) |
| rollback | `...122.ROLLBACK.sql` |
| rollback sha256 | `0af7b8e6f77096a379c3610032bb4233f010b966f82263c4b9e9f2e1802d38ad` |
| rollback sha256:16 | `0af7b8e6f77096a3` |
| manifest row | 124 → **ledger apply_order 122** (offset manifest = ledger + 2, verificato su righe 120-124) |

**DIFETTO DOCUMENTALE SEGNALATO (non bloccante)**: il manifest riga 124 dichiara
`rollback sha256:16 0af7b8e6f7709637`, ma il valore reale calcolato dai byte committati è
`0af7b8e6f77096a3`. Il checksum **forward** (`aa901e7f2607f173`, l'unico che entra nel ledger)
combacia esattamente. File di lavoro e oggetto git sono identici → non è drift, è
un'annotazione errata dentro `1db251e`. Non corretta: sarebbe una modifica di codice.

## SP.3 Baseline gate (§5 A-P) — **PASS**

Ledger tip 121, 0 righe a 122/123. Shape pre-122 confermata live:
`payment_transactions.table_session_id` NOT NULL, `payment_allocations.table_order_line_id`
NOT NULL, `payment_allocations.order_uid` assente. Railway runtime `9d65fac…dfa`,
Netlify runtime `8c95e17…426`, `CASH_HTTP_ENABLED` **assente**. Entrambi i branch di
autorità (`feature/staging-messa-tables-2026-08-01`, in DUE repo distinti) erano
esattamente sulle basi riviste → fast-forward possibile. PROD `1d581d8` su `main`, intatto.

**Snapshot business pre-promozione**: service_sessions 26 (1 open), table_sessions non
chiuse 93, ordenes 60, order_entities 74, order_obligations 9, payment_transactions 46,
payment_allocations 125, order_financial_events 70, service_closeouts 15, service_incidents 61.

**#999035** (read-only): order_uid `75ba4ced-9b79-4276-a46b-e87a3e24a7e9`, RETIRADO,
totale 85, 1 evento finanziario legacy, `payment_transaction_id` NULL, 0 transazioni
canoniche. Inoltre **0 allocazioni check-centric in tutto il DB** (nessun fatto
check-centric esiste ancora).

## SP.4 Push + deploy backend (FLAG OFF) — **FATTO**

Push fast-forward `9d65fac..1db251e` su `origin/feature/staging-messa-tables-2026-08-01`
del repo `ladieci_bot` (usato `git -C` esplicito: i due repo condividono il nome del branch).
Origin head verificato = `1db251ee…f373c`.

Railway auto-deploy: **`483b3dd9-a09c-4926-9b5f-eb010afaa77f` — SUCCESS**.
`/version` → `1db251ee…f373c`, boot 13:14:13Z. `/health` 200 ×3.

## SP.5 Smoke DB121 + BE1db251e (§10) — **PASS**

Dai log di boot reali:
```
component="cash-v1"   state="disabled"  routeBase="/api/cash/v1"
component="mesa-v1"   state="enabled"
component="economy-v1" state="enabled" routes=5
[S4 boot check] migration heads: verified=121 recorded=121 unverified=56 level=yellow
```
Zero errori, zero PGRST, supabaseTransport 200. Flag OFF confermato **dal log del
processo stesso**, non per inferenza.

**Nota metodologica importante**: su questo backend OGNI richiesta `/api/*` non
autenticata risponde **401** `{"error":"unauthorized"}` — anche una rotta inesistente.
Quindi 401-vs-404 **non** discrimina l'esistenza di una rotta. Il discriminante valido per
§18 è la riga di log `component="cash-v1" state=...`.

## SP.6 PAUSA — apply Migration 122 bloccato da un gap di tooling

Nessun percorso file-based disponibile su questa macchina: **niente `psql`, niente
Supabase CLI, nessun runner di migrazione nel repo**. L'unico meccanismo è
`mcp apply_migration`, che accetta la SQL **come stringa**: applicarla richiederebbe di
riprodurre 86 706 byte / 1516 righe di DDL finanziario attraverso la generazione del
modello, senza un percorso byte-esatto.

Stato attuale (sicuro e supportato, identico a CASE A/B della matrice):
BE `1db251e` live · DB **121** · flag **OFF** · FE `8c95e17` · PROD intatto.

## SP.7 Migration 122 apply — **FALLITA** (rollback pulito, verificato)

**Metodo di apply**: SQL Editor della dashboard Supabase (progetto `tdikhfeinufaahagmpjz`), sessione
autenticata dall'utente stesso. Contenuto trasferito byte-esatto: `pbcopy < <file>` dal Bash locale
(hash verificato prima della copia) → l'utente ha incollato con Cmd+V reale nel proprio contesto OS →
riletto via `pbcopy`/copia-utente e verificato indipendentemente: **86.706/86.706 byte, 1516/1516
righe, sha256 `aa901e7f2607f173...` identico ai byte committati in `1db251e`**. Zero rischio di
trascrizione da parte del modello: il contenuto non è mai passato attraverso la generazione di token.

**Esito esecuzione**: FALLITO al comando "Run without RLS" (il warning RLS su `v_def` è un falso
positivo del linter — `v_def` è una variabile locale `DECLARE` nei blocchi `DO $guard$/$post$`,
non una tabella; nessun `CREATE TABLE` esiste nel file).

```
ERROR: 42P13: cannot remove parameter defaults from existing function
HINT: Use DROP FUNCTION mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb) first.
```

**Causa radice**: la funzione live `mesa_post_refund_v1` ha `p_amount numeric DEFAULT
NULL::numeric, p_meta jsonb DEFAULT '{}'::jsonb` sugli ultimi due parametri. La dichiarazione
`CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1(...)` a riga 892 del file di Migration 122
non riporta questi `DEFAULT`. PostgreSQL rifiuta di rimuovere default esistenti via
`CREATE OR REPLACE FUNCTION` (errore 42P13) — serve un `DROP FUNCTION` esplicito prima, oppure
la dichiarazione deve riportare gli stessi DEFAULT. Difetto reale della migration, non rilevabile
da revisione solo statica del testo — emerso soltanto tentando l'apply contro il DB live.

**Verifica rollback (3 controlli indipendenti, tutti PASS)**:
- `ledger_tip = 121`, righe a 122/123 = 0
- `payment_transactions.table_session_id` ancora NOT NULL
- `payment_allocations.table_order_line_id` ancora NOT NULL
- `order_post_payment_v1` / `order_post_refund_v1` / `order_apply_commercial_adjustment_v1`: assenti
- `mesa_post_refund_v1` live: firma originale intatta, DEFAULT non toccati

**Nessun tentativo di correzione eseguito.** Modificare la dichiarazione della funzione in
Migration 122 è una modifica di codice e richiede nuova autorizzazione esplicita.

**CHECKPOINT CONGELATO**: BE `1db251e` live (deploy `483b3dd9…`) · DB **121** ·
`CASH_HTTP_ENABLED` OFF · FE `8c95e17` (non toccato) · PROD `1d581d8` (non toccato).

---

# MIGRATION 122 APPLY FAILURE / PARAMETER DEFAULT FAST-FOLLOW

**Data**: 2026-09-07 · **Commit backend**: `0dffc2c` · **Base**: `1db251e` (invariato) · **Ledger**: 121 (invariato)

## PD.1 Fallimento (già registrato in SP.7, riassunto qui)

Apply byte-esatto tentato contro STAGING live → `ERROR 42P13: cannot remove parameter defaults
from existing function` su `CREATE OR REPLACE FUNCTION mesa_post_refund_v1(...)`. Rollback
transazionale pulito verificato su 3 assi indipendenti (ledger 121, colonne pre-122 intatte,
nessuna delle 3 nuove funzioni persistita, firma live di `mesa_post_refund_v1` invariata).

## PD.2 Default live esatti (introspezione pre-fix)

```
p_amount numeric DEFAULT NULL::numeric,
p_meta   jsonb   DEFAULT '{}'::jsonb
```

La dichiarazione item-7 di Migration 122 riportava `p_amount numeric, p_meta jsonb` — senza
default. `CREATE OR REPLACE FUNCTION` rifiuta di rimuovere un default esistente silenziosamente:
va riprodotto verbatim perché la dichiarazione sia accettata come replace anziché come modifica
d'identità (anche se, in senso stretto Postgres, `pg_get_function_identity_arguments` non include
mai i default — motivo per cui i grants restano intatti, come il commento originale correttamente
affermava).

## PD.3 Correzione

Una riga: aggiunti i due `DEFAULT` verbatim alla dichiarazione `CREATE OR REPLACE`. Nessun altro
cambiamento — stessi tipi/ordine/conteggio parametri, stesso corpo (resta l'unica riga
`<>` → `IS DISTINCT FROM`), stessi grants, nessun `DROP FUNCTION` in tutto il file forward.

**Nuova identità file forward**:

| | prima | dopo |
|---|---|---|
| sha256:16 | `aa901e7f2607f173` | **`ae15840600e14bd9`** |
| byte | 86.706 | 87.622 |
| righe | 1516 | 1528 |

Manifest riga 124: campo strutturato `sha256 (16)` aggiornato al nuovo valore; aggiunta nota
prosa che documenta il fast-follow.

## PD.4 Rollback — ISPEZIONATO, NON MODIFICATO (decisione proprietario richiesta)

**Trovato lo stesso difetto**: `...ROLLBACK.sql` riga 115 ha la stessa dichiarazione
`CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1(...)` con `p_amount numeric, p_meta jsonb`
— **senza** i due `DEFAULT`. Se mai eseguito dopo questo forward corretto, il rollback
fallirebbe con lo stesso 42P13, perché a quel punto la funzione live porterebbe ancora i default
(mai rimossi dal forward corretto) e la dichiarazione del rollback proverebbe a rimuoverli.

**Non modificato**, per mandato esplicito (§9): byte-identico, sha256 confermato invariato
`0af7b8e6f77096a379c3610032bb4233f010b966f82263c4b9e9f2e1802d38ad` (sha256:16
`0af7b8e6f77096a3`). Aggiunta una asserzione di test che **documenta** il difetto (attualmente
PASS, cioè conferma che il difetto è presente) — se il rollback viene corretto sotto
un'autorizzazione separata senza aggiornare quel test, l'asserzione inizierà a fallire
deliberatamente, così il difetto non può sparire silenziosamente da una revisione futura.

**Refuso di manifest pre-esistente** (segnalato nella promozione precedente, non di questo
fast-follow): la prosa del manifest riga 124 dichiara `rollback sha256:16 0af7b8e6f7709637`, ma
il valore reale è `0af7b8e6f77096a3`. È un campo di **prosa**, non il campo strutturato
`sha256 (16)` (quello è riservato al solo file forward, verificato dall'intestazione tabella).
Lasciato invariato, come da istruzione: non è il campo autoritativo, e cambiare i byte del
rollback solo per far coincidere il refuso è esplicitamente vietato.

## PD.5 Test

`tests/checkCentricUniversalCashV1Migration.test.js`:
- Corretta l'unica asserzione pre-esistente che fissava il testo della dichiarazione **buggy**
  (senza default) come se fosse corretta — prova diretta che una revisione solo statica/testuale
  non può individuare un default mancante; serve un tentativo di apply reale (o un confronto
  esplicito con la firma live).
- **7 nuove asserzioni**: entrambi i default dichiarati verbatim; argomenti di identità
  (tipi/ordine/conteggio) byte-identici alla firma live pre-122 dopo aver rimosso i soli due
  `DEFAULT`; resta `CREATE OR REPLACE` (nessun `DROP FUNCTION` per `mesa_post_refund_v1` in
  tutto il file); la dichiarazione corretta compare esattamente una volta; le asserzioni di
  corpo pre-esistenti (fix presente, vecchio confronto assente, altri `<>` intatti) restano
  valide sullo stesso corpo estratto; asserzione-documentazione del difetto nel rollback.

**Risultati**: **110/110 PASS** nel file targeted. Sweep completo backend: **305/306** (l'unico
fallimento è lo stesso `getOrdenesArchivadosSesionAuthorizationParity.test.js` pre-esistente e
indipendente, già documentato nel report originale — provato non correlato). Domain-language
guard OK (729 file).

## PD.6 Esito

- Nuovo commit backend: **`0dffc2c`**
- Storia: `9d65fac` → `1db251e` → **`0dffc2c`** (nessun amend)
- **STAGING lasciata esattamente dove l'apply fallito l'aveva lasciata, NON ritentata**:
  backend `1db251e` live (deploy `483b3dd9`), `CASH_HTTP_ENABLED` OFF, DB ledger **121**,
  frontend `8c95e17`.
- **PUSH: NO · DEPLOY: NO · MIGRATION APPLY: NO · PRODUCTION: UNTOUCHED**

## `MIGRATION_122_FAST_FOLLOW_ROLLBACK_DECISION_REQUIRED`

---

# MIGRATION 122 ROLLBACK PARAMETER DEFAULT FIX

**Data**: 2026-09-07 · **Commit backend**: `8ec5e24` · **Base**: `0dffc2c` (invariato) → `1db251e` (invariato) · **Ledger**: 121 (invariato)

## RB.1 Approvazione proprietario

Il difetto del rollback, segnalato ma non corretto nel fast-follow precedente (`0dffc2c`,
classificatore `MIGRATION_122_FAST_FOLLOW_ROLLBACK_DECISION_REQUIRED`), è ora **approvato per
la correzione** dal proprietario.

## RB.2 Difetto esatto

`...ROLLBACK.sql` riga 115, stessa dichiarazione `CREATE OR REPLACE FUNCTION mesa_post_refund_v1`
del forward file pre-fix: `p_amount numeric, p_meta jsonb` — senza i due `DEFAULT` che la
funzione live porta da sempre. Se mai eseguito **dopo** il forward corretto (`0dffc2c`), il
rollback avrebbe fallito con lo stesso `42P13`, perché a quel punto la funzione live conserverebbe
ancora i default (mai rimossi dal forward corretto) e la dichiarazione del rollback avrebbe
provato a rimuoverli.

## RB.3 Correzione

Una riga: aggiunti `DEFAULT NULL::numeric` a `p_amount` e `DEFAULT '{}'::jsonb` a `p_meta` nella
dichiarazione del rollback — identico pattern del fix forward. Nessun altro cambiamento: stesso
corpo (ancora `<>`, mai `IS DISTINCT FROM` — verificato esplicitamente, §6 del mandato), stessa
identità (tipi/ordine/conteggio parametri), stessi grants, nessun `DROP FUNCTION`. Le due guardie
hard-refuse (`payment_transactions.table_session_id IS NULL` / `payment_allocations` check-centric)
verificate intatte, a righe 27-31, non toccate dalla modifica a riga 115+.

**Nuova identità rollback**:

| | prima | dopo |
|---|---|---|
| sha256:16 | `0af7b8e6f77096a3` | **`32c7c954c074c1e9`** |
| byte | 23.458 | 24.307 |
| righe | 450 | 461 |

**Forward file confermato byte-identico** in ogni fase: `ae15840600e14bd9...`, non toccato da
questo commit rollback-only.

## RB.4 Manifest

Aggiornati **entrambi** i riferimenti al checksum del rollback nella riga 124 (§8 del mandato,
esplicito questa volta — non lasciarli come prosa stantia):
1. Il riferimento inline originale (che portava il refuso storico `0af7b8e6f7709637`) →
   aggiornato al nuovo valore reale `32c7c954c074c1e9`.
2. La nota del fast-follow precedente (`0dffc2c`) che dichiarava "rollback sha256:16 unchanged"
   → sostituita con una nota accurata che documenta il nuovo cambiamento, i byte/righe prima/dopo,
   e conferma il forward file invariato.

Il campo strutturato `sha256 (16)` della tabella (quello che conta per il forward) resta
`ae15840600e14bd9`, invariato — corretto, riguarda solo il forward file.

## RB.5 Test

`tests/checkCentricUniversalCashV1Migration.test.js`: l'asserzione "KNOWN DEFECT" del fast-follow
precedente è sostituita con l'insieme di prove richiesto (§9): entrambi i default presenti nel
rollback; argomenti di identità (tipi e ordine) invariati; contratto di ritorno (`RETURNS jsonb`)
invariato; corpo del rollback altrimenti invariato (ancora `<>`, mai la fix); nessun
`DROP FUNCTION`; guardie hard-refuse preservate verbatim; sha256 del forward file riverificato
live nel test contro il valore committato esatto. Aggiunto un nuovo blocco §10 che prova la
compatibilità forward/rollback: entrambe le dichiarazioni, diffate byte-a-byte, sono identiche
tra loro a parte il fix che ciascuna già portava — dimostrando strutturalmente che nessuna delle
due direzioni può più colpire il 42P13 su questa funzione.

**Risultati**: **120/120 PASS** nel file targeted (era 110/110 prima di questo commit). Sweep
completo backend: **305/306** — identico alla baseline precedente, stesso unico fallimento
pre-esistente e indipendente (`getOrdenesArchivadosSesionAuthorizationParity.test.js`).
Domain-language guard OK (729 file).

## RB.6 Nota di processo

Il primo tentativo di commit (`e8bcd6d`) conteneva un artefatto di bozza nel messaggio (un
"wait —" con un'autocorrezione lasciata visibile per errore). Corretto immediatamente con un
`git commit --amend` sul **nuovo** commit soltanto — non su `0dffc2c`, che il mandato protegge
esplicitamente e che resta byte-identico (stesso SHA `0dffc2cbe60aa952f64df654e6d33ba94061a0d3`,
verificato). Hash finale: `8ec5e24`.

## RB.7 Esito

- Nuovo commit backend: **`8ec5e24`**
- Storia: `9d65fac` → `1db251e` → `0dffc2c` → **`8ec5e24`** (nessun amend di `0dffc2c` o `1db251e`)
- **STAGING lasciata esattamente al checkpoint precedente, non toccata**: backend `1db251e` live,
  `CASH_HTTP_ENABLED` OFF, DB ledger **121**, frontend `8c95e17`.
- **PUSH: NO · DEPLOY: NO · MIGRATION APPLY: NO · PRODUCTION: UNTOUCHED**

## `MIGRATION_122_FORWARD_ROLLBACK_DEFAULTS_FIXED_LOCAL_AWAITING_FINAL_REVIEW`

---

# COORDINATED STAGING PROMOTION — SECOND ATTEMPT (BLOCKED AT MIGRATION APPLY)

**Data**: 2026-09-07 · **Backend live**: `8ec5e24` · **DB ledger**: 121 (invariato) · **Frontend**: `8c95e17` (invariato)

## PR2.1 Rivalidazione baseline (§6) — PASS su tutti i cancelli

Ledger tip 121 (0 righe a 122/123), schema pre-122 intatto, forward sha256
`ae15840600e14bd9` e rollback sha256 `32c7c954c074c1e9` confermati indipendentemente
identici ai byte autorizzati, campo strutturato manifest corretto, Migration 123 assente,
`CASH_HTTP_ENABLED` assente, BE live `1db251e`, FE live `8c95e17`, #999035 invariato,
produzione `1d581d8` invariata. Nessuna deriva.

## PR2.2 Push backend + deploy — FATTO

Fast-forward pulito `1db251e..8ec5e24` su `origin/feature/staging-messa-tables-2026-08-01`
(repo `ladieci_bot`). Railway auto-deploy: **`4b2d0123-5730-4039-b4dd-2602c7a7c47e` — SUCCESS**.
`/version` → `8ec5e2432f859e691350d3ff9370770eaf73ebd9`, boot `18:13:57Z`. `/health` 200.

## PR2.3 Smoke DB121 + BE8ec5e24 — PASS

Log di boot reali:
```
component="cash-v1"   state="disabled"  routeBase="/api/cash/v1"
component="mesa-v1"   state="enabled"
component="access-management-v3" state="enabled"
component="economy-v1" state="enabled" routes=5
[S4 boot check] migration heads: verified=121 recorded=121 unverified=56 level=yellow
```
Zero errori, zero PGRST, supabaseTransport 200.

## PR2.4 Apply Migration 122 — FALLITO (secondo errore, DIVERSO dal primo)

Stesso meccanismo byte-esatto già provato (nessuna via diretta psql/Supabase CLI disponibile
su questa macchina): `pbcopy` del file esatto (hash verificato prima e dopo) → utente incolla
con Cmd+V reale nella sessione Supabase SQL Editor autenticata → rilettura via clipboard e
verifica hash indipendente: **87.622/87.622 byte, 1528/1528 righe, sha256
`ae15840600e14bd9...` identico**. Zero rischio di trascrizione.

**Esecuzione fallita** (dopo "Run without RLS" — stesso falso positivo del linter su `v_def`,
variabile locale nei blocchi `DO`, non una tabella; nessun `CREATE TABLE` nel file):

```
ERROR: P0001: M122 post-condition failed: order_initial_payment_v1 still references order_mark_paid
CONTEXT: PL/pgSQL function inline_code_block line 144 at RAISE
```

**Diverso dal primo fallimento** (quello era 42P13 su `mesa_post_refund_v1`, riga 892 —
ora risolto). Questa volta la transazione è arrivata **più avanti** (conferma indiretta che
il fix ai default ha funzionato), fino alla propria post-condition finale, dove si è
fermata.

**Rollback verificato pulito** su 3 controlli indipendenti: ledger tip 121 (0 righe a 122/123),
colonne pre-122 ancora NOT NULL, nessuna delle 3 nuove funzioni persistita (solo
`mesa_post_refund_v1` esiste, con i default originali intatti — prova che anche il suo
CREATE OR REPLACE riuscito in questa stessa transazione è stato annullato dall'atomicità).

## PR2.5 Causa radice (letta dal file reale, riga 1460-1478)

```sql
-- riga 1465-1466
SELECT pg_get_functiondef(p.oid) INTO v_def ...
-- riga 1472-1473
IF position('order_mark_paid' IN v_def) > 0 THEN
  RAISE EXCEPTION 'M122 post-condition failed: order_initial_payment_v1 still references order_mark_paid';
```

`pg_get_functiondef()` restituisce la definizione completa della funzione **inclusi i
commenti PL/pgSQL verbatim** (Postgres non li rimuove da `prosrc`). Il corpo di
`order_initial_payment_v1` (riga 1311-1318) contiene:

```sql
-- THE canonical check-centric payment writer -- same authority, server-derived
-- amount, digest, and legacy mirrors as the operator collection path (§R of the
-- audit). mode='full': a creation-time "ya pagado" always settles the order's
-- FULL obligation, exactly like _ledger_write_payment/order_mark_paid did.
PERFORM public.order_post_payment_v1(
  v_workspace_id, v_actor, v_sid_hash, NEW.order_uid, v_method, 'full', NULL,
  v_client_request_id, v_request_hash,
  jsonb_build_object('source', 'initial_payment_at_creation'), false);
```

La chiamata reale (riga 1315) è correttamente `order_post_payment_v1` — il writer
canonico. La **prosa esplicativa** alla riga 1314 nomina "order_mark_paid" per contesto
storico ("esattamente come faceva order_mark_paid"), e questo basta a far scattare il
controllo ingenuo per sottostringa. **La funzione fa esattamente ciò che deve; è la sua
propria post-condition di auto-verifica ad avere un difetto** — un falso positivo, non un
comportamento economico sbagliato.

**Preesistente, non introdotto da questa sessione**: la riga 1314 fa parte del corpo
originale di `order_initial_payment_v1` sin da `1db251e`; né `0dffc2c` né `8ec5e24` hanno
mai toccato questa funzione (hanno modificato solo la dichiarazione di
`mesa_post_refund_v1`). Il difetto non era mai stato scoperto prima perché il tentativo
precedente falliva più a monte, su `mesa_post_refund_v1`, senza mai raggiungere questa
verifica.

**Nessun tentativo di correzione eseguito** — vietato esplicitamente dal mandato.

## PR2.6 Stato finale verificato

| | |
|---|---|
| Backend live | `8ec5e2432f859e691350d3ff9370770eaf73ebd9` (deploy `4b2d0123…`, /health 200) |
| DB ledger | **121** (0 righe a 122/123) |
| Schema pre-122 | intatto |
| `CASH_HTTP_ENABLED` | OFF (log di boot: `cash-v1 disabled`) |
| Frontend | `8c95e17664da4c803ffcd603803162edbc974426` (mai toccato — non si è mai arrivati allo stage flag/FE) |
| Produzione | `1d581d881b19cf201c3bd86603262a22056c2630` — intatta |
| #999035 | invariato |

## `NEW_PUSH_AUTHORIZATION_REQUIRED`

---

# MIGRATION 122 — COMMENT-SAFE POSTCONDITION FAST-FOLLOW

**Data**: 2026-09-07 · **Commit backend**: `267b583` · **Base**: `8ec5e24` (invariato) · **Ledger**: 121 (invariato)

## CS.1 Fallimento reale (già registrato in PR2.4-PR2.5)

Tentativo di apply byte-esatto contro STAGING live, arrivato oltre il fix ai default (nessun
42P13 questa volta — conferma indiretta che il fix funziona), fermato dalla propria
post-condition finale:

```
ERROR: P0001: M122 post-condition failed: order_initial_payment_v1 still references order_mark_paid
```

Rollback verificato pulito su 3 assi indipendenti: ledger 121, colonne pre-122 ancora NOT
NULL, nessuna delle 3 nuove funzioni persistita — inclusa la conferma che il `CREATE OR
REPLACE` di `mesa_post_refund_v1`, riuscito in questa stessa transazione, è stato comunque
annullato dall'atomicità.

## CS.2 Causa radice

`pg_get_functiondef()` restituisce `prosrc` verbatim — **i commenti PL/pgSQL non vengono
mai rimossi da Postgres**. Il corpo di `order_initial_payment_v1` (riga 1311-1318) contiene:

```sql
-- THE canonical check-centric payment writer -- ... mode='full': ... FULL obligation,
-- exactly like _ledger_write_payment/order_mark_paid did.
PERFORM public.order_post_payment_v1(...)
```

Il commento nomina "order_mark_paid" per contesto storico; la chiamata reale, due righe
sotto, è correttamente `order_post_payment_v1` (il writer canonico). Il controllo per
sottostringa nuda `position('order_mark_paid' IN v_def) > 0` non distingue un commento da
una chiamata — falso positivo, non un difetto economico.

## CS.3 Correzione

Irrigidite **entrambe** le condizioni nel blocco `DO $post$` (righe ~1469-1473) alla forma
esatta di chiamata PL/pgSQL già in uso in questo stesso codice — qualificata per schema,
parentesi immediatamente seguente:

```sql
IF position('PERFORM public.order_post_payment_v1(' IN v_def) = 0 THEN ...
IF position('PERFORM public.order_mark_paid(' IN v_def) > 0 THEN ...
```

**Simmetrico apposta**: corregge la direzione REJECT che è effettivamente scattata, e
irrobustisce anche la direzione ACCEPT (un commento che nominasse il writer canonico
avrebbe potuto soddisfare "la chiamata è presente" anche se la chiamata reale fosse stata
rimossa in futuro). La forma della chiamata legacy non è inventata: combacia esattamente
con la convenzione che questo stesso trigger usava prima di questa migrazione
(`2026-08-24_n3_canonical_initial_payment.sql`, `PERFORM public.order_mark_paid(`), e la
forma canonica combacia con la chiamata reale della migrazione due righe sopra il commento
che ha causato il problema.

**Perimetro rispettato**: il blocco `DO $guard$` (precondizione, righe ~195-207) mantiene
deliberatamente la stessa forma nuda — non è esposto a questo falso positivo oggi (l'unica
chiamata reale nel corpo pre-122 è davvero `order_mark_paid`, e `order_post_payment_v1` non
può ancora essere nominato in nessun commento perché quella funzione non esiste prima di
questa migrazione), e irrigidirlo era fuori dal perimetro stretto di questo fast-follow.
Nessuna DDL, corpo di writer, logica di business, frontend o file di rollback toccati.

**Nuova identità forward file**:

| | prima | dopo |
|---|---|---|
| sha256:16 | `ae15840600e14bd9` | **`9cbc9e1b2b59db51`** |
| byte | 87.622 | 88.938 |
| righe | 1528 | 1545 |

Rollback **byte-identico**, non toccato: `32c7c954c074c1e9` riconfermato indipendentemente.

## CS.4 Riproduzione locale del difetto (offline, nessun apply su STAGING)

Nuova sezione test che reimplementa localmente la semantica di `position()` di Postgres
contro il corpo reale della funzione estratto dal file, provando:

- **CASO A (prima del fix)**: il pattern VECCHIO avrebbe davvero dato falso positivo sul
  corpo reale — riproduce esattamente il fallimento live osservato.
- **CASO A (dopo il fix)**: il pattern NUOVO ignora correttamente la menzione nel commento
  e trova comunque la chiamata canonica reale.
- **CASO B**: una fixture sintetica con una chiamata legacy genuinamente reintrodotta
  (`PERFORM public.order_mark_paid(`) viene comunque correttamente rifiutata dal pattern
  NUOVO — prova che la correzione discrimina, non che è semplicemente diventata cieca al
  nome.

## CS.5 Test e sweep

`tests/checkCentricUniversalCashV1Migration.test.js`: asserzione stantia sul testo del
pattern vecchio aggiornata; asserzione di checksum del forward file ripuntata al nuovo
valore committato; **127/127 PASS** (era 120/120). Uno dei nuovi test è fallito al primo
tentativo per un mio errore di perimetro (cercava la forma vecchia nell'intero file,
catturando anche il blocco `$guard$` intenzionalmente non toccato) — corretto scoperendo la
verifica al solo blocco `$post$`.

Sweep completo backend: **305/306** — identico alla baseline precedente, stesso unico
fallimento pre-esistente e indipendente (`getOrdenesArchivadosSesionAuthorizationParity.test.js`).
Domain-language guard OK (729 file).

## CS.6 Esito

- Nuovo commit backend: **`267b583`**
- Storia: `9d65fac` → `1db251e` → `0dffc2c` → `8ec5e24` → **`267b583`** (nessun amend)
- **STAGING non toccata da questo commit**: backend `8ec5e24` live (flag
  `CASH_HTTP_ENABLED` OFF), DB ledger **121**, frontend `8c95e17`.
- **PUSH: NO · DEPLOY: NO · MIGRATION APPLY: NO · PRODUCTION: UNTOUCHED**

## `MIGRATION_122_COMMENT_SAFE_POSTCONDITION_FIXED_LOCAL_AWAITING_REVIEW`

---

# COORDINATED STAGING PROMOTION — TERZO TENTATIVO (BLOCCATO ALL'APPLY, TERZO ERRORE)

**Data**: 2026-09-07 · **Backend live**: `267b583` · **DB ledger**: 121 (invariato) · **Frontend**: `8c95e17` (invariato)

## PR3.1 Rivalidazione baseline (§4) — PASS su tutti i cancelli

Ledger tip 121, forward sha256 `9cbc9e1b2b59db51` e rollback sha256 `32c7c954c074c1e9` confermati
indipendentemente, campo manifest strutturato corretto, Migration 123 assente, schema pre-122
intatto, `CASH_HTTP_ENABLED` assente, #999035 invariato, produzione `1d581d8` invariata. Backend
live reale confermato `8ec5e24` (coerente col mandato). Nessuna deriva.

## PR3.2 Push backend + deploy — FATTO

Fast-forward pulito `8ec5e24..267b583` su `origin/feature/staging-messa-tables-2026-08-01`.
Railway auto-deploy: **`832f77a9-ddc7-41fc-beb2-ccc36fea34f7` — SUCCESS**. `/version` →
`267b583d752889707884b60e818c455c3247b14f`, boot `18:57:18Z`. `/health` 200.

## PR3.3 Smoke DB121 + BE267b583 — PASS

```
component="cash-v1"   state="disabled"
component="mesa-v1"   state="enabled"
[S4 boot check] migration heads: verified=121 recorded=121 unverified=56 level=yellow
```
Zero errori.

## PR3.4 Apply Migration 122 — FALLITO (terzo errore, ancora diverso)

Stesso meccanismo byte-esatto (`pbcopy` verificato → utente incolla con Cmd+V reale →
rilettura e verifica hash indipendente: **88.938/88.938 byte, 1545/1545 righe, sha256
`9cbc9e1b2b59db51...` identico**).

**Esecuzione fallita**, ma **più avanti** di entrambi i tentativi precedenti — conferma che
sia il fix ai default (42P13) sia il fix comment-safe (falso positivo `order_mark_paid`)
funzionano entrambi:

```
ERROR: P0001: M122 post-condition failed: the ledger stopped being append-only
CONTEXT: PL/pgSQL function inline_code_block line 206 at RAISE
```

**Rollback verificato pulito** su 3 controlli indipendenti: ledger tip 121 (0 righe a
122/123), colonne pre-122 ancora NOT NULL, nessuna delle 3 nuove funzioni persistita.

## PR3.5 Causa radice — diversa dalle prime due: NON è un difetto nel testo della migration

Righe 1531-1535 del file:

```sql
IF has_table_privilege('service_role','public.payment_transactions','UPDATE')
   OR has_table_privilege('service_role','public.payment_transactions','DELETE')
   OR has_table_privilege('service_role','public.payment_allocations','UPDATE')
   OR has_table_privilege('service_role','public.payment_allocations','DELETE') THEN
  RAISE EXCEPTION 'M122 post-condition failed: the ledger stopped being append-only';
```

Verificato dal vivo (sola lettura):

```
pt_update=true  pt_delete=true  pa_update=true  pa_delete=true
```

**`service_role` ha davvero UPDATE e DELETE su entrambe le tabelle sul DB reale.** Non è
un'invenzione del controllo. Verificato che Migration 122 stessa **non concede** questi
privilegi da nessuna parte (zero `GRANT` su queste due tabelle in tutto il file) — non è
questa migrazione a introdurre il problema.

**Storia**: nessuna migrazione in tutto il repository (incluso
`2026-07-15_b7_financial_ledger_grant_hardening.sql`, il cui nome suggerirebbe proprio
questo) ha mai eseguito un `REVOKE UPDATE, DELETE ON payment_transactions/payment_allocations
FROM service_role`. L'enforcement "solo append" per queste due tabelle specifiche sembra
basarsi **interamente sul trigger** (`payment_transactions_append_only_v1` /
`payment_allocations_append_only_v1`, verificati presenti e funzionanti), non sulla revoca
dei privilegi. La post-condition di Migration 122 assume/asserisce **entrambe** le difese
(trigger E privilegi revocati), ma solo la prima è mai stata effettivamente realizzata su
questo database.

**Non è una regressione delle mie correzioni**: verificato che questo identico controllo
esiste, byte-per-byte, sin dal commit originale `1db251e` — nessuno dei tre fast-follow
(`0dffc2c`, `8ec5e24`, `267b583`) lo ha mai toccato. È la prima volta che un tentativo di
apply arriva così lontano nella transazione da mettere alla prova questa assunzione contro
il DB reale.

**Nessun tentativo di correzione eseguito** — sistemarlo richiederebbe o una modifica al
testo della migration (codice) o una scrittura diretta sul DB (`REVOKE`), entrambe vietate
esplicitamente da questo mandato.

## PR3.6 Stato finale verificato

| | |
|---|---|
| Backend live | `267b583d752889707884b60e818c455c3247b14f` (deploy `832f77a9…`, /health 200) |
| DB ledger | **121** (0 righe a 122/123) |
| Schema pre-122 | intatto |
| `CASH_HTTP_ENABLED` | OFF |
| Frontend | `8c95e17664da4c803ffcd603803162edbc974426` (mai toccato) |
| Produzione | `1d581d881b19cf201c3bd86603262a22056c2630` — intatta |
| #999035 | invariato |

## `MIGRATION_122_APPLY_FAILED_NEW_PUSH_AUTH_REQUIRED`

---

# MIGRATION 122 — REAL APPEND-ONLY ENFORCEMENT FAST-FOLLOW

**Data**: 2026-09-07 · **Commit backend**: `9589051` · **Base**: `267b583` (invariato) · **Ledger**: 121 (invariato)

## AO.1 Fallimento reale (già registrato in PR3.4-PR3.5)

Terzo tentativo di apply byte-esatto, arrivato oltre i due fix precedenti (nessun 42P13,
nessun falso positivo sul commento), fermato dalla propria post-condition:

```
ERROR: P0001: M122 post-condition failed: the ledger stopped being append-only
```

## AO.2 Causa radice — verificata dal vivo, non un'invenzione del controllo

`has_table_privilege('service_role', 'public.payment_transactions'/'payment_allocations',
'UPDATE'/'DELETE')` è risultato **vero** su STAGING reale. Verificato che Migration 122
stessa non concede questi privilegi da nessuna parte. Cercato in tutta la storia del
repository (inclusa `2026-07-15_b7_financial_ledger_grant_hardening.sql`) — **nessuna
migrazione ha mai revocato** UPDATE/DELETE da `service_role` su queste due tabelle.

**Meccanismo reale identificato**: la migrazione fondativa
(`2026-08-01_v3h_messa_billing_foundation.sql`) concede a `service_role` **solo**
`SELECT, INSERT`. L'enforcement "solo append" si è sempre basato **esclusivamente sul
trigger**:

```
payment_transactions_append_only_v1  BEFORE DELETE OR UPDATE  (tgenabled='O')
payment_allocations_append_only_v1   BEFORE DELETE OR UPDATE  (tgenabled='O')
                     entrambi eseguono mesa_append_only_v1()
```

Corpo reale della funzione, verificato dal vivo:
```sql
BEGIN
  RAISE EXCEPTION 'MESA_APPEND_ONLY' USING ERRCODE='55000';
END
```

Blocca incondizionatamente ogni UPDATE/DELETE, indipendentemente dai privilegi di tabella.
La verifica basata sui privilegi asserisce una difesa mai realmente implementata — non un
regresso introdotto da questa o da nessuna sessione precedente.

## AO.3 Correzione

Sostituito **solo** il blocco `has_table_privilege` (righe 1531-1536 originali) in `$post$`
con una verifica basata su `pg_get_triggerdef()` a corrispondenza esatta contro la
definizione canonica **verificata dal vivo** di ciascun trigger (prova esistenza, non
disabilitato, tempistica, entrambi gli eventi e la funzione esatta in un'unica asserzione),
più un controllo diretto che `mesa_append_only_v1` contenga ancora `RAISE EXCEPTION`.

**Ogni valore della sostituzione è stato verificato dal vivo, in sola lettura, prima di
scriverlo nella migrazione** — e la nuova logica è stata poi testata (sola lettura) contro
il DB reale, confermando che non solleva eccezioni.

**Perimetro rispettato**: i controlli di sola-esistenza preesistenti in `$guard$` e `$post$`
(con i propri messaggi distinti "trigger is missing"/"disappeared") sono rimasti intatti —
`$guard$` non conteneva mai l'assunzione errata sui privilegi, quindi solo `$post$` andava
corretto. Nessun `REVOKE` introdotto — la scelta se irrigidire i privilegi resta separata e
rimandata (vedi §AO.5). Nessuna DDL, corpo di writer, logica di business, frontend o file di
rollback toccati.

**Nuova identità forward file**:

| | prima | dopo |
|---|---|---|
| sha256:16 | `9cbc9e1b2b59db51` | **`3c7bedd144c24bb3`** |
| byte | 88.938 | 92.375 |
| righe | 1545 | 1590 |

Rollback **byte-identico**, non toccato: `32c7c954c074c1e9` riconfermato — documentava già
correttamente il modello a trigger nel proprio commento di intestazione.

## AO.4 Test

`tests/checkCentricUniversalCashV1Migration.test.js`: asserzione stantia sostituita con
verifiche precise (controllo del codice **eseguibile**, non della prosa esplicativa che
inevitabilmente cita "has_table_privilege" per spiegare cosa è stato tolto). Aggiunta
simulazione locale della semantica `IS DISTINCT FROM` di Postgres contro fixture sintetiche,
a prova dei 5 casi richiesti: **A** (modello storico reale — grant presenti ma trigger
installato/abilitato → PASS), **B** (trigger mancante → FAIL), **C** (trigger disabilitato →
FAIL), **D** (funzione trigger sbagliata, sia come definizione scambiata sia come funzione
ridefinita a no-op → FAIL in entrambi i casi), **E** (nessuna revoca INSERT implicita).

**Risultati**: **138/138 PASS** (era 127/127). Sweep completo: **305/306** — identico,
stesso unico fallimento pre-esistente indipendente. Domain-language guard OK dopo aver
corretto il posizionamento del marcatore di soppressione (la citazione del nome file storico
"...messa_billing_foundation.sql" richiedeva il marcatore sulla **stessa riga**, non su
quella successiva — lezione appresa sul meccanismo esatto del guard).

## AO.5 Debito futuro registrato (non risolto in questo ciclo)

**`FINANCIAL_LEDGER_SERVICE_ROLE_PRIVILEGE_HARDENING_REVIEW`**: `service_role` possiede
tuttora privilegi di tabella UPDATE/DELETE su `payment_transactions`/`payment_allocations`,
anche se i trigger append-only li rifiutano comunque. Una futura decisione separata potrà
valutare se una `REVOKE` esplicita sia sicura e desiderabile come difesa aggiuntiva. Non
confuso con la correttezza di Migration 122 in questo ciclo.

## AO.6 Esito

- Nuovo commit backend: **`9589051`**
- Storia: `9d65fac` → `1db251e` → `0dffc2c` → `8ec5e24` → `267b583` → **`9589051`**
  (nessun amend)
- **STAGING non toccata da questo commit**: backend `267b583` live, `CASH_HTTP_ENABLED` OFF,
  DB ledger **121**, frontend `8c95e17`.
- **PUSH: NO · DEPLOY: NO · MIGRATION APPLY: NO · PRODUCTION: UNTOUCHED**

## `MIGRATION_122_APPEND_ONLY_REAL_ENFORCEMENT_FIXED_LOCAL_AWAITING_REVIEW`

---

# MIGRATION 122 — ROBUST TRIGGER IDENTITY/ENABLEMENT FAST-FOLLOW

**Data**: 2026-09-07 · **Commit backend**: `46300d2` · **Base**: `9589051` (invariato) · **Ledger**: 121 (invariato)

## RT.1 Difetto trovato dalla revisione finale (non da un nuovo apply reale)

La revisione finale prima della promozione (di `9589051`) ha trovato il proprio controllo
**fragile all'ambiente**, senza bisogno di un altro tentativo reale su STAGING:

1. **Dipendenza da `search_path`**: il controllo confrontava il testo **reso** da
   `pg_get_triggerdef()` contro una stringa canonica fissa. Verificato dal vivo, in sola
   lettura, entrambi i modi nella stessa sessione:
   - `search_path` con `public` → rende `EXECUTE FUNCTION mesa_append_only_v1()`
   - `SET LOCAL search_path = pg_catalog` → rende `EXECUTE FUNCTION
     public.mesa_append_only_v1()` — **stringa diversa per lo stesso identico trigger**.
2. **`tgenabled <> 'D'` accettava erroneamente `'R'`** (solo-replica), che non protegge le
   scritture di sessioni ordinarie.

## RT.2 Correzione — identità di catalogo, non testo reso

- **`t.tgfoid = 'public.mesa_append_only_v1()'::regprocedure`** — uguaglianza di OID tramite
  un letterale esplicitamente qualificato per schema, quindi il cast risolve la stessa
  funzione indipendentemente dal `search_path` della sessione. **Riverificato dal vivo sotto
  entrambi gli stati di `search_path`: identico `TRUE` in entrambi i casi** (sia il solo
  confronto `tgfoid`, sia il predicato completo per entrambe le tabelle).
- **`t.tgtype = 27`** (ROW+BEFORE+DELETE+UPDATE). Postgres non espone accessori booleani
  nominati per tempistica/eventi dei trigger, solo questa colonna bitmask — i valori dei bit
  (ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16) sono stati **derivati da prove di
  catalogo dal vivo, non dalla memoria**: incrociando il `tgtype` di dodici trigger reali non
  interni in questo database contro il proprio testo `pg_get_triggerdef()` e risolvendo il
  sistema lineare risultante — tutti e dodici i punti dato coerenti con un'unica soluzione.
  Il trigger storicamente installato ha `tgtype=27` confermato dal vivo, combaciante con
  altri cinque trigger reali in questo stesso database con la stessa identica forma.
- **`t.tgenabled IN ('O','A')`** — `'O'` (stato live reale) e `'A'` proteggono entrambi le
  scritture ordinarie; `'R'` e `'D'` sono rifiutati esplicitamente.

**Autorità sul corpo funzione preservata invariata** (classificata `SUFFICIENT` dalla
revisione, non ampliata): il controllo su `mesa_append_only_v1`'s `prosrc` contenente ancora
`RAISE EXCEPTION`, schema-fissato via `regnamespace`, resta esattamente com'era.

**Perimetro rispettato**: tutto dal primo byte del file fino alla riga immediatamente prima
di questo blocco — ogni DDL, tutti e tre i nuovi writer, `mesa_post_refund_v1`,
`order_initial_payment_v1`, i grant, il blocco `$guard$` — verificato **byte-identico** a
`9589051`. Nessun `REVOKE`/`GRANT` introdotto. Rollback **byte-identico**, non toccato.

**Nuova identità forward file**:

| | prima | dopo |
|---|---|---|
| sha256:16 | `3c7bedd144c24bb3` | **`31ab8b8f5d2928cf`** |
| byte | 92.375 | 95.332 |
| righe | 1590 | 1635 |

## RT.3 Test

Sostituite le asserzioni che fissavano il vecchio testo reso e il vecchio `<> 'D'` con
asserzioni sui nuovi predicati `tgfoid`/`tgtype`/`tgenabled` (scoperte al **solo codice
eseguibile**, non ai miei stessi commenti esplicativi — stessa lezione già imparata in
questa sessione: un mio primo tentativo ha dato 2 falliti per aver contato anche la
citazione nel commento; corretto scoperendo il conteggio alle sole righe `AND`).

Nuova matrice **CASO A-K**, simulando localmente il predicato strutturale reale
(relazione/nome/interno/tgenabled/tgfoid/tgtype, mai testo reso): **A** (`tgenabled='O'` →
PASS), **B** (`'A'` → PASS), **C** (`'R'` → FAIL, esattamente il caso che la vecchia forma
accettava erroneamente), **D** (`'D'` → FAIL), **E** (tgfoid sbagliato → FAIL anche con
testo del nome identico), **F** (**stesso trigger valido, due "rese" simulate diverse — una
per ogni stato di search_path — passa comunque entrambe le volte**, perché il predicato non
legge mai la stringa resa), **G** (solo AFTER → FAIL), **H** (solo UPDATE → FAIL), **I**
(solo DELETE → FAIL), **J** (relazione sbagliata → FAIL), **K** (trigger interno → FAIL);
più una nota `PROVEN_BY_PREDICATE` per il livello STATEMENT (bit ROW assente) — non un caso
richiesto separato, ma comunque escluso dalla stessa uguaglianza esatta.

**Risultati**: **151/151 PASS** (era 138/138). Sweep completo: **305/306** — identico,
stesso unico fallimento pre-esistente indipendente. Domain-language guard OK (729 file).

## RT.4 Esito

- Nuovo commit backend: **`46300d2`**
- Storia: `9d65fac` → `1db251e` → `0dffc2c` → `8ec5e24` → `267b583` → `9589051` →
  **`46300d2`** (nessun amend)
- **STAGING non toccata da questo commit**: backend `267b583` live, `CASH_HTTP_ENABLED` OFF,
  DB ledger **121**, frontend `8c95e17`.
- **PUSH: NO · DEPLOY: NO · MIGRATION APPLY: NO · PRODUCTION: UNTOUCHED**
- Debito futuro `FINANCIAL_LEDGER_SERVICE_ROLE_PRIVILEGE_HARDENING_REVIEW` ancora
  correttamente separato e rimandato — non toccato.

## `MIGRATION_122_ROBUST_APPEND_ONLY_CHECK_FIXED_LOCAL_AWAITING_FINAL_REVIEW`

---

# COORDINATED STAGING PROMOTION — QUARTO TENTATIVO: **MIGRATION 122 APPLICATA CON SUCCESSO**

**Data**: 2026-09-08 · **Backend live**: `46300d2` · **DB ledger**: **122** (registrato) · **Frontend**: `8c95e17` (invariato)

## PR4.1 Rivalidazione baseline (§4) — PASS su tutti i cancelli

Ledger tip 121, forward sha256 `31ab8b8f5d2928cf` e rollback sha256 `32c7c954c074c1e9`
confermati indipendentemente, campo manifest strutturato corretto, Migration 123 assente,
schema pre-122 intatto, `CASH_HTTP_ENABLED` assente, #999035 invariato, produzione
`1d581d8` invariata.

## PR4.2 Push backend + deploy — FATTO

Fast-forward pulito `267b583..46300d2`. Railway auto-deploy:
**`dd48e6be-4196-47ef-9ee2-b71b5956d5b8` — SUCCESS**. `/version` →
`46300d22b341575f0788d79fce9cce73bd044e5e`, boot `05:02:35Z`. `/health` 200.

## PR4.3 Smoke DB121 + BE46300d2 — PASS

```
component="cash-v1"   state="disabled"
component="mesa-v1"   state="enabled"
[S4 boot check] migration heads: verified=121 recorded=121 unverified=56 level=yellow
```
Zero errori.

## PR4.4 Apply Migration 122 — **SUCCESSO** (primo COMMIT reale dopo 4 tentativi)

Stesso meccanismo byte-esatto già provato (`pbcopy` verificato → utente incolla con Cmd+V
reale → rilettura e verifica hash indipendente: **95.332/95.332 byte, 1635/1635 righe,
sha256 `31ab8b8f5d2928cf...` identico**).

**Esecuzione riuscita**: `"Success. No rows returned"` — la transazione (`BEGIN...COMMIT`,
guard + DDL + 5 funzioni + post-condition completa) è stata **committata per davvero**,
per la prima volta su quattro tentativi. I tre difetti precedenti (default parametri,
falso positivo sul commento, assunzione errata sui privilegi/rendering search_path) sono
tutti stati superati.

## PR4.5 Verifica post-apply — §9 DB CONTRACT + §10 FUNCTION CONTRACT — **PASS completo**

**Schema (§9)**:
```
payment_transactions.table_session_id  nullable=YES
scope CHECK: CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))
payment_allocations.table_order_line_id  nullable=YES
payment_allocations.order_uid  uuid, nullable=YES
target CHECK: CHECK (((table_order_line_id IS NOT NULL) OR (order_uid IS NOT NULL)))
FK order_uid → order_entities  ✓
indice unique check-centric presente  ✓
```

**Funzioni (§10)** — tutte e 5 presenti con firme corrette:
`order_post_payment_v1`, `order_post_refund_v1`, `order_apply_commercial_adjustment_v1`,
`order_initial_payment_v1`, `mesa_post_refund_v1`. Verificato dal vivo:
- `mesa_post_refund_v1`: `p_amount DEFAULT NULL::numeric, p_meta DEFAULT '{}'::jsonb`
  preservati; corpo usa `IS DISTINCT FROM`.
- `order_initial_payment_v1`: chiama `order_post_payment_v1`, **nessuna** chiamata
  eseguibile a `order_mark_paid`.
- **Trigger append-only, entrambe le tabelle**: `tgtype=27`, `tgenabled='O'`,
  `tgfoid` corrisponde a `public.mesa_append_only_v1()`, `tgisinternal=false` —
  esattamente il contratto strutturale robusto, confermato **live, post-apply**.

## PR4.6 Registrazione ledger 122 — FATTO

Riga inserita in `ladieci_schema_migrations`: `apply_order=122`, `checksum_sha256=
'31ab8b8f5d2928cf'`, `kind='ddl'`, `verification_status='verified'`, `applied_by='46300d2'`.

Verificato: **`ledger_tip=122`, `rows_at_122=1`, `rows_at_123=0`**.

## PR4.7 Stato attuale — PAUSA SICURA al gate `ya_pagado` autenticato

Il gate §12 richiede una sessione operatore **autenticata reale** (login PIN) e la
creazione di un ordine vero tramite l'interfaccia normale dell'app (Servicio/Banco/Retiro
con `ya_pagado=true`), per provare che il percorso di creazione canonica funzioni davvero
in produzione applicativa — non tramite SQL, non tramite #999035.

**Non posso e non devo eseguire questo passo da solo**: non ho credenziali di login
staging, e anche se le avessi non dovrei inserirle — è un'azione finanziaria reale che
deve passare da un vero operatore umano. Mi fermo qui, esattamente al checkpoint sicuro
previsto dal mandato.

## PR4.8 Stato finale verificato

| | |
|---|---|
| Backend live | `46300d22b341575f0788d79fce9cce73bd044e5e` (deploy `dd48e6be…`, /health 200) |
| DB ledger | **122** (registrato, verificato) |
| Schema | Migration 122 applicata con successo |
| `CASH_HTTP_ENABLED` | OFF (non ancora abilitato — in attesa del gate ya_pagado) |
| Frontend | `8c95e17664da4c803ffcd603803162edbc974426` (mai toccato) |
| Produzione | `1d581d881b19cf201c3bd86603262a22056c2630` — intatta |
| #999035 | invariato |

## `CHECK_CENTRIC_UNIVERSAL_CASH_V1_PROMOTION_PAUSED_AT_AUTHENTICATED_YA_PAGADO_GATE`

---

# MIGRATION 123 — ORDER_INITIAL_PAYMENT DIGEST SCHEMA QUALIFICATION

**2026-09-08.** Il gate PR4.7 sopra è stato eseguito dal vero owner: login fresco
staging, poi un ordine reale Servicio/Banco/Retiro, `Pagado=true`, `Efectivo`. **Fallito**:
`"No se pudo confirmar el pedido."`, nessun numero d'ordine prodotto.

## Root cause forense (audit READ-ONLY separato, stesso giorno)

Verbale completo: `FORENSIC_YA_PAGADO_CREATION_FAILURE_M122_2026-09-08.md`. Sintesi:

L'INSERT su `ordenes` è tornato da PostgREST con **HTTP 404**, che su un INSERT di
tabella può derivare **solo** da `42883` (undefined_function) o `42P01`
(undefined_table) — mai da uno dei `RAISE ... P0001` di questo codebase (che mappano a
400). Questo da solo ha escluso `ORDER_INTAKE_CLOSED` e ogni rifiuto
`INITIAL_PAYMENT_*`/`ORDER_PAYMENT_*` come causa.

Prova di catalogo, in sola lettura: la migrazione 122 ha lasciato
`order_initial_payment_v1()` con `SET search_path TO 'public', 'pg_temp'` (ereditato
verbatim da N-3, dove era corretto perché quella versione non chiamava nessuna
funzione di estensione) mentre introduceva, nell'assegnazione del request-hash, la
**prima chiamata in assoluto** della funzione a `digest(...)` non qualificato.
`pgcrypto` su questo progetto Supabase installa `digest(text,text)` **solo** nello
schema `extensions` (nessun overload `public.digest` esiste) — quindi sotto il proprio
search_path la chiamata non può risolversi. Confermato in modo indipendente:
`to_regprocedure('digest(text,text)')` restituisce NULL sotto `public, pg_temp`,
si risolve sotto `public, extensions, pg_temp`; e uno sweep sull'intero schema
`public` ha provato che `order_initial_payment_v1` era l'**unica** funzione a chiamare
digest/crypt/hmac/gen_random_bytes senza `extensions` sul proprio path — le funzioni
sorelle create dalla STESSA migrazione (`order_post_payment_v1`, `order_post_refund_v1`,
`mesa_post_refund_v1`) portano tutte correttamente `public, extensions, pg_temp`.

**Atomicità confermata**: rollback pulito, zero righe nuove ovunque (ordine, obbligo,
pagamento, servizio, Business Day), `#999035` invariato.

## Decisione owner, congelata

**NON** allargare il `search_path` di `order_initial_payment_v1` a `public, extensions,
pg_temp`. Invece: qualificare esplicitamente lo schema al punto di chiamata
(`digest(...)` → `extensions.digest(...)`), lasciando il `search_path` della funzione
**esattamente** `public, pg_temp`. Motivazione: l'autorità crittografica deve essere
esplicita e schema-qualificata, indipendente dalla risoluzione ambientale del
search_path.

## Il fix — Migration 123

Nuovi file, **Migration 122 mai toccata**:

- `migrations/2026-09-08_order_initial_payment_digest_schema_fix_migration_123.sql`
- `migrations/2026-09-08_order_initial_payment_digest_schema_fix_migration_123.ROLLBACK.sql`
- `tests/orderInitialPaymentDigestSchemaFixMigration.test.js` (75 assert, tutti PASS)
- riga 125 aggiunta a `migrations/MIGRATION_MANIFEST.md` (decorativa, come da
  convenzione post-S4 — l'autorità reale resta `ladieci_schema_migrations`)
- una correzione di 1 riga in `tests/checkCentricUniversalCashV1Migration.test.js`:
  la sua assert originale "no migration 123 file exists" (scritta quando M122 credeva,
  nel proprio header, "NO migration 123. Everything above ships in this one file")
  è stata sostituita da un'assert che accetta **esattamente** questa Migration 123
  owner-autorizzata e rifiuta qualunque altra — **M122.sql stesso non è stato toccato**,
  solo il suo file di test.

**Diff semantico, esattamente UNA riga**:
```
PRIMA:  v_request_hash := encode(digest(...), 'hex');
DOPO:   v_request_hash := encode(extensions.digest(...), 'hex');
```
Verificato meccanicamente: annullando la sola qualificazione (`extensions.digest(` →
`digest(`) nel nuovo corpo lo rende **byte-identico** al corpo installato da M122 —
prova che nessun'altra semantica (algoritmo sha256, input concat_ws, encoding hex,
chiave idempotente `pay-order-<id>`, ogni guardia N-3, la chiamata al writer canonico)
è cambiata.

**Guard/post-condition** (house style: identità per OID/catalogo, mai testo
renderizzato — stessa disciplina della fast-follow trigger di M122): la migrazione
rifiuta se il corpo installato non è esattamente l'epoca M122 (search_path, chiamata
`digest()` non qualificata presente, `order_post_payment_v1` già chiamato, trigger
`ordenes_paid_at_creation_payment_v1` live e puntato per **OID** — `t.tgfoid =
'public.order_initial_payment_v1()'::regprocedure` — su questa funzione, ledger a 122).
Un blocco `$resolve$` prova poi, in sola lettura e solo transazione-locale (`SET LOCAL
search_path`, che si annulla automaticamente al COMMIT), che `extensions.digest(text,
text)` risolve allo stesso OID indipendentemente dal search_path ambientale, e che il
nome non qualificato davvero non risolve sotto il search_path proprio della funzione —
riproducendo il difetto forense prima di correggerlo.

**Rollback**: ripristina l'esatta epoca M122 (digest non qualificato) — documentato
esplicitamente come `ROLLBACK_RESTORES_KNOWN_BROKEN_M122_YA_PAGADO_BEHAVIOR`. Corpo
verificato byte-identico al corpo installato da M122.

**Immutabilità M122**: checksum sha256 di forward e rollback ricalcolati e confrontati
con valori pinnati nel nuovo test — **invariati**. Incrociati anche, in sola lettura,
con il ledger live `ladieci_schema_migrations` per `apply_order=122`: il suo
`checksum_sha256` (`31ab8b8f5d2928cf`) combacia esattamente con i primi 16 caratteri
hex dello sha256 completo del file su disco.

## Checksum esatti

| File | SHA256 | SHA256:16 | bytes | lines |
|---|---|---|---|---|
| `..._migration_123.sql` | `18b192eff6d7c5918ed727383972bbb116c2d2c986435aea06b5166b93621b91`\* | `18b192eff6d7c591` | 24381 | 436 |
| `..._migration_123.ROLLBACK.sql` | `64992c1add6d6ff3a07b9ed7dda11daabd07f45d2672e8b7ace328883349f950` | `64992c1add6d6ff3` | 12671 | 247 |
| `..._migration_122.sql` (invariato, pinnato) | `31ab8b8f5d2928cf56aa2ecf6cab3eee6de4a77f68ef025f5405d74f7e9a4fb6` | `31ab8b8f5d2928cf` | 95332 | 1635 |
| `..._migration_122.ROLLBACK.sql` (invariato, pinnato) | `32c7c954c074c1e9203f19447c19766f6dbc298be95386976b0232fd107c299f` | `32c7c954c074c1e9` | 24307 | 461 |

\* Nota: le 64 cifre esadecimali sono corrette; una prima resa nel testo del report
poteva apparire con spaziatura ambigua per il wrapping del terminale — il valore
riportato qui è quello effettivamente calcolato con `shasum -a 256`.

## Test

- **Nuovo file mirato**: `tests/orderInitialPaymentDigestSchemaFixMigration.test.js` —
  **75/75 PASS** (Case A–L del mandato tutte coperte, più search_path independence,
  no-other-object-change, debiti separati).
- **Regressione M122**: `tests/checkCentricUniversalCashV1Migration.test.js` —
  **151/151 PASS** dopo la correzione mirata di 1 riga (vedi sopra).
- **Manifest/ordine**: `tests/migrationManifestOrder.test.js` — **4/4 PASS**.
- **Domain-language guard**: `node scripts/check-domain-language.js` →
  **`DOMAIN_LANGUAGE_GUARD_OK`** (732 file controllati, 0 nuove occorrenze).
- **Sweep completo backend**: **306/307 PASS** (era 305/306 — 1 nuovo file di test,
  tutti gli altri identici). L'unico fallimento è lo stesso, identico, indipendente
  `tests/getOrdenesArchivadosSesionAuthorizationParity.test.js` (18/21 assert, "exactly
  one action added vs HEAD" — pre-esistente, non correlato a questo fix).

## Commit locale

Un solo commit backend sopra `46300d2` (nessun amend, nessun push).

## Stato finale

| | |
|---|---|
| Backend live (invariato) | `46300d22b341575f0788d79fce9cce73bd044e5e` |
| DB ledger | **122** (Migration 123 scritta, **NON applicata** — nessuna scrittura DB) |
| `CASH_HTTP_ENABLED` | OFF (invariato) |
| Frontend | `8c95e17664da4c803ffcd603803162edbc974426` (invariato) |
| Produzione | intatta |
| `#999035` | invariato |
| Migration 122 | invariata, checksum confermato |

Debiti separati registrati, **non toccati** in questo commit:
`MANUAL_ORDER_INTAKE_BUSINESS_DAY_AUTHORITY_V1`,
`OBSERVABILITY_SUPABASE_ERROR_BODY_V1`, `ORDER_CREATION_ERROR_DETAIL_LOST_V1`,
`FINANCIAL_LEDGER_SERVICE_ROLE_PRIVILEGE_HARDENING_REVIEW`,
`RIDER_LEGACY_PAYMENT_FAST_FOLLOW`, `SERVICIO_DEAD_ONCAMBIAPAGO_CANONICAL_CONFLICT`.

Nessun push, nessun deploy, nessuna applicazione della migrazione, nessun cambio di
flag, nessun retry dell'ordine reale dell'owner.

## `MIGRATION_123_DIGEST_SCHEMA_QUALIFICATION_FIXED_LOCAL_AWAITING_FINAL_REVIEW`
