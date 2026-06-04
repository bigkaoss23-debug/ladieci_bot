# DELIVERY PLANNER — SYNTHETIC STRESS (offline)

**Task:** `SYNTHETIC-STRESS-PLANNER-09`
**Data:** 2026-06-04
**Repo:** `/Users/bigart/Downloads/ladieci-bot` (backend canonico)
**Branch locale:** `main` · **HEAD pre-commit:** `f297cf8`
**origin/main:** `9bddf42` (NON toccato)

---

## Executive summary

I backup reali coprono male alcuni scenari (e alcuni li coprono con **dati sporchi**:
Q5/Marina `cache-street`, `andata_min` 26–28 senza Google → falsi +45/+48 min). Questo
stress test **sintetico/offline** valida il Delivery Planner rev.5 su 10 scenari
controllati con **dati 100% fake** (nessun cliente, PII, DB, Supabase o rete), così la
correttezza del planner non dipende più solo dai backup vecchi.

File creati:
- `tests/fixtures/deliveryPlannerSyntheticStress.js` — builder ordini fake + helper invarianti.
- `tests/deliveryPlannerSyntheticStress.test.js` — 10 scenari (A–J), 59 check.
- `DELIVERY_PLANNER_SYNTHETIC_STRESS_09_REPORT_2026-06-04.md` — questo report.

**Verdict globale: tutti gli scenari PASS (59/59). Nessun bug rosso.** Planner core
NON modificato.

## Scenari

| Scenario | Scopo | Risultato | Note |
|----------|-------|-----------|------|
| A · Single rider base | sequenziare giri, niente overlap | **PASS** | 3 giri Q1/Q2/Q5, no overlap, no salida<forno_out |
| B · Q5 aggregation realistica | aggregare Marina compatibile, No agregable se tardi | **PASS** | compat → join valido/recommended; tardi → `no_agregable`; round trip ≈ **29 min** |
| C · Q5 dirty geo (cache-street) | riprodurre dato storico sporco | **PASS (gap doc.)** | andata 28 gonfia round trip a **59 min** vs 29 pulito; core non legge `geo_source` → backlog |
| D · Forno overload graduato | soglie soft/serio/hard | **PASS** | 4 ok · 5 `forno_soft_overload` · 6–7 `forno_overload_serio` · 8+ `forno_pieno` |
| E · Ritiro occupa forno | ritiri+delivery condividono capacità | **PASS** | Σ ovenLoad == Σ pizze (8); delivery in slot carico → `forno_pieno` |
| F · After midnight | wrap servizio notturno | **PASS** | no `24:`/`25:`, no clamp falso, timeline coerente |
| G · Rider events | evento reale migliora il futuro | **PASS** | `rider_returned` applicato; semi-congelato NON anticipato sotto la salida committata |
| H · Semi/congelati | congelati non spostati | **PASS** | LISTO/EN_ENTREGA echeggiano forno_out committato; movibile ripianificato |
| I · Manual route multi-zona | rider block unico Q1+Q2+Q5 | **PASS** | 1 block, membri in `BLK:MR1`; nuovo ordine dentro block → separata dopo block / join_block override |
| J · Forzatura operatore | rispetta + segnala forzatura | **PASS** | `forzado` tracciato + reason "forzato" |

## Findings

### 🔴 Bug rossi
- **Nessuno.** Tutte le invarianti universali valgono su tutti gli scenari:
  no `forno_out` impossibile, no `24/25`, no `salida < forno_out`, no rider overlap,
  `entrega = forno_out + andata` (per i giri automatici).

### 🟡 Gialli / prodotto
- **Dato geo sporco non distinguibile nel core (Scenario C):** il planner usa
  `andata_min` come fatto grezzo ma NON consuma `geo_source` / `durata_google_min` /
  `durata_haversine_min`. Un `cache-street` con andata 28 produce un round trip ~59 min,
  identico a una vera saturazione — il planner non può marcarlo come "dato sporco".
  → Non è un bug del planner: è un **dato di input sbagliato**. Conferma che i +45 storici
  Q5 erano dati sporchi, **non** prova che serva multi-rider.
- **Overload forno legato ai giri delivery (Scenario E):** i warning soft/serio/hard
  sono attaccati ai *trip delivery*; uno slot saturo di soli RITIRO occupa il forno
  (conteggiato in `ovenLoad`) ma non emette un warning di trip finché un delivery non
  cade in quello slot. Da valutare se serve un warning forno "globale" indipendente dai giri.

### 📌 Limiti noti
- Single-rider V1 per scelta di prodotto (multi-rider non implementato).
- Lo stress è offline: non sostituisce la validazione live durante servizio attivo.

### 🗂 Backlog (NON implementato ora)
- `dirty_geo_timing` / flag diagnostico nel runner shadow per marcare le differences
  derivanti da `andata_min` non-Google (`geo_source != google*`).
- Warning forno "globale" per slot saturi di soli ritiri.
- Multi-rider (future feature flag).

## Interpretazione Q5/Marina

- I vecchi backup Q5 con `geo_source=cache-street` (andata 26–28, niente Google) sono
  **sporchi**: gonfiano andata+ritorno oltre 45 min (vedi Scenario C: 59 min).
- Con geo Google fresco, Marina/Q5 sta intorno a **~13 min andata → ~30 min round trip**
  (Scenario B: 29 min). È l'ordine di grandezza realistico attuale.
- **V1 resta single-rider.** L'**aggregazione Marina compatibile** è la leva chiave:
  il primo ordine ancora il giro, gli altri Q5 compatibili si aggregano, quelli troppo
  tardi sono `No agregable`. Multi-rider **non** implementato ora (backlog).
- Regola operativa: di fronte a ritardi enormi Q5/Marina nei backup, controllare prima
  `andata_min` + `geo_source` e confrontare con serate recenti.

## Prossimi step

1. **Synthetic PASS → procedere verso shadow live durante servizio attivo** (run su
   `ordenes` la sera) per validare il flusso corrente con dati Google freschi.
2. Se servono micro-patch (es. flag dirty-geo / warning forno globale): aprirle come
   task specifici e mirati, **senza** toccare il core in modo invasivo.
3. **NON** collegare ancora CommitWriter / endpoint / preview UI.

---

**STOP.** Nessun passo verso endpoint, preview UI, CommitWriter, deploy o main push.
