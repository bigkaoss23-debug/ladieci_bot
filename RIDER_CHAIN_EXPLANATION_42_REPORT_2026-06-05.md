# RIDER-CHAIN-EXPLANATION-42

## 1. Problema #017

Durante `REALISTIC-MANUAL-ORDER-STRESS-39`, l'ordine `#017` aveva:

- zona `Q1`
- `hora` 23:05
- `forno_out` 23:00
- `durata_andata_min` 5
- `salida_driver_estimada` 23:34
- `entrega_estimada` 23:39
- `conflicto_driver: true`
- `retraso_estimado_min: 34`

Audit read-only: non era un bug geo e non era un bug evidente del planner. Era single-rider sequencing reale: il rider era occupato dal giro precedente `#016` Q5.

`#016` consegna alle 23:19, durata 12, buffer operativo 3. Quindi rientro stimato:

`23:19 + 12 + 3 = 23:34`

`#017` puo' partire solo alle 23:34.

## 2. Algoritmo blocker

Nuovo helper puro:

- `src/core/delivery/riderChainExplanation.js`

Regola:

1. Considera solo delivery non terminali con:
   - `conflicto_driver === true`
   - `retraso_estimado_min > 0`
2. Cerca un delivery precedente con `entrega_estimada`.
3. Calcola:
   - `riderAvailableAt = prev.entrega_estimada + buffer 3 + prev.durata_andata_min`
4. Se `riderAvailableAt` coincide con `salida_driver_estimada` dell'ordine ritardato, assegna:
   - `blockedByOrderId`
   - `blockedByZone`
   - `reason: rider_return_from_previous_delivery`
5. Se non trova un blocker coerente, usa fallback:
   - `reason: rider_unavailable_unknown_previous_order`

Il formato orario e' service-day aware: dopo mezzanotte produce `00:07`, non `24:07`.

## 3. Output contract

Il runner Shadow ora produce:

```json
"riderChain": [
  {
    "orderId": "#017",
    "level": "warning",
    "delayMin": 34,
    "blockedByOrderId": "#016",
    "blockedByZone": "Q5",
    "riderAvailableAt": "23:34",
    "reason": "rider_return_from_previous_delivery",
    "message": "#017 +34 min: rider bloccato da #016 Q5 fino alle 23:34"
  }
]
```

Il contract Shadow Preview espone `riderChain` e aggiunge action read-only:

- `id: review_rider_chain`
- `label: Revisar cadena rider`
- `type: manual_check`
- `priority: high` se il delay massimo e' > 15 minuti, altrimenti `medium`.

Massimo 3 explanations, ordinate per `delayMin desc`.

## 4. Integrazione

Modifiche:

- `scripts/deliveryPlannerShadowReadOnly.js`
  - calcola `riderChain` sullo snapshot raw/reporting.
  - continua a passare al planner solo `RAW_FIELDS`.
- `scripts/deliveryPlannerShadowLiveReadOnly.js`
  - conserva i campi driver come baseline/reporting.
  - i campi derivati restano esclusi dall'input planner tramite `normalizeRawOrders`.
- `src/core/delivery/shadowPreview.js`
  - include `riderChain` nel preview.
  - aggiunge action testuale `Revisar cadena rider`.
- `src/core/delivery/shadowPreviewContract.js`
  - include `riderChain`.
  - aggiunge action `review_rider_chain`.

## 5. Test

Nuovo test:

- `tests/deliveryPlannerRiderChainExplanation.test.js`

Copertura:

- caso `#017` stress 39: blocked by `#016`, `riderAvailableAt 23:34`;
- no delay: nessuna explanation;
- multiple delays: max 3, ordinate per delay desc;
- after-midnight: `00:07`, nessun `24:xx`;
- blocker sconosciuto: fallback senza crash;
- terminal/frozen completati: nessuna nuova explanation operativa;
- integrazione preview/contract: `riderChain` + action `review_rider_chain`.

Test mirati eseguiti:

- `node tests/deliveryPlannerRiderChainExplanation.test.js`
- `node tests/deliveryPlannerShadowPreview.test.js`
- `node tests/deliveryPlannerShadowPreviewContract.test.js`
- `node tests/deliveryPlannerShadowPreviewGrouping.test.js`
- `node tests/deliveryPlannerShadowLiveReadOnly.test.js`
- `node tests/deliveryPlannerShadowPreviewEndpoint.test.js`
- `node tests/deliveryPlannerShadowReadOnly.test.js`
- `node tests/deliveryPlannerShadowBackupReadOnly.test.js`

Risultato: tutti PASS.

Full suite:

- `for f in tests/*.test.js; do node "$f" || exit 1; done`

Risultato: tutti PASS.

## 6. Safety

- Nessun deploy.
- Nessun push su `main`.
- Nessuna migration applicata.
- Nessuna scrittura DB.
- Nessun ordine creato/modificato/cancellato.
- Nessun cleanup.
- Nessun frontend toccato.
- Nessuna `geo_cache` toccata.
- Nessun CommitWriter collegato.
- Nessuna PII/secrets stampata.

Safety grep scoped:

- PII: match solo negli assert anti-PII del nuovo test.
- Write/network tokens: match solo in commenti/test read-only esistenti.

## 7. Limiti

- Single-rider only.
- Blocker euristico: sceglie il giro precedente il cui rientro stimato coincide con la salida ritardata.
- Non e' un UI/frontend change.
- Non crea bottoni operativi live, solo action read-only nel contract.

## 8. Deployment note

Questo branch locale e' stacked sopra:

- `389da3c` — `ORDER-STATE-TRANSITION-LOGS-40`
- `82504b6` — `SHADOW-PREVIEW-FROZEN-ORDERS-FALSE-CRITICAL-41`

Non deployare direttamente senza strategia:

1. migration + deploy completo dello stack; oppure
2. branch pulito da `bc807b2` con cherry-pick dei soli task shadow-only.

STOP.
