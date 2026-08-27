# Prerequisiti backend per Ajuste Comercial / Over-Collected — Frontend Slice C

**Data:** 2026-08-27 · **Ambiente:** SOLO STAGING · **Produzione:** CONGELATA
**Stato finale:** `BACKEND_PREREQUISITES_SLICE_IMPLEMENTED_AWAITING_DEPLOY`

Questo lavoro sblocca due pezzi che la sessione frontend precedente (commit locale
`bba3a31`, **non** deployato) aveva dovuto lasciare in sospeso perché il backend non
esponeva l'autorità necessaria.

---

## A. Baseline verificata (dal runtime, non assunta)

| Componente | Locale | Origin | Deploy `/version` |
|---|---|---|---|
| **Backend** `ladieci-messa-staging-backend` | `926ad0b` | `926ad0b` (0 avanti / 0 indietro) | `926ad0b` (branch `feature/staging-messa-tables-2026-08-01`, deploymentId `554c4ad0`) |
| **Frontend** `ladieci-messa-staging-frontend` | `bba3a31` (1 avanti) | `129a951` | `129a951` (`version.json`, deployId `6a8ee2ee…`) |

**Ledger DB (`ladieci_schema_migrations`):** `apply_order = 118`
(`2026-08-26_ajuste_comercial_v1_migration_118.sql`, verificato). Anche il tracking
migrazioni di Supabase è a `…_ajuste_comercial_v1_migration_118`.

Il commit frontend locale `bba3a31` contiene: riepilogo `overCollected` condiviso,
riga «Cobrado de más», KPI Economía, e un flusso **solo-client** «Cerrar igualmente».
Quest'ultimo **non è autoritativo** e non va deployato così com'è.

---

## B. Prerequisito A — la lacuna del reader (root cause esatta)

Il route HTTP dell'aggiustamento (`POST /sessions/:sessionId/adjustments` →
`mesa_post_commercial_adjustment_v1`) è **già vivo dal ledger 118**, ma:

* `src/tables/mesaDao.js` — la `SELECT` su `ordenes` (in `listFloorRows` **e**
  `listSessionAccountRows`) **non selezionava `order_uid`**;
* nessuna delle due letture leggeva mai `order_obligations`;
* `src/tables/mesaService.js` — `projectSessionAccount().commands[]` non esponeva né
  l'identità stabile né l'obbligazione canonica per ordine.

Risultato: il frontend non poteva sapere **quale `order_uid`** puntare, e `#NNN` (il
numero di visualizzazione riciclato) **non è identità economica** (metà dell'esposizione
Class B nasce proprio da collisioni di `#NNN`).

---

## C. Prerequisito A — contratto implementato (SOLO JS, nessuna migrazione)

### DAO (`src/tables/mesaDao.js`)

* Entrambi i reader ora selezionano `id,order_uid,…` da `ordenes`.
* Nuovo helper condiviso `listObligationsForOrders(orders)`: legge `order_obligations`
  scoping **per `order_uid IN (…)`** (chiave globalmente unica — mai `#NNN`, mai
  `service_session_id`). **SOLO LETTURA**: non materializza alcuna riga.
* Entrambi i reader restituiscono un nuovo campo `obligations`.
* `rpc()` ora espone `error.pgDetail` (il `DETAIL` di PostgREST) — usato solo per l'unico
  campo whitelisted del punto G.

### Proiezione (`src/tables/mesaService.js`)

`projectSessionAccount(session, { …, obligations = [] })` — additivo, tutti i chiamanti e
i test esistenti passano senza modifiche. Per ogni comanda:

```
commands[].orderUid                      // identità PERMANENTE, o null (Class B)
commands[].financial = {
  orderUid,
  originalObligation,   // gross della revisione 1, oppure la base legacy
  currentObligation,    // gross dell'ultima revisione, oppure la base legacy
  commercialAdjustment, // currentObligation - originalObligation  (<= 0)
  obligationRevision,   // numero dell'ultima revisione, oppure 0
  adjustable            // hint di sola lettura, da fatti a livello ordine
}
```

* **Con revisioni** → `original` = gross rev. 1, `current` = gross ultima revisione.
* **Senza revisioni** (bootstrap lazy non ancora scattato) → entrambe cadono sulla
  **stessa base legacy di `order_canonical_obligation_v1`**: `ordenes.totale`, azzerato
  per un ordine realmente cancellato. `obligationRevision = 0`.
