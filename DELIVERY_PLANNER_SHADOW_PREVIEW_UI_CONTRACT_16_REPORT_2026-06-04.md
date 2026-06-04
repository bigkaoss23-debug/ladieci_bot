# Shadow Preview UI Contract 16 Report

Date: 2026-06-04
Task: SHADOW-PREVIEW-UI-CONTRACT-16

## Why This Contract Exists

Shadow Preview now has planner output, diagnostics, operator wording, and grouped operator messages. The future UI needs a stable JSON shape that is safe to render without knowing internal planner details.

This contract is that stable shape. It is not an endpoint and it does not connect the planner to any live UI.

## What It Includes

- Contract version: `shadow-preview-contract-v1`.
- Read-only mode: `mode: "read_only"`.
- Preview status: `ok`, `warning`, or `critical`.
- Source metadata: type, dates, and `readOnly: true`.
- Safe summary counts.
- Grouped operator messages as `groups`.
- Text-only suggested actions for a future UI.
- Safety block with read-only guarantees.

## What It Excludes

- Raw diagnostics.
- Individual `operatorMessages`.
- Customer names.
- Phone numbers.
- Addresses.
- Notes or other personal data.
- Secrets.
- Any executable operation.
- Any database write intent.

## Example JSON

```json
{
  "version": "shadow-preview-contract-v1",
  "mode": "read_only",
  "status": "warning",
  "title": "Vista previa planner",
  "generatedAt": "2026-06-04T12:00:00.000Z",
  "source": {
    "type": "backup_serata",
    "dates": ["2026-05-28"],
    "readOnly": true
  },
  "summary": {
    "totalOrders": 6,
    "deliveryOrders": 3,
    "pickupOrders": 3,
    "zones": ["Q5", "Marina"],
    "warningsCount": 0,
    "differencesCount": 0,
    "groupedMessagesCount": 1
  },
  "groups": [
    {
      "id": "dirty_geo_q5",
      "level": "warning",
      "title": "Q5 / Marina: tiempo estimado poco fiable",
      "message": "2 órdenes usan una estimación no-Google o poco fiable.",
      "operatorHint": "No lo interpretes como retraso real seguro. Verifica cuando el rider vuelve.",
      "count": 2,
      "zones": ["Marina", "Q5"],
      "tags": ["dirty_geo", "low_confidence", "q5"]
    }
  ],
  "actions": [
    {
      "id": "review_before_confirming",
      "label": "Revisar antes de confirmar",
      "type": "manual_check",
      "priority": "medium"
    },
    {
      "id": "check_rider_return",
      "label": "Verificar vuelta del rider",
      "type": "manual_check",
      "priority": "medium"
    }
  ],
  "safety": {
    "readOnly": true,
    "writesEnabled": false,
    "rawDiagnosticsHidden": true,
    "piiIncluded": false
  }
}
```

## Status Rules

The contract does not recalculate status. It passes through the existing preview status:

- `ok`: green invariants and no signals.
- `warning`: diagnostics, warnings, or differences with green invariants.
- `critical`: at least one red invariant.

## Suggested Actions

Actions are text-only hints for a future UI. They are not live buttons and do not perform any operation.

- Dirty geo: `check_rider_return`.
- Oven: `review_oven_load`.
- Critical: `do_not_apply_plan`.
- Warning: `review_before_confirming`.

## Safety Guarantees

- `source.readOnly` is always `true`.
- `safety.readOnly` is always `true`.
- `safety.writesEnabled` is always `false`.
- `safety.piiIncluded` is always `false`.
- Raw diagnostics are not included in the contract.
- The helper is pure and serializable JSON output is tested.

## Tests Passed

Dedicated contract test:

```text
node tests/deliveryPlannerShadowPreviewContract.test.js
22 PASS · 0 FAIL
```

Baseline before this task:

```text
389 PASS · 0 FAIL
```

Full suite after this task:

```text
411 PASS · 0 FAIL
```

## Limits

This task only defines a backend contract/helper and tests it. It does not create an API route, does not render any UI, and does not connect to CommitWriter.

## Next Step

The next safe step is an endpoint-only read-only wrapper that returns this contract, still without UI buttons or write paths.

## Explicitly Not Done

- No endpoint.
- No UI.
- No DB write.
- No deploy.
- No CommitWriter.
- No scheduling core change.
- No push to `main`.
