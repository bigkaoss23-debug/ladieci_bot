# Delivery Planner Shadow Preview Internal 13 Report — 2026-06-04

Task: `SHADOW-PREVIEW-INTERNAL-READONLY-13`

## Perché nasce

Il planner e gli shadow runner producono dati tecnici: invariants, warnings, differences e diagnostics. Sono utili per sviluppo e audit, ma non sono una vista leggibile per un operatore. Questo task crea un oggetto di preview interno, read-only, che compone summary tecnico e wording operativo.

## Cosa produce

Il nuovo helper `src/core/delivery/shadowPreview.js` espone:

- `buildShadowPreviewForOperator(shadowOutput)`.

Output principale:

- `status`;
- `title`;
- `summary`;
- `operatorMessages`;
- `keyRisks`;
- `suggestedOperatorActions`;
- `rawDiagnosticsHidden: true`;
- `readOnly: true`.

## Esempio output

```json
{
  "status": "warning",
  "title": "Vista previa planner",
  "summary": {
    "totalOrders": 12,
    "deliveryOrders": 5,
    "pickupOrders": 7,
    "zones": ["Q1", "Q5"],
    "trips": 3,
    "warningsCount": 1,
    "differencesCount": 1,
    "diagnosticsCount": 1
  },
  "operatorMessages": [
    {
      "level": "warning",
      "title": "Tiempo estimado poco fiable",
      "message": "Este pedido Q5/Evershine usa una estimación no-Google o fallback. El tiempo puede estar inflado respecto a la realidad.",
      "operatorHint": "No lo interpretes como retraso real seguro. Si es posible, verifica con el rider o usa el evento \"rider volvió\".",
      "tags": ["dirty_geo", "q5", "low_confidence"]
    }
  ],
  "keyRisks": [
    {
      "type": "dirty_geo",
      "label": "Tiempo estimado poco fiable",
      "severity": "warning"
    }
  ],
  "suggestedOperatorActions": ["Verificar vuelta del rider"],
  "rawDiagnosticsHidden": true,
  "readOnly": true
}
```

## Status rules

- `ok`: invariants verdi, nessuna diagnostic/warning/difference.
- `warning`: diagnostics, warnings o differences presenti con invariants verdi.
- `critical`: almeno una invariant rossa, per esempio `noDriverBeforePizza=false`, `noInvalidTimeFormat=false` o rider overlap.

Forno 8+/4 resta `warning` a livello preview, perché questa preview non blocca automaticamente il piano; il rischio specifico può essere `high`.

## Come usa diagnostic wording

La preview usa `formatShadowDiagnosticsForOperator` da `diagnosticWording.js`. Le diagnostics tecniche non vengono esposte come raw object nell'output. L'operatore vede messaggi in spagnolo semplice, per esempio:

- `Tiempo estimado poco fiable`;
- `Rider reajustable cuando vuelve`;
- `Horno lleno`.

## Cosa NON fa

- Non collega nulla alla UI.
- Non crea endpoint.
- Non scrive DB.
- Non usa Supabase.
- Non deploya.
- Non collega CommitWriter.
- Non modifica frontend.
- Non cambia scheduling core.
- Non modifica il piano.

## Test passati

Nuovo test:

- `tests/deliveryPlannerShadowPreview.test.js`

Copre:

- status `ok`, `warning`, `critical`;
- dirty geo;
- dirty geo recovery;
- forno 5/4 e 8+/4;
- invariant rosse;
- privacy/no PII;
- raw diagnostics nascosti;
- conteggi summary;
- suggested actions;
- helper puro senza DB/network/env;
- nessun import endpoint/frontend;
- input originale non mutato;
- fallback senza diagnostics.

## Limiti

La preview è un oggetto locale read-only. Non decide, non committa e non sposta ordini. Serve come base per una futura Shadow Preview interna.

## Prossimo step

Usare questo formatter in una preview interna controllata, mantenendo separati:

- osservabilità shadow;
- wording operatore;
- azioni live/commit reali.