* **Senza `order_uid`** (Class B) → **fail closed**: `adjustable = false`; anche i layer
  RPC/HTTP rifiutano un `orderUid` nullo in modo indipendente. Nessuna ipotesi da `#NNN`.
* `adjustable` **non** dipende dallo stato della sessione: come Refund V1,
  `mesa_post_commercial_adjustment_v1` accetta una mesa chiusa e non la riapre —
  chiusura e aggiustamento restano **disaccoppiati**.

---

## D. Mesa aperta / Mesa chiusa — proiezione unica dimostrata

`buildFloor` (floor aperto) e `buildClosedAccount` (Últimas Cuentas) chiamano **la stessa**
`projectSessionAccount`. Test `E2` prova `deepEqual` campo-per-campo di `financial` tra le
due letture sulle stesse righe. Leggere/aggiustare una mesa chiusa non la riapre
(`buildClosedAccount` legge lo `status` reale, il route è GET, nessuna RPC sotto).

---

## E. Prontezza per il frontend Ajuste

Sì. Dopo questo slice il frontend può, in modo sicuro:

1. rendere ogni comanda aggiustabile (`command.financial.adjustable`);
2. conoscere il suo `orderUid` stabile;
3. conoscere `currentObligation` e `originalObligation`;
4. inviare il nuovo lordo assoluto al route esistente `POST /sessions/:id/adjustments`;
5. ricaricare l'account canonico e mostrare i nuovi valori.

Il frontend **non** è stato toccato in questa sessione.

---

## F. Prerequisito B — la deficienza backend preesistente (root cause)

`mesa_close_session_v1` (ledger 118) **calcola già** `v_over_cents` e restituisce
`overCollected` nel payload, ma **fa gate solo su `unpaid`**: una mesa che ha incassato
**più** di quanto deve si chiudeva **in silenzio**, senza decisione dell'operatore e senza
alcuna registrazione dell'esposizione. Il frontend `bba3a31` aveva aggiunto un
`Volver` / `Cerrar igualmente` **solo lato client** → non autoritativo.

---

## G. Contratto di acknowledgement (parametro / errore / risposta)

### Parametro

`mesa_close_session_v1` guadagna un **quinto parametro**:
`p_confirm_over_collected boolean DEFAULT false`.

* Cambio di firma ⇒ **DROP + CREATE**, non `CREATE OR REPLACE`: aggiungere un parametro
  crea un secondo overload e lascerebbe il 4-arg **ancora invocabile** — un bypass
  silenzioso. Il 4-arg viene **eliminato**; il rollback lo ripristina byte-per-byte
  (md5 `c79312cd83db07cb0375f0cc5354d4f8`, catturato dal vivo).
* JS: `mesaDao.closeSession` → `p_confirm_over_collected: args.confirmOverCollected === true`;
  `mesaService.closeTable({ …, confirmOverCollected })` lo restringe a `=== true`;
  `mesaHttpHandlers` passa `req.body.confirmOverCollected` grezzo. **Mai** inferito da un
  retry, da una stringa «truthy» o da un campo mancante.
* Autorità: acknowledgment = **stessa autorità della chiusura** (`OPEN_ROLES`:
  admin/operator/owner/cashier/waiter/legacy_operator), **non** il potere admin-only
  dell'Ajuste Comercial manuale. Rider resta fuori.

### Errore

Prima richiesta di chiusura con `overCollected > 0` e nessun acknowledgment →

```
RAISE EXCEPTION 'MESA_CLOSE_OVER_COLLECTED'  (SQLSTATE 55000)
DETAIL = 'overCollected=<importo>'
```

`mesaHttpHandlers.safeError` classifica `MESA_CLOSE_OVER_COLLECTED` come **409** e inoltra
**solo** il numero `overCollected`, estratto dal `DETAIL` con regex stretta
(`/^overCollected=([0-9]+(?:\.[0-9]+)?)$/`). La stringa SQL grezza non viene **mai**
inoltrata; un `DETAIL` non conforme viene scartato. `MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED`
→ **500** (fail closed).

### Il blocco `unpaid` vince sempre

