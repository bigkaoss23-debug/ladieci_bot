# Operational Adjustment — Shadow Preview Integration (READ-ONLY) — 2026-06-06

**Repo:** `ladieci-bot` · **Branch:** `feature/operational-adjustment-metrics-readonly-2026-06-06`
**Base:** `e7ef820` (helper read-only già committato). **Modalità:** observability shadow, additiva. Nessun deploy / DB / migration / planner change.

## Cosa è stato integrato
Lo Shadow Preview read-only ora espone una sezione **`operationalAdjustments`** che interpreta `ui_offset_min` (snooze cucina +5/+10) come `ajuste_operativo_min` e confronta **originale vs operativo vs reale**, **senza** cambiare alcuna decisione del planner.

### File modificati
| File | Modifica |
|---|---|
| `scripts/deliveryPlannerShadowLiveReadOnly.js` | `normalizeDbRow` trasporta `ui_offset_min` + `listo_at` come campi **observability** (NON RAW_FIELDS → non entrano nel planner) |
| `scripts/deliveryPlannerShadowReadOnly.js` | `runShadow` importa `summarizeOperationalAdjustments` e calcola `operationalAdjustments` dai DOMICILIO raw, **dopo** `buildPlan`; commento `// OBSERVABILITY ONLY: does not affect planner target time.` |
| `src/core/delivery/shadowPreviewEndpoint.js` | `ORDER_SELECT_FIELDS` += `ui_offset_min`, `listo_at`; `buildShadowPreviewResponse` attacca `operationalAdjustments` al payload (vuoto-ma-presente se nessun ajuste). **`shadowPreviewContract.js` NON toccato.** |
| `src/core/delivery/operationalAdjustmentMetrics.js` | `watchOrders` ora include anche `zona` e `reasons` (entrambi safe) |
| `tests/deliveryPlannerShadowPreviewEndpoint.test.js` | +15 check (blocco `operationalAdjustments`) |

## Struttura del contract aggiunto
```js
operationalAdjustments: {
  totalOrders,            // DOMICILIO considerati
  adjustedOrders,         // con ui_offset_min > 0
  activeAdjustments,      // ajuste attivo, non ancora LISTO
  absorbedAdjustments,    // LISTO entro hora_operativa
  outsideMargin,          // reale oltre la scadenza operativa
  maxAdjustmentMin,
  avgAdjustmentMin,
  watchOrders: [ {        // SOLO active_adjustment + outside_margin (gli absorbed sono risolti)
    orderId, tipo, estado, zona,
    hora_original, hora_operativa, ajuste_operativo_min,
    classification, reasons
  } ]
}
```
Se nessun ordine ha `ui_offset_min`: summary **presente** con tutti i contatori a 0 e `watchOrders: []`.

## Perché è read-only
- `operationalAdjustments` è calcolato da un **helper puro** (no DB/fetch/env/PII) **dopo** `buildPlan`, solo per il report.
- `ui_offset_min`/`listo_at` sono campi **observability**: NON in `RAW_FIELDS`, quindi **non alimentano** l'input del planner (regola "il derivato non alimenta il derivato" rispettata).
- Il planner continua a usare `hora` / `forzado_hora` come target. **Nessuna decisione cambia.**
- Il contract resta `readOnly:true`, `writesEnabled:false`, `piiIncluded:false`, `rawDiagnosticsHidden:true`.

## Esempi (dal test endpoint, full path `buildShadowPreviewResponse`)
| Caso | Input | operationalAdjustments |
|---|---|---|
| Assorbito | DOMICILIO LISTO, hora 21:30, off 5, listo 21:33 | adjustedOrders 1, absorbedAdjustments 1, outsideMargin 0, maxAdj 5, watchOrders [] |
| Nessun ajuste | off 0 | adjustedOrders 0, watchOrders [] |
| Fuori margine | hora 21:30, off 10, listo 21:45 | outsideMargin 1, watchOrders[0].classification `outside_margin`, hora_operativa 21:40 |

**`watchOrders` design:** include solo `active_adjustment` + `outside_margin` (gli `absorbed` sono ritardi già risolti dal riallineo, non da monitorare). Coerente con i test dell'helper.

## Safety / no PII
- `watchOrders` contiene solo campi operativi safe (orderId/tipo/estado/zona/orari/ajuste/classification/reasons). Test `OA4` verifica che nomi/telefono/indirizzo/wa_id **non** compaiano nel contract.
- Test `OA5/OA6`: status non critical, safety flags intatti, **nessuna nuova action** introdotta, LISTO false-critical resta fixato anche con `ui_offset_min` presente.

## Cosa NON cambia
- ❌ Planner: non legge `hora_operativa` (target invariato `hora`/`forzado_hora`).
- ❌ DB / schema: nessuna migration, nessuna scrittura.
- ❌ `hora`: mai modificata.
- ❌ Frontend: invariato.
- ❌ `shadowPreviewContract.js`: non toccato.

## Test
| Comando | Risultato |
|---|---|
| `node tests/operationalAdjustmentMetrics.test.js` | 45 PASS |
| `node tests/deliveryPlannerShadowPreviewEndpoint.test.js` | **48 PASS** (+15 OA) |
| `node tests/deliveryPlannerShadowPreviewFrozenOrders.test.js` | 19 PASS |
| `node tests/deliveryPlannerShadowReadOnly.test.js` | 23 PASS |
| Suite completa (37 file) | **37 OK · 0 FAIL** |

## Prossimi step
1. **Live monitoring** nel prossimo servizio: leggere `operationalAdjustments` dallo shadow read-only (HTTP authed GET) per validare soglie/assorbimento sui dati veri.
2. **Schema/migration** (additiva): `ui_offset_min` → `ajuste_operativo_min` + `_estado`, log step in `orden_estado_logs.metadata`. Solo dopo validazione + approvazione esplicita.
3. **Planner legge `hora_operativa`**: solo dopo che i dati live confermano il modello.
4. **UI:** badge cliente/operativo/absorbed.
5. **Decay automatico** (`+10→+5→0`): ultimo step, basato su evidenza live.
