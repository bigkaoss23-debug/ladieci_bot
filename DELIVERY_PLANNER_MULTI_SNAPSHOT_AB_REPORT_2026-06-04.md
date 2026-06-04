# Delivery Planner rev.5 — Multi-Snapshot A/B Stress Report (2026-06-04)

Read-only A/B forense del planner isolato `src/core/delivery/planner.js` (rev.5) contro la
baseline reale persistita, su **4 serate consecutive** (28→31 maggio 2026) estratte da
`backup_serata.ordini` (solo `SELECT`, nessuna scrittura, nessun consumer live).

> Metodo: gli ordini archiviati (RETIRADO) sono ripianificati come **fatti grezzi**
> (estado NUEVO, `now=19:00`). La baseline vecchia usa il `forno_out` **realmente
> persistito**; `salida/entrega/retraso/conflicto` erano `null` nel backup → il lato
> vecchio di quei campi è **ricostruito** con le funzioni pure di `zones.js`
> (`computeDriverFields`). Regola madre: il derivato non alimenta mai il derivato.

---

## Executive summary

- **Snapshot testati:** 2026-05-28, 2026-05-29, 2026-05-30, 2026-05-31 (consecutive).
- **Totale ordini:** 87 — **domicilio 27**, **ritiro 60**.
- **Zone coinvolte:** Q1, Q2, Q3, Q5.
- **Dopo mezzanotte:** 3 (Q5 del 05-31).
- **Manual giros / rider block reali:** **0** in tutte le serate (limite dei dati,
  non del planner; coperto solo da unit/fixture sintetiche).
- **PASS/FAIL globale:** **40/40 invarianti PASS** sul multi-snapshot; suite completa
  **156 PASS / 0 FAIL** (61 + 19 + 10 + 26 + 40).
- **Regressioni:** **nessuna rossa.** Tutte le divergenze sono spiegabili da regole
  nuove esplicite (capacità forno soft/hard, buffer 3, modello single-rider).
- **Miglioramenti chiari:** capacità forno modellata e *visibile*; ritardi reali Q5
  non più nascosti; aggregazione cluster corretta (I8) confermata sul dato reale;
  nessun `forno_out` impossibile / nessun overlap rider su 87 ordini.
- **Punti dubbiosi (gialli):** modello **single-rider** che su serate Q5-pesanti
  (05-29) fa emergere retrasos grandi (45–48′); soglia soft 5/4; promessa-slot vs precisa.

---

## Tabella per snapshot

| Snapshot | Ordini | Domicilio | Ritiro | Zone | Planner verdict | Problemi |
|----------|------:|--------:|------:|------|-----------------|----------|
| 2026-05-28 | 11 | 7 | 4 | Q1,Q2,Q3,Q5 | ✅ 10/10 invarianti · diff piccole (buffer 3) | nessuno |
| 2026-05-29 | 29 | 6 | 23 | Q1,Q5 | ✅ 10/10 · retrasos grandi (single-rider + 2 Q5 lunghe) | giallo: rider singolo |
| 2026-05-30 | 26 | 6 | 20 | Q1,Q5 | ✅ 10/10 · hard-overload shift reale (cluster Q1 6 pizze) | giallo: 5 pizze slot |
| 2026-05-31 | 21 | 8 | 13 | Q1,Q5 | ✅ 10/10 · soft overload = match DB + after-midnight ok | nessuno |

Invarianti verificate su ognuna (tutte PASS): forno_out valido (no 24:/25:/clamp),
`salida ≥ forno_out`, `entrega−forno_out==andata`, **0 overlap rider**, `conflicto===retraso>0`,
cluster stessa zona/hora condividono forno_out+giro (I8), `delivery_window=[min,max]` reali,
soft/hard overload coerente, warning tutti spiegabili, `Σ ovenLoad == Σ pizze` (ritiri inclusi).

---

## Anomalie della VECCHIA logica trovate

1. **Capacità forno ignorata (over-allocazione silenziosa).** Il `forno_out` persistito
   non considera le pizze dei ritiri nello stesso slot:
   - 05-31, cluster Q1 22:00: DB `21:52` mette **5 pizze** nello slot 21:50 (1 ritiro +4 giro) — soft, ma mai segnalato.
   - 05-30, cluster Q1 20:30 (#003+#008, **6 pizze**): DB `20:22` mette il giro in uno slot già caricato dai ritiri (20:20/20:30) → **8–9 pizze/slot** senza alcun avviso.
2. **Ritardi driver nascosti (campi non persistiti).** `salida/entrega/retraso/conflicto`
   risultano `null` nel backup di tutte e 4 le serate → il conflitto verso il cliente
   non veniva storicizzato. La ricostruzione `computeDriverFields` mostra che la vecchia
   stima dava spesso `retraso 0` anche dove il rider reale era in coda.
3. **Q5 cascade sottostimata.** 05-31 #007: DB `forno_out 01:16` (rider realmente in
   forte ritardo) con ricostruzione vecchia `retraso 76′` su due round-trip separati —
   il nuovo lo aggrega e scende a 17′.

