# Operational Adjustment Metrics — READ-ONLY Report (2026-06-06)

**Repo:** `ladieci-bot` · **Branch:** `feature/operational-adjustment-metrics-readonly-2026-06-06`
**Base:** backend live `8768dec`. **Modalità:** helper/test/report locale. Nessun deploy / DB / migration.

## Cosa è stato implementato
- Nuovo helper PURO `src/core/delivery/operationalAdjustmentMetrics.js`:
  - `computeOperationalAdjustmentMetric(order, { marginMin })` — metriche per-ordine;
  - `summarizeOperationalAdjustments(orders, options)` — aggregato safe.
- Test `tests/operationalAdjustmentMetrics.test.js` — **45 check, 0 fail** (9 casi obbligatori + static safety).

## Perché è read-only
- Pure function: nessun `require` di Supabase, nessun `fetch`, nessun `process.env`, nessun side-effect, nessuna PII in output (verificato da static-safety test + grep).
- **Non** modifica `hora`, `forno_out`, né alcun campo DB. **Non** scrive nulla. **Non** cambia planner/endpoint/frontend.
- `hora_operativa` è **derivata** a runtime (`hora + ajuste`), mai persistita.

## Come interpreta `ui_offset_min`
Il `ui_offset_min` esistente (oggi snooze visivo `+5/+10`, cap 20, non letto da planner/shadow, senza storico) viene **letto come `ajuste_operativo_min`** senza cambiarne la scrittura. Modello:
```
hora_original        = order.hora                         (promessa cliente, intatta)
ajuste_operativo_min = max(0, ui_offset_min)
hora_operativa       = hora_original + ajuste_operativo_min   (DERIVATA)
reale                = listo_at (timestamp lifecycle)
margine              = 10 min (default, parametro options.marginMin)
```

### Classificazione
| classification | condizione |
|---|---|
| `no_adjustment` | ajuste 0 (e LISTO in orario, o non ancora pronto) |
| `active_adjustment` | ajuste > 0, ordine non ancora LISTO |
| `absorbed` | ajuste > 0, `listo_at ≤ hora_operativa` (il riallineo ha assorbito il ritardo) |
| `within_margin` | ajuste 0, `listo_at` dopo `hora_original` ma entro `+margine` |
| `outside_margin` | reale oltre la scadenza operativa (ajuste>0: oltre `hora_operativa`; ajuste 0: oltre `hora_original+margine`) |
| `unknown` | `hora` mancante |

`adjustment_status` ∈ {`none`, `active`, `absorbed`, `exceeded`} descrive il ciclo di vita dell'ajuste (campo distinto dalla `classification`).

## Esempi (dai test)
| Caso | Input | hora_operativa | classification |
|---|---|---|---|
| no adjustment | hora 21:30, off 0 | 21:30 | `no_adjustment` |
| +5 active | hora 21:30, off 5, listo null | 21:35 | `active_adjustment` |
| +5 absorbed | hora 21:30, off 5, listo 21:33 | 21:35 | `absorbed` (`-2` vs operativa) |
| +10 outside | hora 21:30, off 10, listo 21:45 | 21:40 | `outside_margin` (`+5`) |
| **#013-like** | hora 21:30, forno 21:27, listo 21:33:45 | — | **off 0 → `within_margin`** (retraso leve +6.8 vs forno); **off +5 → `absorbed`** |
| post-mezzanotte | hora 00:10, off 10, listo 00:15 | 00:20 | `absorbed` (wrap corretto) |

Il caso #013-like dimostra il **valore del doppio dato**: lo stesso evento reale passa da "ritardo lieve" a "assorbito" quando si considera il riallineo operativo deciso dal servizio.

## Aggregato (`summarizeOperationalAdjustments`)
Ritorna: `totalOrders, adjustedOrders, activeAdjustments, absorbedAdjustments, outsideMargin, maxAdjustmentMin, avgAdjustmentMin, watchOrders[]`.
`watchOrders` (solo ajuste attivi o fuori margine) contiene solo `orderId, tipo, estado, hora_original, hora_operativa, ajuste_operativo_min, classification` — **no PII**.

## Cosa NON cambia
- ❌ Planner live: **non** usa ancora `hora_operativa` (continua su `hora`/`forzado_hora`).
- ❌ DB / schema: nessuna migration, nessuna colonna nuova, nessuna scrittura.
- ❌ `hora`: mai modificata (`hora_operativa` è derivata).
- ❌ Frontend: invariato (lo snooze `ui_offset_min` resta com'è).
- ❌ Shadow Preview endpoint: **non** integrato (vedi sotto) — `ui_offset_min` non è in `ORDER_SELECT_FIELDS`; integrarlo toccherebbe il read-path live → rinviato per sicurezza.

## Prossimi step consigliati
1. **Shadow Preview (read-only):** aggiungere `ui_offset_min` a `ORDER_SELECT_FIELDS` e una sezione `operationalAdjustments` (solo dati safe, no PII) al contract read-only — step piccolo ma tocca il read-path, da fare isolato + test contract.
2. **Schema/migration (additiva):** promuovere `ui_offset_min` → `ajuste_operativo_min` + `ajuste_operativo_estado`, log step in `orden_estado_logs.metadata` (actor/reason/source). Richiede approvazione esplicita.
3. **Planner legge `hora_operativa`:** target = `hora_operativa` (fallback `forzado_hora`/`hora`).
4. **UI:** doppio orario cliente/operativo + badge `absorbed`/`fuera de margen`.
5. **Decay automatico** (`+10→+5→0`): solo dopo dati live validati da queste metriche.

## Safety
Nessun deploy · nessun push · nessuna migration · nessuna scrittura DB · nessun geo_cache · nessun WhatsApp · nessun CommitWriter · nessun cambio planner/endpoint/frontend. Helper puro e reversibile.
