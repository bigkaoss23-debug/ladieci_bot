# PENDENCIAS ECONÓMICAS — AUDIT ARCHITETTURA

**Data:** 2026-08-28
**Tipo:** SOLA LETTURA. Zero scritture su staging. Zero migrazioni. Zero deploy. Zero commit di codice.
**Baseline verificata:** BE `398a680` / FE `e7aa69a` / DB ledger **119** (`ladieci_schema_migrations`, `applied_by=398a680`, `verified`)
**Repo backend reale:** `ladieci-messa-staging-backend` (branch `feature/staging-messa-tables-2026-08-01`)
**Repo frontend reale:** `ladieci-messa-staging-frontend/ladieci-app33` (stesso branch)
**DB:** Supabase staging `tdikhfeinufaahagmpjz`

Tutte le cifre in questo documento provengono da **query di sola lettura sul DB staging reale** e dalla lettura del `prosrc` vivo delle funzioni, non da assunzioni o da report precedenti.

---

## 0. SINTESI IN DIECI RIGHE

1. **POR COBRAR e POR DEVOLVER esistono già**, calcolati per ordine, dentro `safeTicket()`. Si chiamano `unpaidAmount` e `overCollectedAmount`.
2. **NON serve una nuova tabella.** Nessuna `pending_debts`, nessuna `economic_pendencies`.
3. Manca **un reader**: una proiezione cross-servizio, senza finestra temporale, che elenchi le esposizioni ancora aperte.
4. **POR DEVOLVER dopo la chiusura funziona già davvero** — provato su righe vive: `mesa_post_refund_v1` accetta di proposito una Mesa chiusa e attribuisce il movimento al servizio di OGGI.
5. **POR COBRAR dopo la chiusura è strutturalmente impossibile oggi.** Entrambi i writer di incasso rifiutano. È l'unico vero gap implementativo.
6. L'attribuzione "vendita ieri / soldi oggi" **è già implementata e già provata** (doppia timbratura `obligation_*` / `event_*`).
7. L'incidente `OVER_COLLECTED_AT_CLOSE` è a grana **table_session**, la pendenza è a grana **order_uid**: l'incidente non può essere source of truth.
8. **BUG A (Devuelto = 0) è root-caused**: il backend pubblica già il numero giusto, il frontend legge il campo sbagliato. Fix di una riga, lato FE.
9. **Le Mesa non hanno cliente.** `nombre='Mesa 6'`, `tel='MESA-98794C63'`. La ricerca per nome cliente funziona solo su Domicilio/Manual.
10. **Class B misurata: 12 eventi, 210,00 €.** Da nascondere fail-closed, mai indovinare.

---

## A. CURRENT ECONOMIC SOURCES OF TRUTH

### A.1 La mappa autoritativa

