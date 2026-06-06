# Live Monitoring Closure — Fix locali (servizio 05/06/2026)

**Data lavoro:** 2026-06-06 · **Repo:** `ladieci-bot` (backend/core)
**Branch lavoro:** `fix/live-monitoring-closure-2026-06-06-local-only`
**Backup pre-lavoro:** `backup/pre-live-monitoring-closure-2026-06-06` (@ `adb118f`)
**Modalità:** SOLO LOCALE. Nessun deploy, nessuna scrittura su produzione.

Patch mirate, testate, reversibili, emerse dal live monitoring read-only del
servizio reale del 05/06/2026 (backend live `adb118f`, 24 ordini).

---

## 1. Cosa è stato fixato

### P0 — Self-loop terminali non sovrascrivono più i timestamp
**Problema live:** l'ordine #002 (Q3) ha avuto un re-click `RETIRADO→RETIRADO` alle
21:05:30 che ha **sovrascritto `retirado_at`** (il ritiro reale era 20:35:03),
corrompendo l'analytics del giro.

**Fix:**
- `src/utils/orderStateLogger.js` → `buildStateTimestampPatch`: se `from === to`
  (self-loop) NON valorizza la colonna `*_at` né i derivati legacy
  (`hora_salida`/`hora_entrega`/`confirmado_at`). Tocca solo `updated_at`.
  Protezione alla sorgente PURA, indipendente dal chiamante.
- `src/agents/agentOrdini.js` → `cambiaStato`: rileva il no-op
  (`validateTransition` → reason `"noop"`) e:
  - non scrive log di transizione ridondante (niente log terminali duplicati che
    falserebbero le metriche);
  - salta gli hook di stato (manual-giro detach, sync `conv`/`wa_msgs`,
    `direccion_confermata_il`) che su un re-click resetterebbero/sovrascriverebbero
    dati;
  - ritorna `{ success: true, noop: true }` (idempotente, niente errore operativo);
  - **mantiene** gli extras espliciti di pagamento/sconto già in `upd` (intento
    operatore reale, non corruzione di timeline).

Transizioni legittime intatte: `EN_COCINA→LISTO` continua a loggare e a settare
`listo_at`; l'undo operativo `LISTO→EN_COCINA` resta permesso e loggato.

