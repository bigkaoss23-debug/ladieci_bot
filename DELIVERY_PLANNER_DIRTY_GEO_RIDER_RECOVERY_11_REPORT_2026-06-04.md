# Delivery Planner Dirty Geo Rider Recovery 11 Report — 2026-06-04

Task: `DIRTY-GEO-RIDER-RECOVERY-SPEC-11`

## Perché nasce il task

Nei backup storici Q5/Marina/Evershine compaiono durate molto alte, spesso `andata_min` 26-30 con `geo_source = cache-street` o comunque non-Google. Queste durate possono produrre ritardi apparenti da 45 minuti o più.

La lettura corretta è prudente: quei ritardi non sono automaticamente saturazione reale del rider e non sono una prova che V1 debba diventare multi-rider.

## Cosa abbiamo imparato da Q5/Marina

Con dati più freschi Google/Nominatim, Q5/Marina sta tipicamente attorno a 10-14 minuti di andata, con round trip operativo circa 30 minuti. Quando una stima storica dice 28-30 minuti di sola andata, il report deve trattarla come bassa confidenza.

Il tempo sporco non deve diventare una prigione. Appena abbiamo un evento reale del rider, la timeline futura si riallinea alla realtà.

## Regola Evershine/Marina

Quando arriva un ordine Q5/Marina/Evershine con `andata_min >= 20` e source non-Google, o con `geo_source = cache-street`, il reporting layer marca:

- `dirty_geo_timing`;
- `geo_confidence: low`;
- `estimate_suspect: true`;
- round trip stimato sporco;
- hint realistico Q5/Marina circa 30 minuti.

Se nel report è presente anche un evento reale del rider, viene aggiunto `dirty_geo_recovery`: significa che l'evento `rider_returned` / `rider_available` deve riallineare il futuro, senza trattare la stima sporca come vincolo permanente.

## Test eseguiti

Nuovo test: `tests/deliveryPlannerDirtyGeoRecovery.test.js`.

Copre:

- Evershine/Q5 `cache-street` marcato come `dirty_geo_timing`;
- `geo_confidence: low` e `estimate_suspect: true`;
- round trip sporco 59 minuti con hint realistico 30;
- `dirty_geo_recovery` quando arriva `rider_returned`;
- il delivery parte comunque;
- senza evento reale un ordine futuro resta legato alla simulazione lunga;
- con `rider_returned` l'ordine futuro usa la disponibilità reale;
- il passato/semi-congelato non viene anticipato.

## Cosa è implementato ora

Solo diagnostica/reporting layer in `scripts/deliveryPlannerShadowReadOnly.js`.

È stato aggiunto:

- arricchimento di `dirty_geo_timing` con confidenza e round trip;
- diagnostica `dirty_geo_recovery` quando c'è evento reale del rider;
- pass-through di `driver_events` e `driver_status` nel runner shadow, per testare il comportamento già supportato dal planner.

## Cosa resta backlog

- UI/operator copy dedicata.
- Eventuale pulizia o rigenerazione di `geo_cache`.
- Eventuale fetch Google fresh prima di consolidare una durata sospetta.
- Eventuale multi-rider, che resta una decisione prodotto futura.

## Perché V1 resta single-rider

Il caso sporco Q5/Marina/Evershine può far sembrare il rider occupato 56-60 minuti. Però, appena arriva il fatto reale `rider_returned`, il futuro può recuperare. Questo conferma che la prima risposta deve essere migliore osservabilità e recupero da evento reale, non multi-rider immediato.

## Cosa NON è stato fatto

- Nessun multi-rider.
- Nessun cap silenzioso tipo “Q5 > 15 allora taglia”.
- Nessuna correzione geocache.
- Nessuna scrittura DB.
- Nessun endpoint.
- Nessun deploy.
- Nessun frontend.
- Nessuna modifica al core scheduling pesante.

## Prossimo step consigliato

Portare queste etichette nel report operativo/preview per far vedere all'operatore:

- “tempo stimato poco affidabile”;
- “il rider si riallineerà quando torna”;
- non “ritardo reale certo 45 minuti”.