| Concetto | Authority reale | Dove |
|---|---|---|
| **Vendita originale** | `order_obligations` revision **1** → `gross_amount` | tabella; letto da `projectOrderFinancial()` |
| *fallback pre-N-2* | `ordenes.totale` (solo se l'ordine non ha nessuna revision) | `safeTicket()` — precedenza esclusiva, mai entrambi |
| **Obligation corrente** | `order_obligations` **MAX(revision)** → `gross_amount` | RPC `order_canonical_obligation_v1(p_order_uid uuid)` |
| **Payments** | `order_financial_events` WHERE `type IN ('payment','payment_imported')` | **ledger universale** — tutti i canali |
| *sotto-ledger Mesa* | `payment_transactions` WHERE `kind='payment'` + `payment_allocations` | **solo Mesa** (`table_session_id` è NOT NULL) |
| **Refunds** | `order_financial_events` WHERE `type='refund'` | universale |
| *sotto-ledger Mesa* | `payment_transactions` WHERE `kind='refund'` + `reverses_transaction_id` | solo Mesa |
| **netCollected** | `payments − refunds` | `currentServiceCloseout.js:113` |
| **unpaid** | `max(0, currentObligation − netCollected)` | `currentServiceCloseout.js:117` |
| **overCollected** | `max(0, netCollected − currentObligation)` | `currentServiceCloseout.js:120` |
| **order_uid** | `ordenes.order_uid` — **59/59 popolati, 0 NULL** | identità permanente |

### A.2 Il reader canonico è UNO SOLO

```js
// src/closeout/currentServiceCloseout.js:73  — safeTicket(order, events, session, obligation)
const netCollected        = round(grossCollected - refundedAmount);
const currentObligation   = voided ? 0 : amount;
const unpaidAmount        = Math.max(0, round(currentObligation - netCollected));   // ← POR COBRAR
const overCollectedAmount = Math.max(0, round(netCollected - currentObligation));   // ← POR DEVOLVER
```

**Questa funzione è già `porCobrar` / `porDevolver`.** Le equazioni concettuali del brief non sono un'ipotesi da implementare: sono il codice deployato, con in più la precedenza N-2 sull'obbligazione e la regola legacy-fallback.

`safeTicket` è importato da: `currentServiceCloseout.js` (chiusura live), `economiaLedgerAggregate.js` (Economía storica), `economicSnapshot.js` (finestra temporale), `servizio.js` (archiviazione). **Un'unica implementazione contabile, quattro scope.**

### A.3 Ciò che NON è authority — non usarlo mai

| Campo | Perché no |
|---|---|
| `ordenes.cobrado` / `ya_pagado` / `metodo_pago` | proiezioni ricalcolate dai writer; `metodo_pago` resta vuoto mentre l'ordine è parzialmente pagato |
| `ordenes.refunded` | semantica legacy "rimborsato per intero"; `mesa_post_refund_v1` non lo scrive di proposito |
| `ordenes.estado` | stato operativo, non economico. Migrazione 118 lo ha esplicitamente tolto dall'autorità economica |
| `table_order_lines` sommate | la visibilità delle righe cambia (un ordine cancel-like perde le righe) mentre i pagamenti restano |
| `account.total` / `account.outstanding` di sessione | **ancora line-based** → vedi `SESSION_AGGREGATE_CANONICALIZATION_DEBT`, §Q |

### A.4 Due ledger e un ponte — il fatto strutturale più importante

```
                       order_financial_events            ← LEDGER UNIVERSALE (tutti i canali)
                       (order_id TEXT = #NNN display)       Economía, closeout, cash count leggono SOLO qui
                                 ▲
                  ┌──────────────┴──────────────┐
   mesa_post_payment_v1 /                  _ledger_write_payment
   mesa_post_refund_v1                     (Retiro / Domicilio / Banco / Teléfono)
          │                                        │
          ▼                                        ▼
   payment_transactions                     (nessuna transazione)
   payment_allocations
   ── SOLO MESA: table_session_id NOT NULL ──
```

**Conseguenza diretta per Pendientes:** un ordine non-Mesa **non ha nessuna `payment_transactions` row**, quindi non ha nessun target rimborsabile per `mesa_post_refund_v1`. Misurato: **6 eventi / 150,50 €** di denaro non-Mesa su ordini identificabili. Vedi §G.

---

## B. CAN PENDENCIAS BE DERIVED?

# ✅ **YES** — con un contorno HYBRID sottile e ben delimitato

**YES sulla verità economica.** Direzione e importo sono derivati al 100% da:
`order_obligations` (MAX revision) + `order_financial_events` (payments − refunds), scopati con la coppia composita N-6 `(order_id, service_session_id)`.

**Prova eseguita in sola lettura sullo staging vero.** La query completa (in appendice §APP-1) ha prodotto **8 righe**, fra cui:

| display | order_uid | obligation | paid | refunded | netCollected | **porCobrar** | **porDevolver** |
|---|---|---|---|---|---|---|---|
| `#999034` | `68a3c44f…` | 60,00 | 85,00 | 15,00 | 70,00 | 0 | **10,00** |

**È esattamente lo specimen UAT del brief**, ricostruito da zero senza nessuna entità nuova. E coincide al centesimo con l'incidente `OVER_COLLECTED_AT_CLOSE` da 1000 cents scritto alla chiusura.

**HYBRID solo su tre cose, che NON sono la verità economica:**

| Elemento | Perché non è derivabile | Dove vive già |
|---|---|---|
| **Age / stato "vecchia"** | serve un `now()` — è una funzione del tempo, non del ledger | calcolato a read-time |
| **Traccia della chiusura** | "questa mesa ha chiuso con un'esposizione" è un fatto storico | `service_incidents` (già esiste) |
| **Riconciliazione dell'incidente** | "questa esposizione è stata sanata" | `service_incident_resolutions` (già esiste) |

**Verdetto: projection canonica + metadata di provenance già esistenti. NESSUNA nuova tabella.**

---

## C. CANONICAL PENDING MODEL

```jsonc
{
  "direction":            "POR_COBRAR" | "POR_DEVOLVER",   // derivata, mai persistita
  "orderUid":             "68a3c44f-e677-4d0a-8d9b-e090dd89e4b2",  // TARGET ECONOMICO — ordenes.order_uid
  "amount":               10.00,                            // unpaidAmount | overCollectedAmount
  "currentObligation":    60.00,                            // order_obligations MAX(revision).gross_amount
  "originalObligation":   85.00,                            // revision 1 — per capire se c'è stata correzione
  "netCollected":         70.00,                            // payments − refunds
  "obligationRevision":   3,

  "originalDate":         "2026-08-25T19:30:27Z",           // ordenes.created_at — LA VENDITA
  "lastMovementAt":       "2026-08-28T06:24:47Z",           // MAX(order_financial_events.created_at)
  "ageDays":              3,                                // now() − originalDate

  "channel":              "MESA",                           // MESA | RETIRO | DOMICILIO | BANCO
  "display": {
    "orderNumber":        "#999034",                        // SOLO display, MAI identità
    "tableNumber":        6,
    "tableName":          "Mesa 6",
    "commandNumber":      1,
    "serviceOrderNumber":  4
  },
  "customer": {                                             // null-safe: MAI inventato
    "name":               null,                             // "Mesa 6" NON è un cliente → null
    "phone":              null                              // "MESA-98794C63" NON è un telefono → null
  },

  "provenance": {
    "tableSessionId":     "98794c63-…",                     // null per non-Mesa
    "tableSessionStatus": "closed",
    "serviceSessionId":   "42af1de9-…",                     // il servizio della VENDITA
    "serviceStatus":      "open",
    "businessDate":       "2026-08-25"
  },

  "resolution": {
    "state":              "OPEN",                           // OPEN | PARTIALLY_RESOLVED | RESOLVED
    "refundableTransactions": [                             // SOLO per POR_DEVOLVER
      { "transactionId": "9fc820c1-…", "method": "efectivo",
        "originalAmount": 85.00, "refundableRemaining": 70.00,
        "createdAt": "2026-08-28T06:17:52Z", "spansOrders": ["#999034"] }
    ],
    "relatedIncidentId":  "806cc91f-…"                      // audit anchor, NON authority
  },

  "allowedActions":       ["REFUND"],                       // calcolate dal backend, mai dal FE
  "identityConfidence":   "STABLE"                          // STABLE | UNRESOLVED (Class B)
}
```

**Regole non negoziabili del modello:**
- `orderUid` è **l'unico** target economico. `#NNN` è display, è riciclato, non è identità (dimostrato da N-6: `#001` avrebbe rimborsato 10,00 € di una sessione estranea invece dei suoi 16,00 €).
- `customer.name` è `null` quando è un marcatore sintetico Mesa. **Mai spacciare "Mesa 6" per un cliente.**
- `allowedActions` è calcolato dal backend a partire da ruolo + canale + presenza di transazioni rimborsabili. Il FE non deve dedurlo.

---

## D. ELIGIBILITY RULE — quando entra in Pendientes

### D.1 Il problema, misurato

La regola di solo saldo produce **8 righe**, ma **5 sono rumore operativo**:

| display | estado | porCobrar | Verdetto |
|---|---|---|---|
| `#999033` | `LISTO` | 17,00 | ❌ ordine attivo, non consegnato — flusso normale |
| `#999032` | `EN_ENTREGA` | 15,00 | ❌ il rider è in strada |
| `#999024` `#999023` `#999008` | `POR_CONFIRMAR` | 47,00 | ❌ bozze mai confermate |
| `#379` | `CHIUSO_FORZATO`, 0 incassato | 27,50 | ⚠️ artefatto: zero denaro mai mosso |
| `#999001` | `CHIUSO_FORZATO`, 50 su 100 | 50,00 | ✅ **vera esposizione** |
| `#999034` | `RETIRADO` | — / **10,00 devolver** | ✅ **vera esposizione** |

Il brief lo aveva anticipato: *"un ordine attivo si gestisce nella normale UI operativa"*. I dati lo confermano quantitativamente.

### D.2 Regola canonica proposta

Una pendenza entra in **Pendientes** quando **TUTTE** valgono:

```
(1) amount > 0                              — esposizione economica reale
(2) identityConfidence == 'STABLE'          — order_uid presente + coppia (order_id, service_session_id)
                                              risolve a esattamente 1 riga ordenes
(3) LA FASE OPERATIVA È FINITA:
      MESA:      table_sessions.status != 'open'
      NON-MESA:  estado ∈ stati terminali {RETIRADO, COMPLETADO, ENTREGADO, CHIUSO_FORZATO,
                                           CANCELADO, ANULADO}
                 OPPURE il servizio della vendita è chiuso
(4) ESCLUSIONE ANTI-ARTEFATTO:
      cancel-like (CANCELADO/ANULADO/CHIUSO_FORZATO) CON netCollected == 0 → NON è pendenza
      (nessun denaro si è mai mosso; è residuo di stato, non un debito)
```

Applicando (1)–(4) alle righe vive: **restano esattamente 2 pendenze reali** — `#999001` (50,00 POR COBRAR) e `#999034` (10,00 POR DEVOLVER). Che è la risposta corretta.

### D.3 Matrice dei casi richiesti dal brief

| Caso | In Pendientes? | Motivo |
|---|---|---|
| Mesa **aperta**, saldo aperto | ❌ NO | è il Payment Hub, superficie operativa normale |
| Mesa **chiusa**, POR DEVOLVER | ✅ SÌ | fase operativa finita, esposizione sopravvive |
| Mesa **chiusa**, POR COBRAR | ✅ SÌ | raggiungibile **solo dopo un refund** (vedi §I.2) |
| Servizio aperto | ✅ SÌ se (3) vale | il servizio non è il confine — è l'ordine/mesa che lo è |
| Servizio chiuso | ✅ SÌ | irrilevante per l'eleggibilità |
| Ordine **cancellato** con denaro incassato | ✅ SÌ, come POR DEVOLVER | obligation → 0, netCollected resta → over-collected reale |
| Ordine **cancellato** senza denaro | ❌ NO | regola (4) |
| Obligation **corretta** | ✅ ricalcolo automatico | la revision MAX entra subito nella proiezione |
| Pagamento parziale successivo | ✅ ricalcolo automatico | l'evento entra in netCollected |
| Pagamento il giorno dopo | ✅ ricalcolo automatico | nessuna finestra temporale nel reader |
| Refund successivo | ✅ ricalcolo automatico | può creare una POR COBRAR su mesa chiusa |

---

## E. RESOLUTION RULE — quando sparisce

**Derivazione dinamica pura. Nessun nuovo money state, nessun flag.**

```
POR COBRAR risolta   ⇔  currentObligation ≤ netCollected
POR DEVOLVER risolta ⇔  netCollected      ≤ currentObligation
```

Le due sono complementari **della stessa differenza non clampata** (regola congelata dell'over-collected audit §2): non possono essere entrambe zero per costruzione di un clamp, e non possono essere entrambe positive.

**Il basta-derivarlo è verificato:** ogni evento che può cambiare l'equilibrio è **append-only con trigger DB attivi** su tutte e cinque le tabelle monetarie (`payment_transactions`, `payment_allocations`, `order_financial_events`, `order_obligations`, e i loro guard). Non esiste UPDATE/DELETE che possa far divergere una proiezione da una copia persistita. **Una tabella persistita sarebbe una seconda verità capace di sbagliare; la derivazione no.**

`resolution.state` a tre valori è **etichettatura**, non stato:

| state | Condizione |
|---|---|
| `OPEN` | `amount > 0` e nessun movimento successivo alla nascita dell'esposizione |
| `PARTIALLY_RESOLVED` | `amount > 0` **e** esiste ≥1 movimento dopo l'ultimo cambio di obbligazione |
| `RESOLVED` | `amount == 0` → **la riga esce dalla lista**, non viene marcata |

### Sopravvivenza richiesta — verificata

| Evento | Sopravvive? | Perché |
|---|---|---|
| Chiusura Mesa | ✅ | `mesa_close_session_v1` non tocca nessuna tabella monetaria (post-condition SS27 della migrazione 119) |
| Chiusura servizio | ✅ | `serviceLifecycleEngine` scrive incidenti, non muta il ledger |
| Cambio business day | ✅ | il reader non ha finestra temporale |
| Restart app | ✅ | nulla è in memoria |

---

## F. NEXT-DAY POR COBRAR — 🔴 **GAP DURO, NESSUN WRITER ESISTENTE**

### F.1 Entrambe le strade sono chiuse. Verificato sul `prosrc` vivo.

**Strada 1 — `mesa_post_payment_v1` (Mesa):**
```sql
SELECT * INTO v_session FROM public.table_sessions
 WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
IF v_session.covers_total IS NULL THEN RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000'; END IF;
```
→ **Rifiuta ogni Mesa chiusa.** Non c'è `p_force` su questo ramo.

**Strada 2 — `_ledger_write_payment` (Retiro / Domicilio / Banco / Teléfono):**
```sql
SELECT * INTO v_existing_basis FROM public.order_financial_events
  WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
    AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
  ORDER BY created_at ASC LIMIT 1;
IF FOUND THEN RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023'; END IF;
```
→ **Esattamente UN pagamento per (ordine, sessione).** Inoltre l'importo è derivato server-side come `round(v_ord.totale, 2)` — **sempre il totale intero**, mai un saldo parziale. Enforced anche a livello DB da `order_financial_events_one_payment_session_uq`.

Verificato inoltre: `_ledger_write_payment` **non scrive** `event_service_session_id` (`false`) e **non legge** `service_session_state` (`false`) — non ha alcuna nozione di "servizio di oggi".

### F.2 Conseguenza esatta

> **Non esiste, in nessun punto del sistema, un writer capace di incassare un saldo su una Mesa chiusa o un secondo pagamento su un ordine non-Mesa.** Lo scenario centrale del brief — *«giorno 2: il cassiere trova la pendenza e incassa i 10 €»* — oggi fallisce con `MESA_SESSION_NOT_OPEN` oppure `AUTH_BASIS_EXISTS`.

### F.3 MINIMO backend change necessario

Un **nuovo writer** `mesa_post_late_collection_v1` (o `order_post_late_collection_v1` per coprire anche il non-Mesa), modellato **verbatim** su `mesa_post_refund_v1` — che è già la prova che questa forma funziona:

| Requisito | Come | Precedente da copiare |
|---|---|---|
| Accetta Mesa chiusa | nessun gate su `status` | `mesa_post_refund_v1` lo fa già |
| Non riapre nulla | mai `UPDATE table_sessions` / `service_sessions` | post-condition strutturale, come SS27 |
| Vendita resta al giorno originale | `service_session_id := v_ord.service_session_id` | trigger `service_session_assign_financial_event`, già così |
| Denaro attribuito a oggi | `event_service_session_id := v_receipt_service_id` (servizio aperto corrente) | `mesa_post_refund_v1` riga 285-289 |
| Importo parziale ammesso | `p_amount`, cappato a `unpaidAmount` | stessa forma di `p_amount` del refund |
| Nessuna nuova vendita | mai INSERT in `order_obligations` / `ordenes` | il refund non lo fa già |
| Pagamenti multipli permessi | **richiede di modificare `order_financial_events_one_payment_session_uq`** | ⚠️ vedi sotto |

⚠️ **La modifica dell'indice è l'unico punto delicato, ed è già stata fatta una volta con successo.** L'indice payment è già parziale `WHERE payment_transaction_id IS NULL` — esattamente l'esclusione che permette a Mesa di scrivere più pagamenti per ordine. Se il nuovo writer scrive una `payment_transactions` row (come Mesa), **l'indice non va toccato affatto**. La migrazione 117 ha applicato lo stesso ragionamento ai due indici refund, con 25/25 probe rollback-forced verdi.

**Raccomandazione: il late-collection writer scrive una `payment_transactions` row anche per il non-Mesa.** Questo richiede di rendere `payment_transactions.table_session_id` nullable — **questa sì è una vera modifica di schema.** L'alternativa (scrivere solo `order_financial_events`) evita la modifica di colonna ma lascia il pagamento tardivo non rimborsabile, ricreando lo stesso gap sull'altro lato.

---

## G. NEXT-DAY POR DEVOLVER — 🟢 **FUNZIONA per Mesa** / 🟠 **GAP per non-Mesa**

### G.1 Mesa: già pronto, e già provato su righe vive

`mesa_post_refund_v1` (migrazione 117, ledger 117):

```sql
-- Closed tables are accepted deliberately (§J.2 of the contract): a refund never
-- reopens a table session, never touches status/settled_at/closed_at.
SELECT * INTO v_session FROM public.table_sessions
 WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
-- ⟵ NESSUN gate su status. Deliberato.
```

E l'attribuzione temporale:
```sql
SELECT ss.id INTO v_receipt_service_id
  FROM public.service_session_state sst
  JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
 WHERE sst.singleton = true;
...
INSERT INTO public.order_financial_events(... service_session_id, event_service_session_id ...)
SELECT ..., v_session.service_session_id, v_receipt_service_id, ...
```

**Vendita → servizio originale. Denaro → servizio di oggi.** Esattamente il requisito §12 del brief, già scritto.

**Prova viva** (evento `6a9dbad2-…`, refund 15,00 €):
| campo | valore |
|---|---|
| `obligation_economic_period_kind` | **SERA** (la vendita del 25/08) |
| `event_economic_period_kind` | **PRANZO** (il rimborso del 28/08) |
| `service_session_id` | `42af1de9` (servizio della vendita) |
| `table_sessions.status` al momento | `closed`, `closed_at` mai toccato |

Copertura confermata: Mesa chiusa ✅ · servizio vecchio ✅ · pagamento di giorni prima ✅ · refund parziale ✅ (cap `PT.amount − Σ refund contro PT`) · più pagamenti ✅ (target per transazione) · tender misti ✅ (metodo forzato dall'originale).

### G.2 Gap 1 — il denaro non-Mesa non ha nessuna transazione da rimborsare

| Popolazione | Eventi | € |
|---|---|---|
| Transaction-backed + identità stabile (Mesa sana) | 51 | 993,01 |
| Transaction-backed + identità orfana (Class B) | 6 | 123,50 |
| **Non-transaction-backed + identità stabile (non-Mesa)** | **6** | **150,50** |
| Non-transaction-backed + identità orfana (Class B) | 6 | 86,50 |

Le **6 righe / 150,50 €** non-Mesa non hanno `payment_transaction_id` → `mesa_post_refund_v1` non ha nulla da nominare. L'unico percorso è il legacy `order_refund`, che:
- **non ha parametro importo** (rimborsa il primo evento pagamento intero),
- consente **un solo refund** per (ordine, sessione),
- è **admin-only**,
- ed è ora contenuto: rifiuta con `AUTH_REFUND_TRANSACTION_BACKED` su ordini transaction-backed.

**Gap preciso:** o `mesa_post_refund_v1` viene generalizzato per accettare come target un `order_financial_events.id` quando non esiste transazione, oppure il late-collection writer di §F crea transazioni anche per il non-Mesa e il problema si chiude da entrambi i lati con un solo pezzo di lavoro. **Raccomando la seconda.**

### G.3 Gap 2 — `v_receipt_service_id` senza guardia (P2)

```sql
SELECT ss.id INTO v_receipt_service_id FROM ... WHERE sst.singleton = true;
-- nessun IF NOT FOUND
```
Se **nessun servizio è aperto** (rimborso alle 05:00, fra un Finalizar e la prima attività), `event_service_session_id` diventa **NULL silenziosamente**.

**Impatto onesto — non è perdita di denaro:** `economicSnapshot` finestra sul `created_at` e la timbratura `event_economic_period_kind` è scritta incondizionatamente dal trigger, quindi il refund resta contato. **Si perde la provenance receipt-side**, non l'importo. Classificato **P2**, non bloccante.

*(Nota: la stessa forma senza guardia esiste anche in `mesa_post_payment_v1`, dove è meno raggiungibile perché richiede una Mesa aperta.)*

### G.4 UX sicura con più transazioni originarie — il punto critico

> **`overCollected = 10` NON significa "rimborsa 10 qualsiasi".**

Il refund è **transaction-centric per progetto**, e c'è una ragione dura provata dall'audit precedente: il writer SQL somma **tutte** le allocazioni, mentre `normalizeLinesBySession` (JS) somma solo le righe di ordini non cancellati — **268,01 € di divergenza SQL-vs-JS su 9 sessioni**, invisibile perché entrambi i lati clampano con `GREATEST(0,·)`. Una base "per sessione" consulterebbe proprio quel numero.

C'è anche una complicazione di grana provata dal vivo: la transazione `7c9bc24a` (35,00 € efectivo) ha generato **tre** `order_financial_events` — `#999026` 6,50 + `#999028` 24,50 + `#999027` 4,00. **Una transazione può coprire più ordini.**

**UX proposta:**
1. La pendenza mostra l'importo dovuto: `POR DEVOLVER 10,00 €`.
2. Il backend elenca `refundableTransactions[]` — id, metodo, importo originale, **residuo rimborsabile**, data, e **quali ordini quella transazione tocca**.
3. **Una sola transazione** → preselezionata, l'operatore conferma. Un tap.
4. **Più transazioni** → l'operatore **deve scegliere**, con il metodo di ciascuna reso esplicito ("Efectivo · 85,00 € · residuo 70,00 € · 25/08 21:32").
5. Se la transazione scelta ne tocca altre di ordini, avviso esplicito: *«questa transazione copre anche #999027, #999028»*.
6. **Mai un pulsante "rimborsa l'over-collected"** che scelga da solo.

---

## H. AUTHORIZATION MODEL

### H.1 Architettura auth reale — attenzione, c'è una trappola

| Layer | Stato | Chi decide |
|---|---|---|
| `capabilityRegistry.js` / `actionPolicyRegistry.js` | **V3-A: "FOUNDATION ONLY, UNWIRED"** | ❌ nessun request path lo consulta |
| `legacyActionRoles.js` | **LIVE** | azioni di `index.js` |
| `mesaService.js` — `requireContext(ctx, ROLE_SET)` | **LIVE** | ✅ tutte le rotte `/api/mesa/v1` |
| `economyHttpHandlers.js` — `READ_ROLES` / `COUNT_ROLES` | **LIVE** | ✅ `/api/economy/v1` |
| Funzioni DB — `v_actor.role NOT IN (...)` | **LIVE, autorità finale** | ✅ ogni RPC monetaria |

> ⚠️ **`MANAGE_ECONOMIC_PENDENCIES` non può essere implementata come capability oggi**: il registro capability non è cablato. Va implementata **come Set di ruoli** nello stile di casa, con l'entry parallela nel `capabilityRegistry` per il futuro cutover V3-D.

### H.2 Set di ruoli live oggi

```js
// src/tables/mesaService.js:24-42
PAYMENT_ROLES    = {admin, operator, owner, cashier, legacy_operator}
REFUND_ROLES     = {admin, owner}        // cashier ESCLUSO — segregation of duties
ADJUSTMENT_ROLES = {admin, owner}
```
E nel DB: `mesa_post_refund_v1` → `IF v_actor.role NOT IN ('admin','owner') THEN ...`

### H.3 ⚠️ Conflitto reale fra prodotto e sicurezza

Il brief chiede: **cassiere = A + B + C** (leggere, incassare, rimborsare).
Il sistema oggi dice: **`cashier` NON può rimborsare**, e questo è scritto in due punti indipendenti (JS + DB) come decisione esplicita di segregazione dei compiti.

**Non è un bug — è una scelta congelata.** Ribaltarla richiede:
1. modificare `REFUND_ROLES` in `mesaService.js`, **e**
2. una **migrazione** che riscriva il gate dentro `mesa_post_refund_v1`.

### H.4 Modello minimo corretto proposto

| | A · Leggere Pendientes | B · Incassar POR COBRAR | C · Reembolsar POR DEVOLVER | D · Corregir importe |
|---|---|---|---|---|
| `owner` | ✅ | ✅ | ✅ | ✅ |
| `admin` | ✅ | ✅ | ✅ | ✅ |
| `cashier` | ✅ | ✅ | ⚠️ **decisione del proprietario** | ❌ |
| `operator` | ✅ | ✅ | ❌ | ❌ |
| `waiter` | ❌ | ❌ | ❌ | ❌ |
| `kitchen` / `rider` | ❌ | ❌ | ❌ | ❌ |

```js
PENDENCY_READ_ROLES    = PAYMENT_ROLES              // riuso: identico a chi già legge Economía
PENDENCY_COLLECT_ROLES = PAYMENT_ROLES              // riuso: incassare è incassare
PENDENCY_REFUND_ROLES  = REFUND_ROLES               // riuso: nessuna nuova autorità di rimborso
                                                    // (se il proprietario decide diversamente:
                                                    //  richiede migrazione — vedi H.3)
ADJUSTMENT_ROLES       = {admin, owner}             // INVARIATO
```

**Punto centrale rispettato:** `waiter` **non compare mai**. Non si concede controllo generale sulle Mesa chiuse — si concede **una capacità economica separata e nominata**, esattamente come chiede il brief. E le tre azioni non riaprono nulla: nessuna di esse tocca `table_sessions.status`, `service_sessions.status`, `ordenes.estado` o le vendite storiche.

---

## I. CLOSED MESA / CLOSED SERVICE INVARIANTS

### I.1 Invarianti confermati sul codice vivo

| Invariante | Stato | Prova |
|---|---|---|
| Una Mesa chiusa resta chiusa | ✅ garantito | nessun writer economico scrive `status`/`closed_at`/`settled_at` |
| `mesa_post_refund_v1` non riapre | ✅ | commento esplicito + zero UPDATE su `table_sessions` |
| `mesa_post_commercial_adjustment_v1` non riapre | ✅ | `prosrc` non nomina mai `status` |
| Chiusura non muta il ledger | ✅ | post-condition SS27 della migrazione 119: il corpo di `mesa_close_session_v1` non contiene INSERT verso le 4 tabelle monetarie |
| Le vendite storiche non si riscrivono | ✅ | `order_obligations` append-only; `ordenes_service_session_immutable`; `paid_order_economic_mutation_guard_v1` |

### I.2 Il gate di chiusura, e la conseguenza sorprendente

```sql
v_unpaid_cents := GREATEST(0, v_total_cents - v_paid_cents);
v_over_cents   := GREATEST(0, v_paid_cents - v_total_cents);
IF v_unpaid_cents > 0 THEN RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000'; END IF;
IF v_over_cents > 0 AND NOT COALESCE(p_confirm_over_collected, false) THEN
  RAISE EXCEPTION 'MESA_CLOSE_OVER_COLLECTED' USING ERRCODE='55000',
    DETAIL = format('overCollected=%s', v_over_cents / 100.0);
END IF;
```

**Una Mesa non può chiudere con POR COBRAR aperto.** Il gate `MESA_TABLE_NOT_SETTLED` è incondizionato (nessun `p_force` su questo ramo).

**Quindi come nasce una POR COBRAR su Mesa chiusa?** Due sole strade:
1. **Un refund su Mesa chiusa.** Il rimborso restituisce denaro e l'importo **torna dovuto** (regola congelata Refund V1). Rimborsare 20 su una Mesa saldata chiusa crea una POR COBRAR da 20.
2. **Non è la correzione d'importo.** `mesa_post_commercial_adjustment_v1` è **reduction-only** (`MESA_ADJUSTMENT_EXCEEDS_OBLIGATION`) — può creare POR DEVOLVER, **mai** POR COBRAR.

**Corollario operativo:** POR COBRAR su Mesa è raro; POR COBRAR sui canali **non-Mesa** (Domicilio/Retiro, che non hanno alcun gate di chiusura) è il caso reale e frequente. Il writer di §F deve coprire **soprattutto il non-Mesa**.

---

## J. DATE / SERVICE ATTRIBUTION

### J.1 La macchina esiste già ed è a doppia timbratura

`service_session_assign_financial_event` (trigger BEFORE INSERT su `order_financial_events`):
```sql
NEW.service_session_id := v_session_id;                                        -- ← dall'ORDINE
NEW.obligation_economic_period_kind := classify_economic_period_v1(v_order_created_at);  -- ← VENDITA
NEW.event_economic_period_kind      := classify_economic_period_v1(clock_timestamp());   -- ← OGGI
```

| Concetto | Colonna | Semantica |
|---|---|---|
| **SALE** | `service_session_id` + `obligation_economic_period_kind` | giorno/periodo originale — **mai riscritto** |
| **PAYMENT/REFUND tardivo** | `event_service_session_id` + `event_economic_period_kind` | giorno/periodo di esecuzione |
| **PENDING EXPOSURE** | *nessuna colonna* | stato corrente, derivato |

### J.2 `economicSnapshot` supporta già questo — non serve un reader change per §12

`economicWindow.js` è già **timestamp-based, non service-based**:
> *"service_session_id is never the window here. It is available as an OPTIONAL provenance filter, never as the authority."*

E `economicSnapshot.js:370-373` legge già `event_service_session_id` per l'era receipt-side. Le due popolazioni sono già separate e già dichiarate nell'output:
- `obligation.{gross, unpaid, voided, refunded}` → **obbligazioni NATE nella finestra**
- `receipts.{collected, collectedGross, refunded, byMethod, byMethodGross, byMethodRefunds}` → **denaro MOSSO nella finestra**
- `windowCrossing.obligationBeforeWindowReceiptInside` → **esiste già un campo dedicato al caso "vendita ieri, incasso oggi"**

**Verdetto §12: nessun reader change necessario.** Serve solo che il late-collection writer scriva `event_service_session_id`, come fa già il refund.

### J.3 Quale data mostrare all'operatore

**Modello più semplice utile:**
- **riga primaria:** `originalDate` — *"25 ago · 21:30"* — è ciò che il cliente ricorda
- **riga secondaria, solo se diversa:** `lastMovementAt` — *"último movimiento: hoy 08:24"*
- **badge, solo oltre soglia:** `ageDays` — *"3 días"*

Non mostrare mai tre date insieme. Nel caso del brief (ordine ieri, pagamento parziale oggi, saldo pendente): si mostra **la data dell'ordine** come identità e *"pago parcial hoy"* come contesto.

---

## K. INCIDENT RELATIONSHIP — `OVER_COLLECTED_AT_CLOSE`

### K.1 Il fatto che decide tutto: la grana non coincide

| Incidente | `entity_type` | `order_id` popolato | `table_session_id` | Righe vive |
|---|---|---|---|---|
| `UNPAID_BALANCE_AT_CLOSE` | `order` | **20 / 20** ✅ | NULL | 13 pending + 7 superseded, **231,51 €** |
| `OVER_COLLECTED_AT_CLOSE` | `table_session` | **0 / 1** ❌ | popolato | 1 pending, **10,00 €** |

> **L'incidente over-collected non sa nemmeno quale ordine ha over-incassato.** Nomina la table_session. Una sessione può contenere più ordini. **Non può essere source of truth per una pendenza per-order.**

I due incidenti finanziari **non concordano nemmeno fra loro** sulla grana. È l'argomento decisivo.

### K.2 Modello pulito proposto

```
                     ┌────────────────────────────────────────────┐
   SOURCE OF TRUTH   │  balance = obligation(MAX rev) − netCollected │  ← derivato, sempre
                     └──────────────────────┬─────────────────────┘
                                            │ genera
                                            ▼
                                    POR DEVOLVER 10,00 €
                                            │
                                            │ correlata (display + audit)
                                            ▼
                     ┌────────────────────────────────────────────┐
   AUDIT ANCHOR      │ service_incidents.OVER_COLLECTED_AT_CLOSE   │  ← fatto storico
                     │ "questa mesa ha chiuso con esposizione"     │     immutabile
                     └──────────────────────┬─────────────────────┘
                                            │ quando balance → 0
                                            ▼
                     ┌────────────────────────────────────────────┐
   RECONCILIATION    │ service_incident_resolutions                │  ← già esiste!
                     │ (incident_id, resolution_status/type,       │
                     │  actor, role, created_at)                   │
                     └────────────────────────────────────────────┘
```

**Tre regole:**
1. **POR DEVOLVER deriva dal balance.** Sempre. L'incidente non entra mai nel calcolo dell'importo.
2. **L'incidente resta un fatto di closeout**, append-only, non cancellabile (`service_incidents_facts_immutable`, `service_incidents_no_delete`).
3. **Quando il balance torna a zero, l'incidente PUÒ essere riconciliato** via `service_incident_resolutions` — con attore, ruolo e timestamp. Nessuna nuova tabella: quella struttura esiste già.

**La correlazione si fa via `table_session_id`, non via order_id** (l'incidente non ce l'ha). Con più ordini sotto una sessione, il collegamento è 1-a-molti e va presentato come tale — mai fingendo che l'incidente nomini un ordine.

**Priorità:** la riconciliazione dell'incidente è **Slice successiva**, non prerequisito. Pendientes funziona benissimo senza toccare gli incidenti.

---

## L. PARTIAL RESOLUTION

**Nessuna pendenza nuova viene creata. Mai.** L'importo è ricalcolato, la riga resta la stessa perché la sua identità è `order_uid`, che non cambia.

```
POR COBRAR 20 → incasso 5 → resta 15   (stessa riga, amount aggiornato, state=PARTIALLY_RESOLVED)
POR DEVOLVER 20 → refund 5 → resta 15  (idem)
```

**Il DB già lo supporta e lo ha già dimostrato.** La migrazione 117 ha provato con 25/25 probe: 40,50 € raggiunti tramite **tre refund parziali cumulativi** (10,00 + 17,50 + 13,00), il terzo a cavallo di due ordini in una sola chiamata, con i cap per riga rispettati in tutte e tre.

**Il cap è la garanzia:** `MESA_REFUND_EXCEEDS_REMAINING` (per transazione) e `MESA_REFUND_ALREADY_FULL`. Non serve nessun contatore applicativo.

Il late-collection writer deve avere lo stesso comportamento: `p_amount` opzionale, default = residuo intero, cappato a `unpaidAmount`, con un codice `PENDENCY_COLLECTION_EXCEEDS_UNPAID` simmetrico.

---

## M. SEARCH / CUSTOMER IDENTIFICATION

### M.1 ⚠️ La Mesa non ha un cliente. Verificato riga per riga.

```
#999034 → nombre = "Mesa 6"        tel = "MESA-98794C63"   canal=BANCO  tipo=RITIRO
#999031 → nombre = "Mesa 2"        tel = "MESA-43F4C22D"   canal=BANCO  tipo=RITIRO
#999033 → nombre = "Big Art Vidéo Agency"  tel = "41767011848"  canal=MANUAL tipo=DOMICILIO
```

`tel = 'MESA-' || upper(left(table_session_id, 8))` è un **marcatore sintetico**, non un telefono.

| Canale | Ordini | Con nome **reale** | Con telefono **reale** |
|---|---|---|---|
| RITIRO / BANCO (**Mesa**) | 41 | **0** (38 sono "Mesa N") | **0** (38 sono "MESA-…") |
| RITIRO / MANUAL | 9 | 9 | 0 |
| DOMICILIO / MANUAL | 7 | 7 | 2 |
| RITIRO / TEST | 2 | 2 | 2 |

> **Non inventare dati.** Per una pendenza Mesa, `customer.name` e `customer.phone` devono essere `null`. Il campo `nombre` va usato come **etichetta di tavolo**, non come cliente.

### M.2 Assi di ricerca realmente disponibili

| Asse | Mesa | Domicilio/Manual | Fonte |
|---|---|---|---|
| Nome cliente | ❌ | ✅ | `ordenes.nombre` (filtrando i marcatori `Mesa N`) |
| Telefono | ❌ | ⚠️ parziale (2/7) | `ordenes.tel` (filtrando `MESA-*`) |
| **Numero di tavolo** | ✅ | — | `table_number_snapshot` / `table_name_snapshot` |
| **Numero ordine display** | ✅ | ✅ | `ordenes.id` (`#NNN`) — **ricerca sì, identità no** |
| **Data / ora** | ✅ | ✅ | `ordenes.created_at`, `ordenes.hora` |
| **Canale** | ✅ | ✅ | `tipo_consegna` + `canal` |
| N. comanda | ✅ | — | `table_command_number` |

**Regola:** `#NNN` è ammesso **come chiave di ricerca**, mai come target dell'azione. Trovata la riga, ogni azione viaggia su `orderUid`. È esattamente la disciplina già applicata da `MesaCommercialAdjustments` (*"Targets exclusively `command.financial.orderUid`; the recycled display `#NNN` is NEVER an adjustment target and NEVER a fallback"*).

---

## N. FILTRI UI MINIMI (§8) e CLASS B FAIL-CLOSED (§18)

### N.1 Filtri — quattro, non di più

1. **Dirección** — `Todas` / `Por cobrar` / `Por devolver` (segmented control, sempre visibile)
2. **Buscar** — un solo campo, che matcha *contemporaneamente* nombre reale, telefono reale, `#NNN`, numero di tavolo
3. **Periodo** — `Últimos 7 días` / `Últimos 30` / `Todas` (default: **Todas** — una pendenza non ha finestra)
4. **Canal** — solo se ci sono ≥2 canali con pendenze; altrimenti **non renderizzare il filtro**

**Deliberatamente esclusi:** filtro per servizio (concetto interno), per metodo (irrilevante finché non si sceglie la transazione), per stato di risoluzione (le risolte spariscono), per operatore.

**Ordinamento default: `amount` decrescente.** Non per data: l'operatore cerca l'esposizione grossa. Con badge `ageDays` sulle vecchie.

### N.2 Class B — fail-closed, misurata

**12 eventi / 210,00 €** hanno `(order_id, service_session_id)` che non risolve a nessuna riga `ordenes`.

Nota importante: `ordenes.order_uid` è **100% popolato (59/59)**. Il debito Class B **non** è sugli ordini — è sul **ledger**: `order_financial_events.order_id` è `TEXT` (il display `#NNN` riciclato) e **non ha una colonna `order_uid`**. È il lavoro che N-7 non ha ancora fatto.

**Policy proposta:**

```
identityConfidence = 'STABLE'  ⇔  ordenes.order_uid IS NOT NULL
                              AND (order_id, service_session_id) risolve a ESATTAMENTE 1 riga ordenes

STABLE      → compare in Pendientes, azioni abilitate
UNRESOLVED  → NON compare in Pendientes
              → compare in ACTIVIDAD / ALERTAS come "Requiere revisión"
              → SOLA LETTURA: nessuna azione, nessun bottone, neanche disabilitato
              → importo mostrato, target economico dichiarato sconosciuto
```

**Perché "Requiere revisión" e non nascosto del tutto:** 210,00 € che spariscono da ogni schermo sono peggio di 210,00 € marcati come non attribuibili. Ma **non** vanno in Pendientes, perché Pendientes è una lista *azionabile* e su queste righe non si può agire senza indovinare l'identità.

**Mai indovinare.** Nessun fallback su `order_id` da solo — è precisamente l'errore che N-6 ha corretto (`#001` avrebbe rimborsato 10,00 € di una sessione estranea invece dei suoi 16,00 €).

---

## O. FUTURA STRUTTURA ECONOMÍA — **MODIFY**

### O.1 Cosa c'è oggi

`EconomiaBottomNav.jsx` — 5 tab: **General · Caja · Historial · Estadísticas · Clientes**
(General = `EconomiaGeneral.jsx` riprogettato; gli ultimi tre = superficie legacy renderizzata invariata, esplicitamente *"Out of scope for this slice by design"*.)

### O.2 Valutazione della struttura proposta

| Proposta | Verdetto | Nota |
|---|---|---|
| **1. RESUMEN** | ✅ **YES** — esiste già come `General` | ⚠️ **non rinominare**: `General` vs `Resumen` fu una scelta di prodotto deliberata e documentata nel componente, per non far leggere General e Caja come due versioni della stessa pagina |
| **2. PENDIENTES** | ✅ **YES** — è il nuovo tab | il cuore di questo lavoro |
| **3. CAJA** | ✅ **YES** — esiste, invariato | `EconomiaSnapshotPanel showEconomicWindow={false}` |
| **4. ACTIVIDAD / ALERTAS** | ⚠️ **MODIFY** — esiste già altrove | `IncidenciasPage.jsx` ha già le tab pending/historial sugli incidenti. **Non costruire una seconda superficie incidenti**: o si sposta Incidencias qui, o Actividad linka lì |
| **5. SERVICIO** | ⚠️ **MODIFY** — **conflitto esplicito** | `EconomiaBottomNav.jsx` dichiara: *"This bar NEVER contains a lifecycle action. Finalizar servicio lives in Servicio and only there — Economía reads the economy and counts the drawer; it does not close the service."* |

### O.3 ⚠️ Il conflitto su "SERVICIO" va deciso, non aggirato

Mettere **Finalizar** dentro Economía viola un confine scritto a caro prezzo dopo l'incidente forense del servizio `480eca89` (2026-08-21), dove un report di sola lettura intitolato *"Cierre del servicio"* fece credere al proprietario che la serata fosse stata chiusa — mentre **zero closeout attempts** erano mai stati registrati.

**Raccomandazione:** in Economía va un tab **`Servicio` di SOLA LETTURA** (snapshot + reconciliation + link), e **`Finalizar` resta dov'è**. Se il proprietario vuole spostare l'azione, va fatto con la stessa disciplina di copy — non come effetto collaterale di un riordino di tab.

### O.4 Struttura raccomandata

```
ECONOMÍA
├── General      (invariato — Ventas, Cobrado bruto, Reembolsado ⚠️BUG A, Cobrado neto, Pendiente, Cobrado de más)
├── Pendientes   ★ NUOVO   (Por cobrar · Por devolver · búsqueda · acciones)
├── Caja         (invariato)
├── Actividad    (MODIFY — riusa IncidenciasPage, + Class B "Requiere revisión")
└── Servicio     (MODIFY — sola lettura; Finalizar NON qui)
```
Cinque slot, come oggi. **Historial / Estadísticas / Clientes** vanno riassorbiti dentro General e Actividad — ma è una **Slice separata**, non un prerequisito di Pendientes, e va fatta sapendo che oggi Historial è rotto (§Q, BUG B).

---

## P. PAYMENT HUB UX — **MODIFY (piccola)**

### P.1 È già quasi tutto lì

`MesaAccountBalance.jsx` renderizza **due layout dagli stessi dati**:

**Layout compatto** (quando `Σ commands[].financial.commercialAdjustment === 0` — cioè oggi ogni tavolo):
```
Total · Ya cobrado · Resta por pagar     [+ Cobrado de más se >0] [+ Reembolsado se ci sono refund]
```
→ **È già esattamente la vista normale che il brief chiede.**

**Layout itemizzato** (quando c'è un aggiustamento):
```
Venta original · Ajuste comercial · Obligación actual · Ya cobrado · Resta por pagar · Cobrado de más
```
→ **È già esattamente il contenuto di `Detalles económicos ▾`.**

### P.2 Le tre sole differenze

| # | Oggi | Proposto | Effort |
|---|---|---|---|
| 1 | il layout itemizzato **sostituisce** il compatto | il compatto **resta sempre**, l'itemizzato va dentro `Detalles económicos ▾` (aperto di default se c'è complessità) | piccolo |
| 2 | etichetta **"Ajuste comercial"** | **"Corrección de importe"** | banale, ma tocca `mesaAdjustment.js` + i test statici |
| 3 | `MesaCommercialAdjustments` è una sezione inline admin-only | azione secondaria sotto **`Más acciones → Corregir importe`** | piccolo |

### P.3 Cosa NON toccare

`MesaCommercialAdjustments` è già corretto sui punti che contano e va lasciato così:
- **admin-only**, con `canAdjust` passato dal chiamante e il backend come autorità finale;
- targeta **solo `financial.orderUid`**, mai `#NNN`, mai un fallback;
- **nessuna mutazione ottimistica**: rilegge il conto canonico dopo il successo;
- **una sola UI di aggiustamento** condivisa da tavolo aperto e sessione chiusa.

**Verdetto §P: MODIFY, FE-only, nessuna migrazione, nessun cambio backend.** È la slice più economica dell'intero piano.

---

## Q. KNOWN BUGS / DEBTS

### 🔴 BUG A — `ECONOMÍA_DEVUELTO_REFUND_MISSING` → **ROOT-CAUSED**

**Classificazione: PARALLEL FIX. Frontend-only. Una riga per file, due file.**

**Non è un bug di backend. Il backend pubblica già il numero giusto.**

```js
// ❌ src/components/economia/EconomiaGeneral.jsx:367
<Kpi label="Devuelto" value={money(obligation.refunded)} testId="general-kpi-devuelto" />
// ❌ src/components/economia/EconomiaSnapshotPanel.jsx:274
<Metric testId="m-refund" label="Devuelto" value={eur(snapshot.obligation.refunded)} />
```

`obligation.refunded` = `Σ safeTicket.refundedAmount` sulle **obbligazioni NATE nella finestra**.
`receipts.refunded` = `Σ` degli eventi refund **avvenuti nella finestra**. ← **questo è "Devuelto"**

**Prova aritmetica sulla finestra "Hoy" (2026-08-28 04:00 → 2026-08-29 04:00 Madrid):**

| | valore |
|---|---|
| Obbligazioni nate nella finestra | **0** |
| Eventi receipt nella finestra | 2 |
| `receipts.collectedGross` | 85,00 |
| **`receipts.refunded`** | **15,00** ✅ |
| **`obligation.refunded`** | **0,00** ❌ ← quello che il FE mostra |
| `receipts.collected` (= 85 − 15) | 70,00 ✅ *(coincide con il "Cobrado 70" visto in UAT)* |

La vendita è nata il 25/08, il refund è avvenuto il 28/08: su "Hoy" la popolazione obbligazioni è vuota **per progetto**. Il campo giusto (`receipts.refunded`, più `receipts.byMethodRefunds`) è già sul filo, aggiunto da Refund V1 Slice C.

**Fix:** leggere `receipts.refunded`. È lo stesso identico difetto già segnalato in `closeoutReconciliation.js:315,330` (*"mixes populations — `collected: …receipts.collected` but `refunded: …obligation.refunded`"*): **vanno corretti insieme**, altrimenti due superfici continueranno a dissentire.

**Non correggerlo ora, come richiesto.** Ma è un fix da ~10 minuti e senza migrazione.

### 🟠 BUG B — Historial UI

**Classificazione: LATER DEBT. Non prerequisito, non parallel.**

Confermato quanto dice il brief: le tab `historial` / `estadisticas` / `clientes` renderizzano la superficie legacy **dichiaratamente non ritoccata** (*"Out of scope for this slice by design… its redesign waits for its own slice"*). La sua data path passa da `getEconomiaLedger` → `economiaLedgerAggregate`, che è **service-scoped** (itera `service_sessions` per `business_date`) — una forma strutturalmente diversa dal reader Pendientes, che è cross-service e senza finestra.

**Non usarlo come base architetturale.** Confermo la valutazione del brief. Pendientes deve nascere sul modello `economicWindow.js` / `safeTicket`, mai su `economiaLedgerAggregate`.

### 🟡 DEBT — `SESSION_AGGREGATE_CANONICALIZATION_DEBT`

**Classificazione: PREREQUISITE — ma solo per la superficie Mesa, NON per Pendientes.**

`projectSessionAccount` calcola `total`/`outstanding`/`overCollected` **a livello di sessione** da `table_order_lines` (`totalCents = lines.reduce(...)`), mentre `commands[].financial` è obligation-aware. Il FE compensa derivando da `Σ financial.currentObligation` (display-only, mai persistito).

**Perché non blocca Pendientes:** il reader Pendientes è **per-ordine** e non passa mai da `projectSessionAccount`. Usa `safeTicket`, che è già canonico.

**Perché resta un debito reale:** finché non è risolto, l'aggregato Mesa e Pendientes possono mostrare numeri diversi per lo stesso tavolo, con un aggiustamento in gioco. Va corretto **prima** della Slice 5 (Payment Hub), altrimenti si consolida la compensazione FE.

**Fix corretto:** far ripiegare `projectSessionAccount` sull'obbligazione canonica per-ordine. **Slice backend con la sua migration governance — mai una patch frontend.**

### 🟡 P2 — `v_receipt_service_id` senza guardia
Vedi §G.3. Perdita di provenance, non di denaro. **LATER DEBT.**

---

## R. MINIMUM BACKEND IMPLEMENTATION PLAN

**Ordine modificato rispetto alla proposta iniziale del brief**, per una ragione concreta: la Slice del Payment Hub è FE-only, a rischio zero, e sblocca subito valore UX — non ha senso tenerla ultima. E BUG A è così economico che va agganciato alla prima slice frontend.

| # | Slice | Contenuto | Migration | Rischio |
|---|---|---|---|---|
| **1** | **Canonical pending reader** | `src/economy/pendingExposures.js` + `GET /api/economy/v1/pendencies`. Riusa `safeTicket` — **non reimplementarlo**. Applica la regola §D. Emette il modello §C. Class B fail-closed. `PENDENCY_READ_ROLES`. | **NO** | 🟢 basso |
| **2** | **Economía → Pendientes (FE)** + **BUG A** | nuovo tab, lista, filtri §N.1, ricerca. **Insieme**: `obligation.refunded` → `receipts.refunded` nei due file, + `closeoutReconciliation.js:315,330`. | **NO** | 🟢 basso |
| **3** | **Refund-through-pending** | dalla riga POR DEVOLVER al refund. Riusa `POST /api/mesa/v1/sessions/:id/refunds`, **già live e già capace di Mesa chiusa**. Aggiunge il selettore transazione §G.4. | **NO** *(se solo Mesa)* | 🟡 medio |
| **4** | **Late collection writer** ⚠️ | `*_post_late_collection_v1`. **La sola slice davvero nuova.** Modellata verbatim su `mesa_post_refund_v1`. Chiude POR COBRAR e (se scrive transazioni) anche il refund non-Mesa. | **SÌ** | 🔴 alto |
| **5** | **Payment Hub cleanup (FE)** | `Detalles económicos ▾`, rinomina in *Corrección de importe*, `Más acciones`. Dopo aver risolto il debito §Q. | **NO** | 🟢 basso |
| **6** | *(opz.)* Incident reconciliation | `service_incident_resolutions` quando il balance torna a zero. | **NO** | 🟡 medio |

**Perché Slice 4 è ultima nonostante sia la più richiesta:** è l'unica con una migrazione, l'unica che tocca uno schema (`payment_transactions.table_session_id` nullable) e l'unica che può creare un secondo ledger di pagamento se sbagliata. Le Slice 1-3 danno **visibilità immediata** su 8 pendenze reali e chiudono già del tutto il lato POR DEVOLVER Mesa — che è il caso provato in UAT. Slice 4 va affrontata con il pieno protocollo rollback-forced che ha funzionato per 117/118/119.

**Non fare mai:** costruire Pendientes come una tabella. Copiare `safeTicket` invece di importarlo. Toccare `order_financial_events_one_payment_session_uq` senza il predicato `payment_transaction_id IS NULL`.

---

## S. MIGRATION REQUIREMENT — slice per slice

| Slice | Migration | Perché |
|---|---|---|
| **1 — Pending reader** | ❌ **NO** | Pura lettura. Ogni colonna necessaria esiste: `order_obligations.gross_amount/revision/order_uid`, `order_financial_events.type/amount/created_at/service_session_id`, `ordenes.order_uid/created_at/table_session_id/estado`, `table_sessions.status`. Zero DDL. |
| **2 — FE Pendientes + BUG A** | ❌ **NO** | Solo frontend. `receipts.refunded` è già sul filo. |
| **3 — Refund-through-pending** | ❌ **NO** *(Mesa)* / ⚠️ **SÌ** *(non-Mesa)* | `mesa_post_refund_v1` è live e accetta Mesa chiuse. Estenderlo agli ordini non-Mesa richiede un target diverso da `payment_transaction_id` → migrazione. **Consiglio: rinviare il non-Mesa alla Slice 4**, che lo risolve gratis. |
| **4 — Late collection** | ✅ **SÌ, obbligatoria** | (a) nuova funzione `*_post_late_collection_v1`; (b) `payment_transactions.table_session_id` NOT NULL → nullable, *se* si copre il non-Mesa; (c) `supabaseResourcePolicy.js` deve avere l'entry `rpc/…` **o fallisce chiuso senza una sola riga di transport log**; (d) `auth_audit_event_chk` va allargata additivamente per il nuovo evento — **stessa trappola che ha fatto abortire il primo apply della 117**. |
| **5 — Payment Hub** | ❌ **NO** | Solo etichette e layout. |
| **6 — Incident reconciliation** | ❌ **NO** *(probabile)* | `service_incident_resolutions` esiste già con tutte le colonne. Da confermare che esista un writer RPC; se manca, +1 funzione. |

---

## T. HARD BLOCKERS

# 🟢 **NESSUN HARD BLOCKER ARCHITETTURALE**

Non c'è nulla che impedisca di **decidere** l'architettura e di **iniziare** dalla Slice 1.

### T.1 Gap implementativi — bloccanti per una funzione, non per l'architettura

| # | Gap | Blocca | Non blocca |
|---|---|---|---|
| **1** | **Nessun writer di incasso tardivo** — `MESA_SESSION_NOT_OPEN` + `AUTH_BASIS_EXISTS` | la **risoluzione** di POR COBRAR | la **visibilità** (Slice 1-2) e tutto POR DEVOLVER |
| **2** | **Il denaro non-Mesa non ha transazioni** — 6 eventi / 150,50 € | il refund su Retiro/Domicilio | il refund Mesa, che è il 100% dei casi provati in UAT |
| **3** | **`cashier` non può rimborsare** — gate in JS **e** in SQL | il modello di ruoli richiesto dal brief | tutto il resto; è una **decisione di prodotto**, non un difetto |

### T.2 Decisioni che servono dal proprietario (non tecniche)

1. **`cashier` può rimborsare?** Il sistema oggi dice no, deliberatamente. Se sì → migrazione su `mesa_post_refund_v1`.
2. **Il tab `Servicio` in Economía può contenere `Finalizar`?** Raccomandazione forte: **no**, sola lettura (§O.3).
3. **Il late-collection writer copre anche il non-Mesa?** Se sì, serve rendere `payment_transactions.table_session_id` nullable — ma si chiudono due gap con un lavoro solo.

### T.3 Precondizioni operative per la Slice 4 (dalle lezioni già pagate)

- entry `rpc/…` in `supabaseResourcePolicy.js`, **altrimenti fallisce chiuso senza log**;
- `REVOKE` che nomini **esplicitamente `anon` e `authenticated`** (questo progetto ha un `pg_default_acl` che concede EXECUTE a entrambi su ogni funzione nuova — lezione della ledger 118);
- ogni nuovo codice d'errore in **`mesaHttpHandlers.safeError` E `mesaApi.js` nella stessa slice**;
- dry-run rollback-forced completo **prima** dell'apply reale;
- md5 del `prosrc` vivo confrontato con il file committato **dopo** l'apply (il `prosrc` vivo è comment-stripped: confrontare solo corpi normalizzati).

---

## APPENDICE

### APP-1 — La query di derivazione (sola lettura, eseguita sullo staging reale)

```sql
WITH ob AS (
  SELECT DISTINCT ON (order_uid) order_uid, order_id, service_session_id, gross_amount, revision
  FROM order_obligations ORDER BY order_uid, revision DESC          -- N-2: MAX(revision)
),
ev AS (
  SELECT e.order_id, e.service_session_id,
    SUM(CASE WHEN e.type IN ('payment','payment_imported') THEN e.amount ELSE 0 END) AS paid,
    SUM(CASE WHEN e.type='refund' THEN e.amount ELSE 0 END)                          AS refunded,
    MAX(e.created_at) AS last_movement
  FROM order_financial_events e GROUP BY 1,2
)
SELECT o.order_uid, o.id AS display, o.canal, o.tipo_consegna, o.estado,
  COALESCE(ob.gross_amount, o.totale) AS obligation_gross,        -- legacy fallback = safeTicket
  COALESCE(ev.paid,0) - COALESCE(ev.refunded,0) AS net_collected,
  GREATEST(0, (CASE WHEN o.estado IN ('CANCELADO','ANULADO','CANCELLED') THEN 0
                    ELSE COALESCE(ob.gross_amount, o.totale) END)
              - (COALESCE(ev.paid,0)-COALESCE(ev.refunded,0)))     AS por_cobrar,
  GREATEST(0, (COALESCE(ev.paid,0)-COALESCE(ev.refunded,0))
              - (CASE WHEN o.estado IN ('CANCELADO','ANULADO','CANCELLED') THEN 0
                      ELSE COALESCE(ob.gross_amount, o.totale) END)) AS por_devolver,
  o.created_at AS sale_at, ev.last_movement AS last_movement_at
FROM ordenes o
LEFT JOIN ob ON ob.order_uid = o.order_uid
LEFT JOIN ev ON ev.order_id = o.id
           AND ev.service_session_id IS NOT DISTINCT FROM o.service_session_id;  -- N-6 composite
```

### APP-2 — Stato economico vivo dello staging (2026-08-28)

| Metrica | Valore |
|---|---|
| Ordini | 59 (**order_uid: 59/59, 0 NULL**) |
| `order_financial_events` | 69 (68 payment · 1 refund) |
| `payment_transactions` | 46 (45 payment · **1 refund**) |
| `payment_allocations` | 125 |
| `order_obligations` | 8 righe su 6 order_uid |
| `table_sessions` | 91 (**0 aperte**) |
| `service_sessions` | 25 (**1 aperta: `42af1de9`, business_date 2026-08-25**) |
| `service_incidents` | 56 (1 `OVER_COLLECTED_AT_CLOSE` da 10,00 €) |
| **Pendenze reali dopo la regola §D** | **2** — 50,00 € POR COBRAR + 10,00 € POR DEVOLVER |
| Class B | **12 eventi / 210,00 €** |
| Denaro non-Mesa rimborsabile-bloccato | **6 ordini / 150,50 €** |

⚠️ Nota di contesto: il servizio `42af1de9` è **aperto dal 2026-08-25** (modello `operational_service_v1`, "servizio fino a Finalizar"). Lo scenario "giorno dopo" dell'UAT si è quindi svolto **dentro un unico servizio lungo**: la doppia timbratura di periodo è provata, ma il passaggio di confine `event_service_session_id ≠ service_session_id` **non è ancora stato esercitato su righe vive** (38 righe su 69 hanno `event_service_session_id` NULL, scritto solo da `mesa_post_payment_v1` / `mesa_post_refund_v1` / `consolidate_period_v1`). Va incluso nel piano di test della Slice 4.

### APP-3 — Verifiche di sola lettura eseguite

23 query SQL read-only su `tdikhfeinufaahagmpjz`; lettura del `prosrc` vivo di `mesa_post_payment_v1`, `mesa_post_refund_v1`, `mesa_close_session_v1`, `mesa_post_commercial_adjustment_v1`, `_ledger_write_payment`, `service_session_assign_financial_event`, `payment_transactions_stamp_economic_period_v1`; lettura del sorgente committato di `mesaService.js`, `billingMath.js`, `currentServiceCloseout.js`, `economicSnapshot.js`, `economicWindow.js`, `economiaLedgerAggregate.js`, `capabilityRegistry.js`, `actionPolicyRegistry.js`, `roleRegistry.js`, `MesaAccountBalance.jsx`, `MesaCommercialAdjustments.jsx`, `EconomiaGeneral.jsx`, `EconomiaSnapshotPanel.jsx`, `EconomiaBottomNav.jsx`, `EconomiaPage.jsx`, e della migrazione `2026-08-26_refund_v1_slice_a_mesa_post_refund.sql`.

**Zero scritture. Zero migrazioni. Zero deploy. Zero commit di codice.**

---

PENDENCIAS_ECONOMICAS_ARCHITECTURE_READY
