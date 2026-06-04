# Shadow Preview Endpoint Read-Only 17 Report

Date: 2026-06-04
Task: SHADOW-PREVIEW-ENDPOINT-READONLY-17

## What Was Created

Added a read-only backend bridge for the internal Shadow Preview UI contract.

The implementation is split into:

- `src/core/delivery/shadowPreviewEndpoint.js`: testable response builder and thin handler.
- `index.js`: minimal route registration.
- `tests/deliveryPlannerShadowPreviewEndpoint.test.js`: offline tests with fake rows and mock request/response.

## Endpoint Path

```text
GET /api/delivery/shadow-preview?date=YYYY-MM-DD
```

The endpoint requires a `date` query parameter. Missing or invalid dates return a clean JSON error.

## Auth / Access

The route is mounted under `/api`, so it inherits the existing dashboard API key middleware:

- if `DASHBOARD_API_KEY` is configured, requests must provide `X-Api-Key` or `_k`;
- if no key is configured, local/dev behavior stays unchanged.

No new anonymous public route was added.

## Read-Only Guarantees

- Only GET route registration.
- Runtime DB call uses REST `method: "GET"`.
- The query asks for an explicit non-PII column whitelist.
- No order creation.
- No order modification.
- No CommitWriter.
- No live buttons.
- No frontend connection.
- No deploy.

Selected live columns:

```text
id,tipo_consegna,estado,zona,hora,durata_andata_min,items,manual_giro_id,
forzado,forzado_hora,created_at,geo_source,durata_google_min,
durata_haversine_min,forno_out,salida_driver_estimada,entrega_estimada,
retraso_estimado_min,conflicto_driver
```

Customer name, phone, address, and notes are not requested by the endpoint query and are not included in the response.

## Response Contract

The endpoint returns the existing Shadow Preview UI contract:

```json
{
  "version": "shadow-preview-contract-v1",
  "mode": "read_only",
  "status": "warning",
  "title": "Vista previa planner",
  "source": {
    "type": "ordenes",
    "date": "2026-06-04",
    "dates": ["2026-06-04"],
    "readOnly": true
  },
  "summary": {
    "totalOrders": 3,
    "deliveryOrders": 1,
    "pickupOrders": 2,
    "zones": ["Q5"],
    "warningsCount": 1,
    "differencesCount": 0,
    "groupedMessagesCount": 2
  },
  "groups": [
    {
      "id": "dirty_geo_q5",
      "level": "warning",
      "title": "Q5 / Marina: tiempo estimado poco fiable",
      "message": "1 orden usa una estimación no-Google o poco fiable.",
      "operatorHint": "No lo interpretes como retraso real seguro. Verifica cuando el rider vuelve.",
      "count": 1,
      "zones": ["Q5"],
      "tags": ["dirty_geo", "low_confidence", "q5"]
    }
  ],
  "actions": [
    {
      "id": "review_before_confirming",
      "label": "Revisar antes de confirmar",
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

## Tests Passed

Dedicated endpoint test:

```text
node tests/deliveryPlannerShadowPreviewEndpoint.test.js
24 PASS · 0 FAIL
```

Baseline before this task:

```text
411 PASS · 0 FAIL
```

Full suite after this task:

```text
435 PASS · 0 FAIL
```

## What It Does Not Do

- It does not deploy.
- It does not write DB.
- It does not write Supabase.
- It does not create or modify orders.
- It does not connect CommitWriter.
- It does not create frontend UI.
- It does not add live buttons.
- It does not change scheduling core.

## Residual Risks

The endpoint is not deployed in this task. Before a future deployment, perform one authenticated staging/local smoke test against live read-only data and verify the response has no PII.

## Next Step

Next safe step: local authenticated smoke through the running backend, then deploy only after confirming the endpoint returns the contract and no write path exists.