`unpaid` e `overCollected` sono mutuamente esclusivi per costruzione
(`GREATEST(0, total-paid)` vs `GREATEST(0, paid-total)`). Il gate
`MESA_TABLE_NOT_SETTLED` resta la **prima** condizione, incondizionata, **non** rilassata
dall'acknowledgment. Una post-condition della migrazione lo assevera (posizione + statement
letterale). `p_force` resta indipendente (solo completezza cucina/ordini).

### Risposta

Il payload di successo guadagna `overCollectedAcknowledged` e `incidentId`.

---

## H. Persistenza dell'incidente + idempotenza

**Nessun nuovo sistema di incidenti.** Alla chiusura acknowledged con `overCollected > 0`,
nella **stessa transazione** della chiusura, si registra un incidente tramite la RPC
**esistente** `create_service_incident`:

| Campo | Valore |
|---|---|
| `incident_type` | `OVER_COLLECTED_AT_CLOSE` |
| `category` / `severity` | `financial` / `warning` (stessa terna di `UNPAID_BALANCE_AT_CLOSE` in `v3IncidentPolicy.js`; `blocking` = false una volta acknowledged) |
| `financial_exposure_cents` | l'over-collection non risolta (`v_over_cents::integer`) |
| `entity_type` / `entity_id` / `table_session_id` | `table_session` / id sessione |
| `service_session_id` | `v_session.service_session_id` |
| `detected_by` | l'attore che chiude (attribuzione) |
| `resolution_status` | `pending` |
| `closeout_correlation_id` | `md5('mesa_close_over_collected:' || table_session_id)::uuid` — deterministico per sessione |

`create_service_incident` deriva da solo `business_date` / `service_kind` /
`lifecycle_semantics` dalla riga `service_sessions` e fa già **`ON CONFLICT DO NOTHING`**
sulla chiave `(closeout_correlation_id, incident_type, entity_type, entity_id)`.

**Idempotenza (provata staticamente + strutturalmente):**

* un retry dopo una chiusura acknowledged committata incontra il gate preesistente
  `MESA_SESSION_NOT_OPEN` **prima** di arrivare alla scrittura dell'incidente;
* il `SELECT … FOR UPDATE` su `table_sessions` serializza due richieste concorrenti — la
  seconda vede `status <> 'open'` e alza `MESA_SESSION_NOT_OPEN`;
* la dedupe `ON CONFLICT DO NOTHING` è il secondo strato → **mai un incidente duplicato**.

**Fail closed:** se `create_service_incident` non ritorna `ok:true`, si alza
`MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED` e la chiusura fa **rollback** — una chiusura
acknowledged non deve mai committare senza traccia dell'esposizione.

**Non accoppiato al refund:** una mesa chiusa non viene mai riaperta; un Refund V1
successivo può ridurre l'esposizione mentre la mesa resta chiusa. `SS27`: la chiusura
acknowledged **non** crea alcun payment / refund / allocation / revisione di obbligazione
(post-condition strutturale sul corpo della funzione).

---

## I. Autorizzazione

* **Ajuste Comercial manuale:** ADMIN/owner soltanto (`ADJUSTMENT_ROLES`, invariato dal
  ledger 118).
* **Acknowledgment over-collected alla chiusura Mesa:** stesso attore che può già chiudere
  quella Mesa (`OPEN_ROLES`). Capacità **separata**, deliberatamente non elevata.
* Rider resta fuori da qualunque cancellazione economica.

---

## J. Migration 119 — DDL / RPC esatti

**File:** `migrations/2026-08-27_mesa_close_over_collected_ack_migration_119.sql`
(+ `.ROLLBACK.sql`) · **Prossimo ledger atteso:** `apply_order = 119`
· **Riga narrativa manifest:** 121 (checksum `sha256(:16)` embeddato).

Contenuto (una sola transazione):

1. **Pre-condition guard** — rifiuta di girare se: il 4-arg `mesa_close_session_v1` non è
   presente con la firma ledger-118 esatta; il suo corpo `md5(prosrc)` ≠
   `c79312cd83db07cb0375f0cc5354d4f8`; il 5-arg esiste già (già applicata);
   `create_service_incident` / `service_incidents_dedupe_uq` / gli append-only trigger di
   `service_incidents` / `order_canonical_obligation_v1` mancano. Cattura gli md5 di 5
   funzioni che non devono cambiare + 3 conteggi di righe.
