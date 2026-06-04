# Delivery Planner Operational Diagnostics Wording 12 Report — 2026-06-04

Task: `OPERATIONAL-DIAGNOSTICS-WORDING-12`

## Perché serve

Le diagnostics shadow sono utili tecnicamente, ma un operatore non deve leggere campi come `dirty_geo_timing`, `estimate_suspect` o `global_oven_slot_warning` per capire cosa fare. Serve un layer read-only che traduca segnali tecnici in messaggi semplici, senza cambiare scheduling e senza collegarsi alla UI reale.

## Che cosa traduce

Il nuovo helper traduce:

- `dirty_geo_timing`;
- `dirty_geo_recovery`;
- `global_oven_slot_warning`;
- diagnostics sconosciute con fallback generico.

Input: diagnostics/warnings già prodotti dal reporting layer.

Output: oggetti operativi con:

- `level`;
- `title`;
- `message`;
- `operatorHint`;
- `tags`.

## Lingua scelta

La lingua scelta è spagnolo semplice, perché la futura Shadow Preview operativa sarà usata in pizzeria/operazioni in Spagna.

Il report tecnico resta in italiano, ma i testi operativi sono pronti per un operatore:

- `Tiempo estimado poco fiable`;
- `Rider reajustable cuando vuelve`;
- `Horno muy cargado`.

## Esempi prima/dopo

Prima:

```json
{
  "type": "dirty_geo_timing",
  "geo_confidence": "low",
  "estimate_suspect": true
}
```

Dopo:

```json
{
  "level": "warning",
  "title": "Tiempo estimado poco fiable",
  "message": "Este pedido Q5/Evershine usa una estimación no-Google o fallback. El tiempo puede estar inflado respecto a la realidad.",
  "operatorHint": "No lo interpretes como retraso real seguro. Si es posible, verifica con el rider o usa el evento \"rider volvió\".",
  "tags": ["dirty_geo", "q5", "low_confidence"]
}
```

Prima:

```json
{
  "type": "dirty_geo_recovery",
  "rider_available_from": "20:30"
}
```

Dopo:

```json
{
  "level": "info",
  "title": "Rider reajustable cuando vuelve",
  "message": "La estimación inicial puede estar sucia, pero cuando el rider vuelve el futuro se recalcula con su disponibilidad real.",
  "operatorHint": "El dato sucio puede afectar una previsión, pero no debe bloquear toda la noche.",
  "tags": ["rider_recovery", "dirty_geo", "future_replan"]
}
```

## Cosa NON fa

- Non collega nulla alla UI.
- Non crea endpoint.
- Non scrive DB.
- Non usa Supabase.
- Non deploya.
- Non modifica frontend.
- Non cambia scheduling core.
- Non implementa multi-rider.
- Non corregge `geo_cache`.

## Test passati

Nuovo test:

- `tests/deliveryPlannerDiagnosticWording.test.js`

Copertura:

- dirty geo titolo corretto;
- dirty geo comunica tempo stimato poco affidabile;
- dirty geo non comunica ritardo certo;
- rider recovery comunica ritorno/riallineamento futuro;
- rider recovery non promette di riscrivere il passato;
- oven 5/4, 6-7/4, 8+/4;
- fallback sconosciuto;
- batch formatter;
- no PII;
- helper puro senza DB/network/env;
- wording in spagnolo semplice.

## Limiti

Il wording non decide azioni operative. Non sposta ordini e non forza scelte. È un layer di traduzione per preparare una futura Shadow Preview interna.

## Prossimo step

Quando si creerà una preview interna, usare questo helper per mostrare all'operatore messaggi chiari invece di diagnostics tecniche grezze.
