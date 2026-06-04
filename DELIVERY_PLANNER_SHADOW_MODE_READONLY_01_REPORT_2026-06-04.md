# DELIVERY PLANNER — SHADOW MODE READ-ONLY 01

**Task:** `SHADOW-MODE-READONLY-01`
**Data:** 2026-06-04
**Repo:** `/Users/bigart/Downloads/ladieci-bot` (backend canonico)
**Branch locale:** `main` · **HEAD pre-commit:** `c047467`
**origin/main:** `9bddf42` (NON toccato)

---

## 1. Cosa è stato implementato

Primo **shadow mode read-only** del Delivery Planning Orchestrator: un runner locale
che esegue il planner rev.5 *in parallelo* su snapshot grezzi statici e produce un
verdict confrontabile — **senza cambiare alcun comportamento di produzione**.

File:

- `scripts/deliveryPlannerShadowReadOnly.js` — runner puro/offline-safe.
- `tests/deliveryPlannerShadowReadOnly.test.js` — 23 check dedicati.
- `DELIVERY_PLANNER_SHADOW_MODE_READONLY_01_REPORT_2026-06-04.md` — questo report.

Pipeline del runner:

1. riceve uno snapshot **grezzo** (fixture statica `{ fecha, orders, manual_giros, driver }`);
2. **normalizza i FATTI GREZZI** (`hora`, `zona`, `andata_min`, `n_pizze`, `estado`,
   `manual_giro_id`, `forzado`…) e **scarta ogni campo DERIVATO**
   (`forno_out_db`, `estado_db`, `salida/entrega stimate`, `retraso_driver_min`…);
3. esegue `buildPlan(snapshot)` — funzione **pura**;
4. confronta `forno_out` con il baseline DB `forno_out_db` **solo per spiegare** le
   differenze (il baseline NON entra mai come input);
5. calcola le **invarianti rosse** e il `verdict`;
6. restituisce un `shadowVerdict` aggregato. **Non scrive nulla.**

## 2. Perché è read-only

- Il modulo è **puro**: nessun side-effect a import-time.
- **Nessun** `supabase` / `fetch` / `axios` / `process.env` nel runner.
- L'unico `require` nel core-path è il **planner puro**; le fixture (e `fs`) sono
  caricate **solo** nel blocco CLI / nel test.
- Output = solo `stdout` (JSON). **Nessuna** scrittura su file o DB.
- Il planner resta **isolato**: importato solo da test/script, mai da endpoint live.

## 3. Quali fixture usa

Le 4 serate reali consecutive già committate (statiche, read-only da `backup_serata.ordini`):

- `tests/fixtures/deliveryPlannerRealSnapshot20260528.js`
- `tests/fixtures/deliveryPlannerRealSnapshot20260529.js`
- `tests/fixtures/deliveryPlannerRealSnapshot20260530.js`
- `tests/fixtures/deliveryPlannerRealSnapshot20260531.js`

Totale replay: **87 ordini · 27 domicilio · 60 ritiro · zone Q1/Q2/Q3/Q5**.
`now = 19:00`, archiviati ripianificati come `MOVIBILE` (estado `NUEVO`).

## 4. Cosa produce

Per ogni snapshot un report con:

- `summary`: `snapshotDate`, `totalOrders`, `deliveryOrders`, `pickupOrders`, `zones`, `trips`;
- `invariants` (tutte rosse → devono essere `true`):
  - `noImpossibleFornoOut` — `forno_out` valido e `entrega − forno_out == andata`;
  - `noDriverBeforePizza` — `salida ≥ forno_out`;
  - `noRiderOverlap` — timeline rider pulita;
  - `noInvalidTimeFormat` — niente `24:`/`25:`, formato `HH:MM`;
  - `noDerivedInputLeak` — nessun campo derivato finito nell'input;
- `differences[]` — A/B vs DB con `type`, `old`, `planner`, `severity`, `reason`;
- `warnings[]` — globali + per-trip (token noti: `forno_soft_overload`, `forno_overload_serio`, `forno_pieno`…);
- `verdict` — `shadow_ok` / `shadow_red`.