2. `DROP FUNCTION IF EXISTS public.mesa_close_session_v1(uuid, text, uuid, boolean);`
3. `CREATE FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean DEFAULT false, boolean DEFAULT false)` —
   corpo = **il corpo ledger-118 esatto** (`LANGUAGE plpgsql` / `SECURITY INVOKER` /
   `SET search_path = public, extensions, pg_temp` preservati) **+ 3 blocchi additivi**:
   `DECLARE v_incident jsonb;` · il gate `MESA_CLOSE_OVER_COLLECTED` subito dopo il gate
   `unpaid` · la scrittura dell'incidente subito **dopo** il blocco `p_force` e **prima**
   dell'`UPDATE table_sessions` (una chiusura bloccata non scrive nulla). `RETURN` +
   `overCollectedAcknowledged` / `incidentId`. Corpo **senza commenti** →
   `md5(prosrc)` deterministico = `1e4525aa3fc4e571f7df1acb3a6a59d4` (pin nella
   post-condition: drift di trascrizione = abort pulito).
4. `REVOKE ALL … FROM PUBLIC, anon, authenticated;` + `GRANT EXECUTE … TO service_role;`
5. **Post-condition** — firma 5-arg esatta; 4-arg sparito; esattamente un overload; md5 del
   corpo pinnato; marker presenti; `unpaid` precede `over-collected` ed è lo statement
   incondizionato letterale; nessun `INSERT` su tabelle di denaro/obbligazione, nessuna
   chiamata a writer di denaro; ACL anon/authenticated negato + service_role concesso;
   5 funzioni md5-invariate; trigger append-only di `service_incidents` intatti; conteggi
   `service_incidents` / sessioni chiuse / `auth_audit` invariati.

**Reader-only JS non richiede migrazione.**

---

## K. Sicurezza ACL — prova esplicita

Progetto Supabase con `pg_default_acl` che concede `EXECUTE` a `anon` **e** `authenticated`
direttamente su ogni funzione `public` appena creata (la lezione del ledger 118). Un
`CREATE` fresco (come questo) **riattiva** quella ACL di default.

Dry-run rollback-forced (vedi punto M): dopo il `CREATE` + il `REVOKE … FROM PUBLIC, anon,
authenticated` la post-condition ACL è **passata**:

* `has_function_privilege('anon', …, 'EXECUTE')` = **false**
* `has_function_privilege('authenticated', …, 'EXECUTE')` = **false**
* `has_function_privilege('service_role', …, 'EXECUTE')` = **true**

Il rollback ripristina la stessa postura pre-119 (`postgres` + `service_role` soltanto).

---

## L. Sicurezza di regressione

Nessuna semantica toccata al di fuori dell'aggiunta additiva:

* blocco chiusura `unpaid` — invariato, precede il nuovo gate, non rilassato;
* `p_force` / `CHIUSO_FORZATO` / completezza cucina — corpo byte-identico;
* `MESA_SESSION_NOT_OPEN` su retry — verbatim (ancora di idempotenza);
* Refund V1 closed-table / duplicate-payment / lifecycle servizio / lifecycle tavolo —
  nessuna modifica; 5 funzioni economiche md5-pinnate invariate nella migrazione;
