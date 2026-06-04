# Delivery Planner Shadow Preview CLI 14 Report — 2026-06-04

Task: `SHADOW-PREVIEW-CLI-READONLY-14`

## Perché nasce

La preview interna esisteva come helper puro, ma serviva un runner CLI read-only per vedere cosa apparirebbe usando backup reali. Questo task collega, solo in locale/CLI, shadow backup output, diagnostics, wording operativo e `buildShadowPreviewForOperator`.

## Cosa produce

Nuovo runner:

- `scripts/deliveryPlannerShadowPreviewReadOnly.js`

Uso:

```bash
node scripts/deliveryPlannerShadowPreviewReadOnly.js --source backup --dates 2026-05-28,2026-05-29
```

Output:

- `executed_live`;
- `read_only`;
- `source`;
- `dates`;
- `preview`.

La preview espone summary, messaggi operatore, rischi chiave e azioni suggerite. Non espone diagnostics grezze.

## Shadow tecnico vs preview operatore

Lo shadow tecnico contiene dati per audit: invariants, warnings, differences, diagnostics.

La preview operatore traduce quei segnali in spagnolo semplice:

- `Tiempo estimado poco fiable`;
- `Horno muy cargado`;
- `Horno lleno`;
- `Verificar vuelta del rider`;
- `Revisar si conviene mover o forzar manualmente`.

## Esempio output

```json
{
  "executed_live": true,
  "read_only": true,
  "source": "backup_serata",
  "dates": ["2026-05-28", "2026-05-29"],
  "preview": {
    "status": "warning",
    "title": "Vista previa planner",
    "summary": {
      "totalOrders": 40,
      "deliveryOrders": 13,
      "pickupOrders": 27,
      "zones": ["Q1", "Q2", "Q3", "Q5"]
    },
    "operatorMessages": [
      {
        "level": "warning",
        "title": "Tiempo estimado poco fiable",
        "operatorHint": "No lo interpretes como retraso real seguro. Si es posible, verifica con el rider o usa el evento \"rider volvió\"."
      }
    ],
    "rawDiagnosticsHidden": true,
    "readOnly": true
  }
}
```

## Test passati

Nuovo test:

- `tests/deliveryPlannerShadowPreviewReadOnly.test.js`

Risultato:

- `16 PASS · 0 FAIL`

Copertura:

- parse CLI `--source backup`;
- errori puliti per source/date mancanti;
- preview da backup fake;
- summary;
- messaggi operatore in spagnolo;
- dirty geo;
- forno;
- invariant critica;
- no PII;
- raw diagnostics nascoste;
- `readOnly`;
- input non mutato;
- fallback `ok`;
- no DB/network/env nei test.

## Production backup run

Comando eseguito:

```bash
railway run --service ladieci_bot --environment production node scripts/deliveryPlannerShadowPreviewReadOnly.js --source backup --dates 2026-05-28,2026-05-29,2026-05-30,2026-05-31
```

Risultato:

- `executed_live: true`;
- `read_only: true`;
- `source: backup_serata`;
- date: `2026-05-28`, `2026-05-29`, `2026-05-30`, `2026-05-31`;
- totale ordini: `87`;
- delivery: `27`;
- ritiri: `60`;
- zone: `Q1`, `Q2`, `Q3`, `Q5`;
- trips: `21`;
- warnings: `8`;
- differences: `15`;
- diagnostics: `34`;
- preview status: `warning`;
- operator messages presenti;
- raw diagnostics non esposte nella preview;
- nessun deploy.

## Safety

- CLI usa GET-only nel blocco `require.main`.
- Test offline senza Railway/Supabase.
- Nessun endpoint.
- Nessun frontend.
- Nessun DB writer.
- Nessun CommitWriter.
- Nessun dato cliente reale nei test.

## Limiti

La CLI produce solo un oggetto preview. Non decide azioni, non modifica ordini, non cambia piano e non scrive stato. Alcuni messaggi possono essere numerosi sui backup storici perché la preview mostra ogni diagnostic trasformata in wording operativo.

## Prossimo step

Valutare una compattazione dei messaggi operatore per la futura preview interna: per esempio raggruppare più `dirty_geo_timing` per zona o più warning forno per fascia oraria.