## Anomalie del NUOVO planner trovate

- **Nessuna anomalia rossa.** Nessun `forno_out` impossibile, nessun `24:/25:`, nessun
  clamp falso a `00:00`, nessun `salida<forno_out`, **0 overlap rider** su 87 ordini.
- **Effetto collaterale da segnalare (giallo):** sul 05-29 (2 consegne Q5 lunghe, andate
  18 e 26) il **modello single-rider** sequenzia round-trip da ~40–55′ e fa slittare le
  ultime Q1 di **+45′** (#021, #028). È coerente con UN rider, ma se la pizzeria aveva
  2 rider quella sera il numero è pessimistico → vedi "casi da discutere".

---

## Comportamento nuovo planner (casi importanti)

| Caso | Vecchio (reale/ricostr.) | Nuovo rev.5 | Reason/Warning | Giudizio |
|------|--------------------------|-------------|----------------|----------|
| 05-31 Q1 22:00 ×3 | forno `21:52` (5 pizze slot, silenzioso) | forno `21:52` (uguale!) | `forno_soft_overload` | **migliore** (stesso valore, ma visibile) |
| 05-30 Q1 20:30 ×2 (6 pizze) | forno `20:22` (slot sovraccarico, silenzioso) | forno `20:40` (+shift) | `forno_overload_serio`+`forno_pieno` | **migliore** (capacità reale) |
| 05-31 Q5 #007 | forno `01:16`, retraso ricostr `76′` | forno `00:26`, retraso `17′` | aggregazione Q5 | **migliore** |
| 05-28 Q5 21:00 ×2 (andate 26/28) | forno `20:32` condiviso | forno `20:32` condiviso | — | **uguale** (parità I8) |
| 05-29 Q1 tardi #021/#028 | retraso ricostr `0` | retraso `45′` | single-rider cascade | **dubbio** (dipende da n. rider) |
| 05-28 #010 Q1 22:25 | forno `22:17`, retraso ricostr `19′` | forno `22:36`, retraso `9′` | sequenza rider | **migliore** (retraso minore e onesto) |

---

## Casi da discutere con l'operatore (decisione prodotto)

1. **Modello single-rider.** Il planner assume **un solo rider**. Su serate Q5-pesanti
   (05-29) questo genera retrasos di 45–48′. Domanda: quanti rider reali? Serve supportare
   N rider o "rider availability" multipli? (Oggi mitigabile con `driver_status`/eventi.)
2. **Soft overload 5/4.** Confermare che 5 pizze nello slot = warning morbido senza shift
   (il pizzaiolo recupera in 30–60 s). I dati 05-31/05-30 lo esercitano realmente.
3. **Promessa slot 10 vs precisa.** Le consegne interne entro 10′ non generano falsi
   conflitti; i ritardi veri (Q5) emergono. Confermare che lo slot-10 è il default giusto.
4. **Hard overload 05-30 (cluster 6 pizze → 20:40).** Spostare di +10′ è accettabile o si
   preferisce avvisare e lasciare decidere l'operatore?
5. **Manual route multi-zona / rider block.** Nessun dato reale: prima di shadow mode
   servirebbe almeno una serata con un manual giro vero per A/B.
6. **Ordini semi-congelati.** Non presenti nello storico (tutto RETIRADO): il prudent
   replanning è verificato solo da unit test, non da dato reale.

---

## Verdict finale

- **SAFE per continuare verso shadow mode?** **Sì, con riserva.** Le invarianti tengono
  su 87 ordini reali e 4 serate; nessun caso rosso/bloccante. Lo shadow mode (calcolo in
  parallelo, nessuna scrittura) è il passo giusto per raccogliere il delta su dati live.
- **Serve patch planner prima?** Non bloccante. Da valutare il **multi-rider** prima di
  fidarsi dei retrasos su serate Q5-pesanti.
- **Serve più A/B?** Sì su due fronti mancanti: **manual route reale** e **semi-congelati
  reali** (assenti nello storico).
- **Casi rossi/bloccanti:** **nessuno.**
- **Casi gialli/da discutere:** single-rider, soglia soft 5, hard-shift +10′, slot-10.

---

### Appendice — file e riproducibilità
- Fixture statiche: `tests/fixtures/deliveryPlannerRealSnapshot{20260528,29,30,31}.js`.
- Test: `tests/deliveryPlannerMultiSnapshotAB.test.js` (40 invarianti).
- Run: `node tests/deliveryPlannerMultiSnapshotAB.test.js`.
- Nessuna query live nei test; planner importato solo dai test; nessun DB/deploy/frontend.