* Economía / Caja — invariate (Caja resta su denaro fisico; l'acknowledgment
  over-collected e l'incidente non muovono cassa);
* `financial` + `orderUid` nel reader sono puramente additivi (test `G`: tutti i campi
  account/comanda preesistenti identici; chiamata senza `obligations` → shape valida).

---

## M. Risultati dei test

| Gate | Esito |
|---|---|
| Suite backend completa (`for f in tests/*.test.js`) | **290 / 291 file** — l'unico fallimento è il baseline preesistente e non correlato `getOrdenesArchivadosSesionAuthorizationParity.test.js` (fallisce identico su albero pulito; non tocca alcun file di questo slice). Prima dello slice: 288/289. |
| `tests/mesaOrderObligationReader.test.js` (NUOVO — matrice §11 A–H) | 12 / 12 |
| `tests/mesaCloseOverCollectedAcknowledgement.test.js` (NUOVO — wiring + testo migrazione + rollback) | 84 / 84 |
| `tests/mesaService.test.js` (aggiornato: 1 `deepEqual` + 2 nuovi test acknowledgment) | 49 / 49 |
| `tests/ajusteComercialV1.test.js` | 141 / 141 |
| `tests/overCollectedSliceA.test.js` · `mesaClosedAccountReader` · `serviceIncidents` · `v3IncidentPolicy` · `supabaseResourcePolicy` · `authorizationContract` · `migrationManifestOrder` · payment/refund/closeout/cashCount/lifecycle | tutti verdi |
| Domain-language guard (`npm run build`) | **OK** — 702 file, nessuna nuova occorrenza |
| **Migration 119 — dry-run rollback-forced (DDL + ACL + post-condition)** | **`MESA_119_DRYRUN_DDL_AND_POSTCONDITIONS_PASSED`** — tutte le post-condition passate; ACL anon/authenticated negato confermato dal vivo; residuo ZERO (4-arg ripristinato a md5 `c79312cd…`, ledger resta 118, `service_incidents`/sessioni-chiuse/`auth_audit` invariati). Il dry-run ha inoltre trovato **1 bug nella mia stessa post-condition** (slice del check di «entanglement» troppo ampio) — **corretto**; la logica della migrazione era corretta. |

**NON eseguite (rimandate all'autorizzazione, §35):** le 12 probe comportamentali
rollback-forced (§31 punti 1–12: chiusura ordinaria, `unpaid` bloccata, over-collected
bloccata senza ack, chiusura acknowledged, incidente esattamente una volta, nessun
refund/payment/adjustment, attribuzione attore, ACL anon/authenticated negato a runtime,
esecuzione trusted, retry idempotente, zero residuo). Richiedono righe fixture sintetiche
inserite e rollbackate = «rollback-isolated live smoke», che §35 colloca esplicitamente
dopo l'autorizzazione.

---

## N. Commit

Un commit locale sul branch `feature/staging-messa-tables-2026-08-01`:

```
fix(mesa): expose order_uid + canonical obligation in the account reader;
           add over-collected acknowledgement to the close path (Migration 119)
```

File: `src/tables/mesaDao.js`, `src/tables/mesaService.js`,
`src/tables/mesaHttpHandlers.js`, `tests/mesaService.test.js`,
`migrations/MIGRATION_MANIFEST.md` (modificati);
`migrations/2026-08-27_mesa_close_over_collected_ack_migration_119.sql` (+ `.ROLLBACK.sql`),
`tests/mesaOrderObligationReader.test.js`,
`tests/mesaCloseOverCollectedAcknowledgement.test.js` (nuovi).

---

## O. Stato di deploy

**NON pushato. NON deployato. Migration 119 NON applicata in modo permanente.**
Railway non toccato. Ledger DB resta **118**.

Dopo autorizzazione esplicita: push fast-forward → deploy Git-backed Railway → applicare
Migration 119 per via canonica → **prima le 12 probe comportamentali rollback-forced** →
apply permanente → verifica `/version`, ledger 119, ACL, zero cambi di dati operativi,
smoke rollback-isolato.

---

## P. Stato frontend

`bba3a31` **intatto**. Non modificato, non ribasato, non pushato, non deployato. La
prossima sessione frontend riconcilierà il suo lavoro locale contro questo contratto:
`command.financial.orderUid` + `currentObligation` + `originalObligation` per il form
Ajuste; `confirmOverCollected: true` (un solo booleano) per «Cerrar igualmente», con
`account.overCollected` (o il campo `overCollected` di `MESA_CLOSE_OVER_COLLECTED`) per il
messaggio.

---

## Q. Rimandato (fuori scope, invariato)

* **Class B** — propagazione `order_uid` su `table_order_lines` / redesign identità di
  `payment_allocations` / `#NNN` riciclati / righe ordine staccate / i 143,50 € storici /
  qualunque riparazione storica.
* **Ledger bridge** — la riga OFE mancante da 20 € (`mesa_post_payment_v1` `INSERT … SELECT`
  a zero righe).
* **Fiscal Core.**
* Il commit frontend locale `bba3a31` (lo riconcilia la prossima sessione FE).

---

**Stato finale: `BACKEND_PREREQUISITES_SLICE_IMPLEMENTED_AWAITING_DEPLOY`**
