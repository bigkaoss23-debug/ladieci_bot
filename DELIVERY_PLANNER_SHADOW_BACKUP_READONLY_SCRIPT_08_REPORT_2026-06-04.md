# DELIVERY PLANNER — SHADOW BACKUP SERATA READ-ONLY (script)

**Task:** `SHADOW-BACKUP-SERATA-SCRIPT-08`
**Data:** 2026-06-04
**Repo:** `/Users/bigart/Downloads/ladieci-bot` (backend canonico)
**Branch locale:** `main` · **HEAD pre-commit:** `aa6d723`
**origin/main:** `9bddf42` (NON toccato)

---

## 1. Cosa è stato creato

Consolidamento nel repo dello script temporaneo (`/tmp`) usato nel task 07, ora
stabile e testato:

- `scripts/deliveryPlannerShadowBackupReadOnly.js` — runner CLI read-only su `backup_serata`.
- `tests/deliveryPlannerShadowBackupReadOnly.test.js` — 28 check, **zero DB reale**.
- `DELIVERY_PLANNER_SHADOW_BACKUP_READONLY_SCRIPT_08_REPORT_2026-06-04.md` — questo report.

Nessun file esistente modificato (planner core, endpoint, agenti, frontend intatti).

## 2. Perché serve

Il primo live run su `ordenes` (task 06) ha funzionato ma dava 0 righe (fuori servizio).
Per validare il planner rev.5 su **dati reali** senza aspettare il servizio attivo, si
legge l'archivio storico `backup_serata` (serate già concluse). Questo script rende
quell'operazione **ripetibile, testata e priva di PII**.

## 3. Come si usa

```bash
# più serate
railway run --service ladieci_bot --environment production \
  node scripts/deliveryPlannerShadowBackupReadOnly.js \
  --dates 2026-05-28,2026-05-29,2026-05-30,2026-05-31

# singola serata
node scripts/deliveryPlannerShadowBackupReadOnly.js --date 2026-05-31
```

Comportamento:
- legge la tabella public `backup_serata` (una riga per serata, colonna JSON `ordini`)
  con **solo HTTP GET**; se più righe per la stessa data, sceglie la più ricca e segnala `ambiguous`;
- rigioca gli ordini archiviati come **MOVIBILE** (`estado:"NUEVO"`) a `now=19:00`
  (parità con la suite multi-snapshot AB);
- `forno_out` archiviato usato **solo come baseline** (mai input);
- senza env → `executed_live:false, read_only:true` (nessun crash);
- senza `--date`/`--dates` → `{ ok:false, reason:"missing --date or --dates" }`.

**Privacy:** output solo con `orderId`, `tipo`, `zona`, orari, `warning`, `diff`.
Mai `nombre` / `tel` / `direccion` / note.

## 4. Risultati test

`node tests/deliveryPlannerShadowBackupReadOnly.test.js` → **28 PASS · 0 FAIL**.
Coperti: parser `--date`/`--dates`, errore pulito, scelta riga ricca/duplicati,
replay MOVIBILE, derivati solo baseline, **nessuna PII in output**, summary per
data + globale, invariants, zero write methods, no client write-capable, no
side-effect a import-time, env-missing gestito.

Full suite: **233 PASS · 0 FAIL**
(planner 61 · AB 19 · realSnapshot 10 · riderEvents 26 · multiSnapshotAB 40 ·
shadowReadOnly 23 · shadowLiveReadOnly 26 · **shadowBackupReadOnly 28**).

## 5. Risultati run production backup

`executed_live: true` · `read_only: true` · source `backup_serata.ordini (production)`.

| Data | ordini | dom | rit | zones | trips | overlaps | warn | diff | invariants | verdict |
|------|--------|-----|-----|-------|-------|----------|------|------|------------|---------|
| 2026-05-28 | 11 | 7 | 4 | Q1,Q2,Q3,Q5 | 6 | 0 | 1 | 4 | all-green | shadow_ok |
| 2026-05-29 | 29 | 6 | 23 | Q1,Q5 | 6 | 0 | 3 | 5 | all-green | shadow_ok |
| 2026-05-30 | 26 | 6 | 20 | Q1,Q5 | 4 | 0 | 3 | 3 | all-green | shadow_ok |
| 2026-05-31 | 21 | 8 | 13 | Q1,Q5 | 5 | 0 | 1 | 3 | all-green | shadow_ok |

**Aggregato:** 87 ordini · 27 domicilio · 60 ritiro · 15 differences · verdict **`shadow_ok`**.
Riproduce esattamente il risultato del task 07. (Le fixture locali davano 14 diff:
+1 su 05-30 #011, info-level, per lievi scostamenti fixture-vs-live.)

## 6. Safety

- ✅ CLI read-only · ✅ no endpoint · ✅ no CommitWriter · ✅ no UI/preview
- ✅ no deploy · ✅ no DB write · ✅ no Supabase write (solo GET) · ✅ no frontend
- ✅ no push `main` (`origin/main` resta `9bddf42`) · ✅ no PII stampata · ✅ no secrets
- ✅ planner core PURO/isolato · ✅ unico `fetch`/`process.env` nel blocco CLI

## 7. Limiti

- Replay come MOVIBILE a `now=19:00`: non riflette il timing reale intra-serata, ma
  valida il planner su scenari reali.
- Single-rider model: alcune diff +45 min (es. 05-29 #021/#028) restano "giallo noto".
- `backup_serata` è un archivio: non sostituisce la validazione live su `ordenes`
  durante servizio attivo.

## 8. Prossimo step

1. run live su `ordenes` durante servizio attivo (sera) per validare il flusso corrente;
2. decidere single-rider vs multi-rider prima di qualsiasi integrazione;
3. solo dopo, Shadow Preview interna — sempre senza CommitWriter / endpoint / deploy.

---

**STOP.** Nessun passo verso endpoint, preview UI, CommitWriter, deploy o main push.
