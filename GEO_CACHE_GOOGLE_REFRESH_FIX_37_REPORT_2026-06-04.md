# GEO-CACHE-GOOGLE-REFRESH-FIX-37 — Report

**Data:** 2026-06-04 · **Repo:** `/Users/bigart/Downloads/ladieci-bot` · **Base:** `b8806a6`

## 1. Problema (da audit -36)
Ordine live `#003`: zona **Q5**, `geo_source=cache-street`, `durata_andata_min=10`,
`durata_google_min=null`, `durata_haversine_min=19`. Google era abilitato
(`GEO_PROVIDER="shadow"`, `GOOGLE_MAPS_API_KEY` presente) ma **non è stato chiamato**.

## 2. Causa (early return)
In `src/utils/geoResolver.js` il fallback "stessa via" (`loadFromCache`) ritorna un hit
`source=cache-street` con la durata di un **vicino** sulla stessa strada (durata NON null).
`enrichDurataFromGoogle` aveva l'early return:

```js
if (!hit || hit.durataAndataMin != null) return hit;   // durata già presente → niente Google
```

→ Distance Matrix mai chiamato, provenienza Google persa (`durata_google_min=null`), e la
Shadow Preview deve avvisare. Il fix precedente `google-from-cache-street` copriva **solo**
il caso `cache-street` con durata **NULL**.

## 3. Fix applicato
`enrichDurataFromGoogle` ora rinfresca anche `cache-street` con durata **NON null**, ma
**solo per zone lontane** (Q5/Marina/Evershine). Aggiunto helper locale `isFarDeliveryZone`
(semantica allineata a quella del shadow runner usata dalla regola dirty_geo).

```js
function isFarDeliveryZone(zona) {
  const z = String(zona || "");
  return z === "Q5" || /marina|evershine/i.test(z);
}

async function enrichDurataFromGoogle(direccion, hit, googleEnabled) {
  if (!hit) return hit;
  if (hit.lat == null || hit.lon == null) return hit;   // no coords → no DM
  if (!googleEnabled) return hit;                        // provider off → haversine

  const source = String(hit.source || "").toLowerCase();
  const refreshFarCacheStreet =
    source === "cache-street" && hit.durataAndataMin != null && isFarDeliveryZone(hit.zona);

  if (hit.durataAndataMin != null && !refreshFarCacheStreet) return hit;

  const dm = await googleDistanceMatrix(hit.lat, hit.lon);
  if (!dm.ok) return hit;                                // ko → durata INVARIATA (cache o null→haversine)
  const enrichedSource = `google-from-${hit.source || "cache"}`;
  await saveToCache(direccion, { zona: hit.zona, lat: hit.lat, lon: hit.lon,
    durataAndataMin: dm.durataMin, source: enrichedSource });
  return { ...hit, durataAndataMin: dm.durataMin, source: enrichedSource };
}
```

Comportamento risultante:
- **Q5/Marina/Evershine + cache-street + durata non null + Google ON** → Google DM ritentato;
  successo → `source=google-from-cache-street`, durata Google, `durata_google_min` valorizzata
  (buildResult, perché source include "google"), backfill esatto.
- **Google fallisce** → resta `cache-street`, durata precedente invariata, nessun crash.
- **Q1/Q2/Q3 + cache-street durata non null** → INVARIATO: Google non chiamato, resta cache-street.
- **cache-street/null durata** → invariato (coperto da prima).
- **exact `google`/`nominatim` hit con durata** → invariato (non è cache-street → no refresh).

Nessuna nuova scrittura: la persistenza usa l'esistente `saveToCache` (stesso pattern di backfill già in produzione).

## 4. Test aggiunti (`tests/geoResolverEnrich.test.js`, T4–T9)
| Test | Scenario | Atteso |
|---|---|---|
| T4 (A) | Q5 cache-street durata 10, Google OK | DM chiamato; durata→11; source `google-from-cache-street`; backfill |
| T5 (B) | Q1 cache-street durata 2 | Google NON chiamato; resta cache-street/2; no backfill |
| T6 (C) | Q5 cache-street durata 10, Google fallisce | DM tentato; resta cache-street/10; no crash; no backfill |
| T7 (D) | Q5 cache-street durata null, Google OK | comportamento esistente: Google chiamato; durata 11; google-from-cache-street |
| T8 (E) | Q5 exact `google` durata 12 | Google NON ri-chiamato; resta google/12 |
| T9 | `isFarDeliveryZone` | Q5/Marina/Evershine true; Q1/Q2 false |

File `geoResolverEnrich`: 16 → **40 passed, 0 failed**. T1–T3 esistenti invariati e verdi.

## 5. Full suite
**0 fail** ovunque. PASS-format totale **454 PASS · 0 FAIL**; tutti i file RESULT-format (incl. geoResolverEnrich 40) a 0 failed.

## 6. Safety
- Solo 2 file modificati: `src/utils/geoResolver.js`, `tests/geoResolverEnrich.test.js` (+ questo report).
- Nessun nuovo write path (`insert/update/delete/upsert/rpc`, `POST/PATCH/PUT/DELETE`): la refresh-branch riusa `saveToCache` esistente.
- Nessun `CommitWriter`. Nessuna PII reale (test usano hit fittizi/coords, niente indirizzi).
- Nessuna chiamata Google reale nei test (fetch mockato). Nessun DB reale toccato.
- Planner/Shadow Preview UI, flusso ordini/Cocina/Entregas non toccati.

## 7. No deploy
Nessun deploy, nessun push su main. Solo commit locale + backup branch.

## 8. Prossimo step consigliato
Deploy controllato (tipo task -35) di questo fix su Railway, poi verifica live read-only:
un nuovo ordine Q5 con indirizzo che cade in street-fallback dovrebbe ora risultare
`geo_source=google-from-cache-street` con `durata_google_min` valorizzata e, se la stima Google
è realistica, **nessun** warning dirty_geo nella Shadow Preview. Opzionale: persistere un
`google_attempted`/`google_fail_reason` (richiede colonna geo_cache/migration — fuori scope qui).
