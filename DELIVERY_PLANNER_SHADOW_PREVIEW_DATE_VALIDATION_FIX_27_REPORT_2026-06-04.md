# DELIVERY_PLANNER_SHADOW_PREVIEW — Date Validation Fix (Task 27)

**Fecha:** 2026-06-04
**Repo:** `/Users/bigart/Downloads/ladieci-bot` (backend canonico)
**Endpoint:** `GET /api/delivery/shadow-preview?date=YYYY-MM-DD` (read-only)
**Deploy:** NESSUNO (fix + test + backup branch).

---

## 1. Bug trovato
Durante lo stress esteso (`SHADOW-PREVIEW-PROD-STRESS-EXTENDED-26`):
`date=2026-13-99` → **HTTP 500 `{"error":"Invalid time value"}`**.

Causa: `validateDate()` controllava solo la *forma* `^\d{4}-\d{2}-\d{2}$`. Una data shape-valida ma di calendario impossibile (`2026-13-99`, `2026-02-31`) superava il check, poi `addDays()` → `new Date(...).toISOString()` lanciava `Invalid time value`, intercettato e restituito come 500 (default `statusCode`).

Il 500 era comunque "pulito" (nessuno stacktrace/PII/secret, `readOnly:true`, safety verdi) — quindi problema di **robustezza/status code**, non di sicurezza.

## 2. Fix applicato
`src/core/delivery/shadowPreviewEndpoint.js` — `validateDate()` ora fa un roundtrip ISO dopo il check di forma:

```js
function validateDate(date) {
  if (!date) return "missing_date";
  const s = String(date);
  if (!DATE_RE.test(s)) return "invalid_date";
  const parsed = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "invalid_date";
  if (parsed.toISOString().slice(0, 10) !== s) return "invalid_date";
  return null;
}
```

Comportamento risultante:
- `2026-06-04`, `2026-12-31` → valide (200 contract)
- `2026-13-99` → `invalid_date` (NaN)
- `2026-02-31` → `invalid_date` (roundtrip → 2026-03-03 ≠ input)
- `2026/06/04`, `bad-date` → `invalid_date` (forma)
- missing → `missing_date`

Nessuna modifica al path read-only, alla query DB o al contract. Solo la validazione anticipa il 400 prima del throw.

## 3. Test aggiunti
`tests/deliveryPlannerShadowPreviewEndpoint.test.js`:
- `2d·` loop su `["bad-date","2026/06/04","2026-13-99","2026-02-31"]` → 400 `invalid_date`, con assert su risposta pulita (no stacktrace, `readOnly:true`, `writesEnabled:false`, `piiIncluded:false`).
- `2e·` `2026-12-31` (data futura valida) → 200 contract, `source.date` corretto.

Endpoint test: 24 → **29 PASS · 0 FAIL**.

## 4. Full suite
**440 PASS · 0 FAIL** (era 435, +5 nuovi).

## 5. Safety
- Solo 2 file modificati: endpoint + test.
- Nessun write method / `insert/update/delete/upsert/rpc` / `CommitWriter`.
- Nessuna PII reale: i match sono fixture **fake** nel test (`Persona Inventada`, telefono/indirizzo finti) usate per verificare che la PII NON finisca nel contract.
- Endpoint sempre read-only (GET).

## 6. No deploy
Nessun deploy, nessun push su main, nessun DB write, nessun frontend toccato.

## 7. Prossimo step consigliato
Quando si vuole portare live il fix: deploy backend controllato (push `main` → Railway), con post-deploy smoke che includa `2026-13-99 → 400 invalid_date`. Fino ad allora la produzione mantiene il vecchio comportamento (500 su quell'input contrived), che resta sicuro/read-only.