### P1 — Shadow Preview LISTO falso-critical
**Problema live:** in prod `adb118f`, un delivery in `LISTO` poteva mandare lo
Shadow HTTP in `critical` falso (visto su #002 e #006), perché `LISTO` non era tra
gli stati frozen/terminal: `isRecomputableDelivery` lo includeva, il planner lo
congelava come committed (`CONGELATO_DURO`), la proiezione usciva null/parete e
l'invariante `noImpossibleFornoOut` falliva → critical falso.

**Fix:** `scripts/deliveryPlannerShadowReadOnly.js` →
`FROZEN_OR_TERMINAL_STATES` ora include `LISTO` (allineato a
`planner.js HARD_FROZEN_STATES = {LISTO, EN_ENTREGA, RETIRADO}`). Effetti:
- LISTO escluso dalle invarianti di ricalcolo (`noImpossibleFornoOut`,
  `noDriverBeforePizza`);
- LISTO non conta come `difference` operativa;
- LISTO produce diagnostic `info` `frozen_committed_order` (coerenza).

L'endpoint HTTP (`shadowPreviewEndpoint.js`) passa per lo stesso `runShadow`
(`deliveryPlannerShadowLiveReadOnly → deliveryPlannerShadowReadOnly`), quindi
**HTTP e script read-only ora concordano**: niente critical, invarianti verdi,
contract safety intatto (`readOnly:true`, `writesEnabled:false`, `piiIncluded:false`).

### P1 — Metrica operativa `LISTO → EN_ENTREGA` (nuovo helper puro)
**Origine:** il collo di bottiglia reale del servizio NON è cucina né planner base,
ma la finestra pizza-pronta → uscita rider.

**Nuovo file:** `src/core/delivery/deliveryOperationalMetrics.js` — pure function,
no DB / no fetch / no env / no side-effect / no PII. Espone:
- `ready_to_rider_exit_min = en_entrega_at − listo_at` con soglie
  `<0`→`invalid_timing`, `0–5`→`ok`, `5–10`→`watch`, `>10`→`late_dispatch_risk`;
  con `en_entrega_at` mancante usa `now` iniettato (attesa accumulata → pending/watch/late);
- `estimated_customer_delivery_from_exit = en_entrega_at + durata_andata_min`;
- `estimated_customer_delay_from_exit_min = stima − ora cliente`;
- `real_trip_min = retirado_at − en_entrega_at` (con `trip_status`
  closed/in_progress/invalid_timing);
- `trip_expected_min ≈ durata_andata_min × 2`;
- wording operativo non accusatorio verso il rider.

Validato su fixture sintetiche dei casi reali #019, #006, #013.

### Semantica stati delivery (commenti/helper)
- `src/utils/orderStateLogger.js`: commento esplicito su `stateEventType` — l'evento
  storico `"delivered"` per `RETIRADO+DOMICILIO` significa **giro chiuso / rider
  tornato**, NON "consegnato al cliente". Nome non rinominato (radicato in consumer
  esistenti, refactor rischioso); le metriche NUOVE usano la semantica corretta.
- `deliveryOperationalMetrics.js` documenta in testa: `EN_ENTREGA` = rider esce;
  `RETIRADO` = rider torna; consegna cliente = STIMATA da `en_entrega_at + durata`.

---

## 2. File modificati / creati

| File | Tipo | Cosa |
|---|---|---|
| `src/utils/orderStateLogger.js` | mod | self-loop guard nei timestamp + commento semantica |
| `src/agents/agentOrdini.js` | mod | `cambiaStato` no-op idempotente (no log/hook ridondanti) |
| `scripts/deliveryPlannerShadowReadOnly.js` | mod (WIP preesistente) | `LISTO` in FROZEN_OR_TERMINAL_STATES |
| `src/core/delivery/deliveryOperationalMetrics.js` | **nuovo** | metriche `LISTO→EN_ENTREGA` (pure) |
| `tests/orderStateTransitions.test.js` | mod | +test P0 self-loop (#002, COMPLETADO/CANCELADO, EN_COCINA, undo) |
| `tests/deliveryPlannerShadowPreviewEndpoint.test.js` | mod | +test LISTO end-to-end via endpoint non-critical |
| `tests/deliveryPlannerShadowPreviewFrozenOrders.test.js` | mod (WIP) | +test LISTO #002 frozen_committed |
| `tests/deliveryOperationalMetrics.test.js` | **nuovo** | suite metriche delivery |

---

## 3. Test eseguiti

| Comando | Risultato |
|---|---|
| `node tests/orderStateTransitions.test.js` | **54 pass · 0 fail** |
| `node tests/deliveryPlannerShadowPreviewFrozenOrders.test.js` | **19 pass · 0 fail** |
| `node tests/deliveryPlannerShadowPreviewEndpoint.test.js` | **33 pass · 0 fail** |
| `node tests/deliveryOperationalMetrics.test.js` | **32 pass · 0 fail** |
| Suite completa `tests/*.test.js` (36 file) | **36 file OK · 0 falliti** |
| `node --check` su tutti i file toccati | OK |

Oven soft vs serious (FASE 6): già calibrato e coperto dai test esistenti
(`deliveryPlannerShadowDiagnostics.test.js`: 5/4→`forno_soft_overload` yellow,
6–7/4→`forno_overload_serio` orange; `…Grouping.test.js`: gruppi soft/serious/hard
separati). Nessuna modifica necessaria.

---

## 4. Safety (rispettato integralmente)

- ❌ NESSUN deploy (Railway / Netlify).
- ❌ NESSUN push.
- ❌ NESSUNA scrittura DB / Supabase.
- ❌ NESSUN tocco a `geo_cache`.
- ❌ NESSUN test WhatsApp reale.
- ❌ NESSUN `CommitWriter`.
- ❌ NESSUNA mutazione di ordini/clienti reali.
- ✅ Nuovo helper `deliveryOperationalMetrics.js`: zero token di scrittura/fetch/env
  nel codice (verificato con grep escludendo i commenti).
- ✅ Endpoint shadow resta read-only (`writesEnabled:false`, `piiIncluded:false`).

---

## 5. Cosa NON è stato fatto (per scelta, troppo ampio / rischioso ora)

- Nessun refactor del naming storico degli stati delivery (`"delivered"`): solo
  commenti chiarificatori.
- Nessuna modifica alla durata Q5 (vedi backlog).
- Nessuna UI/alert frontend per `LISTO→EN_ENTREGA`: solo helper backend puro.

---

## 6. Backlog futuro (documentato, NON implementato)

1. **Ritiro immediato al banco** (`forno_out = now/passato`, visto #001/#004/#010):
   proporre primo slot realistico, default `now + 5`, con priorità ai delivery.
2. **Durata Q5 forse sovrastimata** (#006 ready_to_exit 12.2, stima +13): NON
   cambiare ora — monitorare più campioni prima di toccare la durata.
3. **UI/alert operatore** per la metrica `LISTO→EN_ENTREGA` (oggi solo helper
   backend): mostrare `watch` / `late_dispatch_risk` in dashboard.
4. **Cleanup naming stati delivery** se si vorrà rendere coerente
   `"delivered"`/`RETIRADO` con la semantica reale (rider tornato), con migrazione
   dei consumer.

---

## 7. Cosa resta dopo revisione umana

- Eventuale deploy backend (`agentOrdini` + `orderStateLogger` + runner shadow)
  SOLO dopo approvazione esplicita — il fix P0 cambia il comportamento di
  `cambiaStato` su re-click (ora idempotente).
- Eventuale wiring della metrica delivery in un endpoint/preview read-only.
- Monitoraggio Q5 su più servizi prima di toccare la durata.
