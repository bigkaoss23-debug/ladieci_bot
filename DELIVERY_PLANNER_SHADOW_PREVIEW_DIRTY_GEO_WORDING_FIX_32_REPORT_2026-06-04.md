# DELIVERY_PLANNER_SHADOW_PREVIEW — Dirty-Geo Wording Fix (Task 32)

**Fecha:** 2026-06-04
**Repo:** `/Users/bigart/Downloads/ladieci-bot` (backend canonico)
**Tipo:** solo wording/presentazione. Nessun cambio a planner core / scheduling / timing / driver logic.
**Deploy:** NESSUNO (fix + test + backup branch).

---

## 1. Bug trovato
Nel test reale FASE 6 due ordini reali **DOMICILIO Q2** (`#001`, `#002`, `EN_COCINA`, nessun conflitto rider: `conflicto_driver:false`, `retraso 0`) producevano nella Shadow Preview un gruppo dirty-geo con titolo:

> `Q5 / Marina: tiempo estimado poco fiable`

ma con `zones: ["Q2"]`.

## 2. Perché era fuorviante
Il titolo `Q5 / Marina` era **hardcoded** (`src/core/delivery/shadowPreview.js:153`) e veniva mostrato anche quando le zone reali erano altre (Q2). Il tag storico `q5` (che `diagnosticWording.js` aggiunge sempre al messaggio dirty-geo) sembrava "vincere" sulla zona reale. L'operatore poteva pensare che il problema fosse in Q5/Marina mentre era in Q2. Concetto del warning corretto (low confidence / dirty geo, non ritardo reale), solo testo sbagliato.

## 3. Fix applicato
`src/core/delivery/shadowPreview.js` — il titolo del gruppo dirty-geo è ora **zone-aware**, costruito dalle zone REALI del diagnostico (`item.diagnostic.zona`), non hardcoded. Aggiunti due helper puri:

```js
function formatZoneScopeForDirtyGeo(zones = []) {
  const cleanZones = uniqueSorted((zones || []).filter(Boolean));
  if (cleanZones.length === 0) return "";
  if (cleanZones.length === 1) return cleanZones[0] === "Q5" ? "Q5 / Marina" : cleanZones[0];
  return "Varias zonas";
}
function dirtyGeoTitle(zones = []) {
  const scope = formatZoneScopeForDirtyGeo(zones);
  return scope ? `${scope}: tiempo estimado poco fiable` : "Tiempo estimado poco fiable";
}
```

La zona reale vince sul tag `q5`. Il concetto/severità/hint/actions NON cambiano: resta `level: warning`, hint "No lo interpretes como retraso real seguro", actions `check_rider_return` / `review_before_confirming` invariate.

## 4. Esempi output (verificati)
| zones | titolo |
|---|---|
| `["Q5"]` | `Q5 / Marina: tiempo estimado poco fiable` |
| `["Q2"]` | `Q2: tiempo estimado poco fiable` |
| `["Q1","Q2"]` | `Varias zonas: tiempo estimado poco fiable` |
| `[]` / assente | `Tiempo estimado poco fiable` |

## 5. Test
`tests/deliveryPlannerShadowPreviewGrouping.test.js`:
- Aggiornato test #2 (fixture all-Q5 → alias `Q5 / Marina`; prima mescolava "Q5"+"Marina" come due zone, irrealistico — Marina = zona Q5).
- Aggiunti casi 18–24: Q5→alias, Q2→Q2 (no "Q5 / Marina"), multi→Varias zonas, none→generic, **regressione reale** (tag `q5` presente ma zona Q2 vince), no PII, status resta `warning`.
- Grouping test: 17 → **24 PASS**.

## 6. Full suite
**447 PASS · 0 FAIL** (era 440, +7).

## 7. Safety
Solo 2 file modificati (`shadowPreview.js` + grouping test). Nessun write method / `CommitWriter` / write keyword. PII solo **fake** nelle fixture di test (verifica no-leak). Nessun cambio a endpoint, planner core, driver/timing, frontend, DB.

## 8. No deploy
Nessun deploy, nessun push su main, nessun DB write.

## 9. Prossimo step consigliato
Quando si vuole portare live: deploy backend controllato (push `main` → Railway) e smoke con un ordine reale Q2 dirty-geo per confermare il titolo `Q2: tiempo estimado poco fiable` in produzione. Fino ad allora la produzione mostra ancora il vecchio titolo `Q5 / Marina` (solo cosmetico, nessun impatto operativo/scheduling).
