# SHADOW-PREVIEW-DIRTY-GEO-RULE-FIX-34 — Report

**Data:** 2026-06-04
**Repo:** `/Users/bigart/Downloads/ladieci-bot` (backend canonico)
**Base:** `9661052` (wording fix -32, non deployato) sopra production `963ff55`

## 1. Audit precedente (-33)
L'audit `SHADOW-PREVIEW-DIRTY-GEO-SOURCE-AUDIT-33` ha trovato che la regola
`collectDirtyGeoDiagnostics` in `scripts/deliveryPlannerShadowReadOnly.js` marcava
**sempre** `geo_source === "cache-street"` come `dirty_geo / low_confidence`, senza
controllare zona o durata.

Caso reale: ordini `#001`/`#002`, entrambi `DOMICILIO Q2`, `EN_COCINA`, durate
realistiche (`andata 8` e `andata 6`), `conflicto_driver:false`,
`retraso_estimado_min:0` — mostravano comunque un warning `dirty_geo`.

`cache-street` (vedi `src/utils/geoResolver.js:121`) è una cache a livello strada
derivata da una geocodifica **Google** della stessa via, spesso "blindata" da
consegne reali — **non** è automaticamente sporca.

## 2. Problema: regola troppo aggressiva
La condizione categorica faceva scattare il warning su qualunque ordine
cache-street, anche Q1/Q2/Q3 con durata bassa e realistica:

```js
const cacheStreet = geoSource === "cache-street";
...
if (!cacheStreet && !fallbackHigh && !q5MarinaFallbackHigh) continue;
```

## 3. Fix applicato
File: `scripts/deliveryPlannerShadowReadOnly.js` (solo diagnostica shadow — il
planner core NON è toccato).

Nuovo helper:

```js
function isFarDeliveryZone(zona) {
  const z = String(zona || "");
  return z === "Q5" || /marina|evershine/i.test(z);
}
```

Regola rilassata: cache-street è sospetta **solo** in zona lontana
(Q5/Marina/Evershine) **oppure** quando la durata è alta (`andata >= 20`):

```js
const farZone = isFarDeliveryZone(zona);
const cacheStreet = geoSource === "cache-street";
const cacheStreetSuspect = cacheStreet && (farZone || (Number.isFinite(andata) && andata >= 20));
const fallbackHigh = !geoSource && googleMin == null && Number.isFinite(haversineMin) && haversineMin >= 20;
const farZoneFallbackHigh = farZone && Number.isFinite(andata) && andata >= 20 && nonGoogle;
if (!cacheStreetSuspect && !fallbackHigh && !farZoneFallbackHigh) continue;
```

`q5Marina` rinominato in `farZone` (include ora Evershine) anche per
`realistic_round_trip_hint_min` e `reason`.

## 4. Test aggiunti
File: `tests/deliveryPlannerShadowDiagnostics.test.js` — nuovo blocco
"Dirty geo · cache-street zone/durata aware" (7 casi):

| Caso | Input | Atteso |
|------|-------|--------|
| A | Q2 cache-street andata 6/hav 8 | **NO** dirty_geo (caso reale #001/#002) |
| B | Q2 cache-street andata 22 | dirty_geo presente |
| C | Q5 cache-street andata 28 | dirty_geo presente |
| C2 | Q5 cache-street andata 9 | dirty_geo presente (zona lontana resta prudente) |
| D | Q5 google andata 13 | **NO** dirty_geo |
| E | source mancante + haversine 21 | dirty_geo presente |
| F | source mancante + haversine 7 | **NO** dirty_geo |

## 5. Esempi end-to-end (preview operatore)
Caso reale Q2 #001/#002 (cache-street, andata 8 e 6) → `buildShadowPreviewForOperator`:

- `status: ok`
- `dirty_geo_timing diagnostics: 0`
- `groups: []`
- `suggestedOperatorActions: []` (niente "Verificar vuelta del rider")
- `keyRisks: []`

Confronto sintesi regola:
- Q2 cache-street 6 → **no warning**
- Q2 cache-street 22 → warning (`Q2: tiempo estimado poco fiable`)
- Q5 cache-street 22/28 → warning (`Q5 / Marina: tiempo estimado poco fiable`)
- Q5 google 13 → **no warning**

## 6. Actions check
La action "Verificar vuelta del rider" deriva da tag `dirty_geo`/`rider_recovery`.
Per il Q2 normale, non essendoci più diagnostic dirty_geo, la action **non compare**
(verificato end-to-end sopra). Resta disponibile solo quando dirty_geo è
legittimamente presente (zone lontane o durate alte) o per recovery rider reale.

## 7. Full suite
**0 FAIL** su tutti i 29 file di test. I file in formato "PASS · FAIL" totalizzano
**454 PASS** (baseline 447 + 7 nuovi casi). Tutti gli altri file (createOrden 30,
driverScheduleSeparation 24, liveSafetyGuards 44, previewOrderTiming 39, ecc.)
riportano 0 failed.

## 8. Safety
- Nessun write path (`insert/update/delete/upsert/rpc`) introdotto.
- Nessun verbo HTTP di scrittura (`POST/PATCH/PUT/DELETE`), nessun `CommitWriter`.
- Nessun accesso DB/rete/env nei test (guardie statiche già presenti, verdi).
- Nessuna PII reale: solo fixture finte (`TEST_DIRTY_*`).
- Planner core, scheduling, driver, calcoli forno/rider **non** toccati.
- Solo diagnostica shadow + test + report.

## 9. No deploy
Nessun deploy, nessun push su main. Solo commit locale + backup branch.

## 10. Prossimo step consigliato
Deployare insieme il wording fix (-32, `9661052`) e questo logic fix (-34), poi
ri-verificare la Shadow Preview live sul caso Q2 reale per confermare `status: ok`
e l'assenza di warning. Opzionale: valutare se la soglia `andata >= 20` vada
calibrata per zona (Q1/Q2 vicine vs Q3 media).
