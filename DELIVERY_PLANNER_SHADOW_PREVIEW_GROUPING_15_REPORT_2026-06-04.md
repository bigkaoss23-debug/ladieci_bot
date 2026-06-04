# Shadow Preview Message Grouping 15 Report

Date: 2026-06-04
Task: SHADOW-PREVIEW-MESSAGE-GROUPING-15

## Why

Shadow Preview already produced operator-safe messages, but noisy nights could repeat the same kind of warning many times. This pass adds a compact internal grouping layer so a future UI can show fewer, clearer operator messages without losing the original individual messages.

## Operational Noise Problem

The old preview shape kept every operator message flat. On real backup data for 2026-05-28 through 2026-05-31, the preview produced 34 individual operator messages. The new `groupedOperatorMessages` layer reduced those to 4 grouped messages while preserving `operatorMessages` for traceability.

## Grouping Rules

- Dirty geo timing messages are grouped into one `dirty_geo` group.
- Rider recovery messages are grouped into one `rider_recovery` group.
- Oven warnings are grouped by severity: `hard`, `serious`, and `soft`.
- Unknown planner messages fall back into one `planner` group.
- Groups are sorted by severity first: critical/high, then warning, then info.

## Example Grouped Messages

Dirty geo:

```json
{
  "groupType": "dirty_geo",
  "level": "warning",
  "title": "Q5 / Marina: tiempo estimado poco fiable",
  "message": "3 órdenes usan una estimación no-Google o poco fiable.",
  "operatorHint": "No lo interpretes como retraso real seguro. Verifica cuando el rider vuelve."
}
```

Oven:

```json
{
  "groupType": "oven",
  "level": "warning",
  "title": "Horno: 2 franjas muy cargadas",
  "message": "Hay 2 franjas con más pizzas que la capacidad nominal, contando también los retiros.",
  "operatorHint": "Revisa si conviene mover o forzar manualmente.",
  "severity": "serious"
}
```

Rider recovery:

```json
{
  "groupType": "rider_recovery",
  "level": "info",
  "title": "Rider reajustable cuando vuelve",
  "message": "El sistema puede recalcular los próximos pedidos cuando el rider vuelva.",
  "operatorHint": "El pasado no se reescribe; el futuro se ajusta con la disponibilidad real."
}
```

## Tests Passed

New test:

```text
node tests/deliveryPlannerShadowPreviewGrouping.test.js
17 PASS · 0 FAIL
```

Full suite:

```text
389 PASS · 0 FAIL
```

Baseline before this change was:

```text
372 PASS · 0 FAIL
```

## Production Backup Preview Run

Command:

```text
railway run --service ladieci_bot --environment production node scripts/deliveryPlannerShadowPreviewReadOnly.js --source backup --dates 2026-05-28,2026-05-29,2026-05-30,2026-05-31
```

Result:

- `executed_live: true`
- `read_only: true`
- `status: warning`
- `operatorMessages: 34`
- `groupedOperatorMessages: 4`
- Summary: 87 total orders, 27 delivery, 60 pickup, 21 trips, 34 diagnostics.

Grouped production preview:

- Oven hard: 2 full oven slots.
- Oven soft: 4 slightly overloaded slots.
- Oven serious: 6 heavily loaded slots.
- Dirty geo: 22 estimated/non-Google timing signals.

## What Was Not Done

- No deploy.
- No frontend change.
- No endpoint change.
- No scheduling core change.
- No database write.
- No Supabase write.
- No push to `main`.

## Limits

This is an internal preview shape only. The grouping layer does not decide delivery plans and does not alter planner scheduling behavior. It only summarizes already-generated operator messages.

## Next Step

Next task can wire `groupedOperatorMessages` into the future Shadow Preview UI, still keeping individual `operatorMessages` available behind an expanded/details view.