E un `summary` aggregato sulle 4 serate.

## 5. Cosa NON fa

- NON collegato a endpoint / `index.js` / agenti live.
- NON deployato (Railway/Netlify intatti).
- NON scrive DB / NON scrive Supabase / NON crea migration o policy.
- NON cambia UI / frontend.
- NON aggiorna ordini.
- NON usa la preview utente.
- Planner ancora **isolato** (solo test/script).

## 6. Risultati test

Suite completa rilanciata dopo l'aggiunta:

| Test | Esito |
|------|-------|
| `deliveryPlanner` | 61 PASS · 0 FAIL |
| `deliveryPlannerAB` | 19 PASS · 0 FAIL |
| `deliveryPlannerRealSnapshot` | 10 PASS · 0 FAIL |
| `deliveryPlannerRiderEvents` | 26 PASS · 0 FAIL |
| `deliveryPlannerMultiSnapshotAB` | 40 PASS · 0 FAIL |
| `deliveryPlannerShadowReadOnly` | **23 PASS · 0 FAIL** |
| **TOTALE** | **179 PASS · 0 FAIL** |

Verdict shadow su tutte le serate: **`shadow_ok`** · invarianti rosse: **0**.

## 7. Esempi output

Aggregato:

```json
{
  "summary": {
    "snapshots": 4, "totalOrders": 87, "deliveryOrders": 27, "pickupOrders": 60,
    "totalDifferences": 14, "allInvariantsGreen": true, "verdict": "shadow_ok"
  }
}
```

Per serata (sintesi):

```
2026-05-28 | ord 11 dom 7 rit 4 | diff 4 | warn 0 | shadow_ok
2026-05-29 | ord 29 dom 6 rit 23 | diff 5 | warn 3 | shadow_ok
2026-05-30 | ord 26 dom 6 rit 20 | diff 2 | warn 3 | shadow_ok
2026-05-31 | ord 21 dom 8 rit 13 | diff 3 | warn 1 | shadow_ok
```

Differenza spiegata (capacità forno, severità `yellow`):

```json
{
  "orderId": "#011", "zona": "Q1", "type": "oven_capacity",
  "old": "21:27", "planner": "21:46", "retraso": 4,
  "severity": "yellow", "reason": "forno overload serio (rivedere)"
}
```

Warning di serata (2026-05-30, forno sotto stress):

```
AU:Q1|1230: forno_overload_serio
AU:Q1|1230: forno_pieno
AU:Q5|1320: forno_soft_overload
```

## 8. Rischi residui

- **Single-rider vs multi-rider** ancora aperto: alcune differenze (es. +19 min su
  Q1 05-29) derivano dal modello single-rider; nella realtà potevano esserci più rider.
  Lo shadow le marca `yellow`/`info`, non rosse.
- **Manual route / rider block**: capability presente ma **0 manual giros** negli
  snapshot reali → A/B reale ancora mancante.
- **Semi-congelati**: nessun dato reale `EN_COCINA` nelle fixture (replay `NUEVO`).
- Baseline DB `forno_out_db` è esso stesso un derivato della vecchia logica: usato
  solo per confronto, mai come verità.

## 9. Prossimi step sani

1. catturare uno snapshot reale **con** manual giros per chiudere l'A/B manual route;
2. raccogliere casi `EN_COCINA` reali per validare la protezione semi-congelati;
3. decidere single-rider vs multi-rider con dati di presenza rider;
4. **solo dopo**, valutare uno shadow su foto live read-only (adapter DB fuori dal
   core, mai dentro il planner) — sempre senza scrittura e senza endpoint live.

---

### Conferme di sicurezza

- ❌ no deploy · ❌ no DB write · ❌ no Supabase write · ❌ no frontend
- ❌ no push `main` · ❌ no endpoint live · ✅ planner ancora isolato
- ✅ shadow runner solo locale/read-only · ✅ `origin/main` resta `9bddf42`
