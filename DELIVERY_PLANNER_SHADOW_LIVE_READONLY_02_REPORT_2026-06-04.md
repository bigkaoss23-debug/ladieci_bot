# DELIVERY PLANNER — SHADOW MODE LIVE READ-ONLY 02

**Task:** `SHADOW-LIVE-SNAPSHOT-READONLY-02`
**Data:** 2026-06-04
**Repo:** `/Users/bigart/Downloads/ladieci-bot` (backend canonico)
**Branch locale:** `main` · **HEAD pre-commit:** `1a2acb1`
**origin/main:** `9bddf42` (NON toccato)

---

## 1. Cosa è stato aggiunto

Primo **shadow mode su snapshot live/read-only**: uno script CLI locale che legge gli
ordini reali da `ordenes` in **sola lettura**, normalizza i fatti grezzi e li passa al
runner shadow già esistente (`runShadow`) che esegue il Delivery Planner rev.5 PURO.

File nuovi:

- `scripts/deliveryPlannerShadowLiveReadOnly.js` — runner CLI live read-only.
- `tests/deliveryPlannerShadowLiveReadOnly.test.js` — 26 check, **zero DB reale**.
- `DELIVERY_PLANNER_SHADOW_LIVE_READONLY_02_REPORT_2026-06-04.md` — questo report.

Nessun file esistente è stato modificato (planner core, endpoint, agenti, frontend intatti).

## 2. Come funziona

```bash
node scripts/deliveryPlannerShadowLiveReadOnly.js --date 2026-06-04
# opz: --today | --now HH:MM | --limit N | --md <path>
```

Pipeline:

1. `parseArgs` legge `--date` / `--today` / `--now` / `--limit` / `--md`;
2. `httpGet("ordenes", "select=*&order=ts.desc&limit=N")` — **solo GET**;
3. `filterByDate` tiene solo le righe del giorno richiesto (da `created_at`/`ts`);
4. `normalizeDbRow` estrae i **fatti grezzi** e calcola `n_pizze` da `items`
   (escludendo bevande/dessert/riga "Entrega a domicilio", parità con `agentCucina`);
5. `runShadowFromRows` costruisce la fixture-snapshot e chiama `runShadow` (planner puro);
6. stampa il report JSON su stdout (+ markdown solo se `--md`).

La logica pura (parse / normalize / build / run) è **esportata e testabile senza rete**;
la rete è toccata **solo** nel blocco CLI.

## 3. Come garantisce read-only

- **HARD READ-ONLY GUARD**: l'unico accesso DB è `httpGet` con `method: "GET"`.
  Nessun metodo di scrittura è definito o raggiungibile (no POST/PATCH/PUT/DELETE, no RPC).
- **NON importa** il client live write-capable `src/utils/supabase.js` (che espone upsert/update/delete/insert).
- **Nessun side-effect a import-time**: senza env non tocca nulla.
- Se mancano `SUPABASE_URL`/`SUPABASE_KEY` → non forza: riporta "runner pronto, live non eseguito".
- Il **core planner resta PURO/offline**; lo script non è importato da runtime live.
- Test dedicati verificano l'assenza dei token di scrittura nello script.

## 4. Campi letti dal DB (`ordenes`)

**Fatti grezzi → input planner:**
`id`, `tipo_consegna`, `estado` (reale: freeze reale), `zona`, `hora`,
`durata_andata_min`→`andata_min`, `items`→`n_pizze`, `manual_giro_id`, `forzado`, `created_at`/`ts`.

**Derivati → SOLO baseline di confronto, MAI input** (strip nel runner):
`forno_out` (→ `forno_out_db`), `salida_driver_estimada`, `entrega_estimada`,
`retraso_estimado_min`, `conflicto_driver`.

Regola madre rispettata: **il derivato non alimenta mai il derivato.**
Campi mancanti → fallback prudente (`andata_min=null`, `n_pizze=0`) segnalabile nel report.

## 5. Test passati

| Test | Esito |
|------|-------|
| deliveryPlanner | 61 PASS |
| deliveryPlannerAB | 19 PASS |
| deliveryPlannerRealSnapshot | 10 PASS |
| deliveryPlannerRiderEvents | 26 PASS |
| deliveryPlannerMultiSnapshotAB | 40 PASS |
| deliveryPlannerShadowReadOnly | 23 PASS |
| **deliveryPlannerShadowLiveReadOnly** | **26 PASS** |
| **TOTALE** | **205 PASS · 0 FAIL** |

## 6. Output live (se eseguito)

Tentata prova read-only `--date 2026-06-04`. **Env Supabase NON configurato in locale**
→ live SELECT **non eseguito** (per design, nessun forcing):

```json
{
  "executed_live": false,
  "read_only": true,
  "reason": "env mancante: runner pronto, live non eseguito",
  "date": "2026-06-04",
  "now": "13:30"
}
```

Il runner è **pronto**: appena disponibili `SUPABASE_URL`/`SUPABASE_KEY` (ambiente
Railway o `.env` locale di sola lettura) produrrà il report shadow completo
(summary, zone, warnings, differences, invarianti, verdict) come la versione fixture.

## 7. Limiti

- Live SELECT non ancora eseguito (env mancante in locale) → A/B su dati live reali
  ancora da fare.
- Mapping `--date` → giorno: filtro client-side su `created_at`/`ts`; il "service day"
  serale a cavallo di mezzanotte è approssimato dalla data calendario della riga.
- `now` di default = ora Madrid corrente; per snapshot storici usare `--now`.
- `n_pizze` ricostruito da `items` con le stesse esclusioni del conteggio cucina.

## 8. Rischi residui

- Il baseline `forno_out` è esso stesso un derivato della vecchia logica: usato solo
  per confronto, mai come verità.
- Single-rider vs multi-rider e manual route reali restano aperti (come task 01).
- Necessario validare i nomi colonna su schema reale alla prima esecuzione live.

## 9. Prossimo step consigliato

1. eseguire una **prova live read-only** in ambiente con env (Railway o `.env` locale),
   su una serata con ordini, e allegare l'output al report;
2. confrontare le differences live vs baseline DB per validare il planner sul reale;
3. solo dopo, valutare un orchestratore shadow schedulato (sempre read-only, mai write,
   mai endpoint).

---

### Conferme di sicurezza

- ❌ no endpoint · ❌ no deploy · ❌ no DB write · ❌ no Supabase write
- ❌ no frontend · ❌ no push `main` · ❌ no CommitWriter · ❌ no preview UI
- ✅ planner ancora isolato · ✅ shadow live solo CLI locale/read-only
- ✅ `origin/main` resta `9bddf42`
