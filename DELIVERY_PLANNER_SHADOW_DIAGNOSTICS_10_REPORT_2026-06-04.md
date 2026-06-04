# Delivery Planner Shadow Diagnostics 10 Report — 2026-06-04

Task: `SHADOW-DIAGNOSTICS-DIRTY-GEO-OVEN-10`

## Perché servono queste diagnostiche

I report shadow mostrano differenze tra il baseline storico e il planner V2. Alcune differenze sono veri segnali operativi, altre dipendono da input storici sporchi. Senza etichette dedicate, un dato Q5/Marina gonfiato da fallback non-Google può sembrare un problema di scheduling o una prova a favore del multi-rider.

Questa patch aggiunge diagnostica read-only nel reporting layer, senza cambiare la logica core del planner.

## Cosa risolvono

### `dirty_geo_timing`

Evidenzia ordini con durata potenzialmente sporca quando:

- `geo_source` è `cache-street`;
- manca `geo_source`, manca `durata_google_min` e `durata_haversine_min` è alta;
- Q5/Marina ha `andata_min >= 20` con source non-Google.

La diagnostica serve a distinguere un ritardo reale da una durata storica non affidabile.

### `global_oven_slot_warning`

Evidenzia slot forno saturi usando `plan.ovenLoad`, quindi contando anche i ritiri. Questo rende visibile il caso in cui il forno è già pieno anche senza delivery nello stesso slot.

Soglie default:

- 5/4 pizze: `forno_soft_overload`;
- 6-7/4 pizze: `forno_overload_serio`;
- 8+/4 pizze: `forno_pieno`.

## Interpretazione Q5/Marina

Q5/Marina con Google fresh resta compatibile con `andata_min` circa 10-14 e round trip circa 30 minuti. Q5/Marina con `cache-street` e `andata_min` 26-28 viene marcato come possibile dato storico sporco. La diagnostica non dice che il planner ha sbagliato: segnala che l'input merita cautela.

## Forno globale da ritiri

I ritiri occupano forno come i delivery. Prima il warning risultava più leggibile quando un delivery cadeva nello slot saturo. Ora il report shadow espone anche lo slot saturo da soli ritiri, così il carico forno globale è visibile senza spostare ordini.

## Implementazione

La diagnostica vive in `scripts/deliveryPlannerShadowReadOnly.js`:

- `collectDirtyGeoDiagnostics`;
- `collectOvenSlotDiagnostics`;
- `collectDiagnostics`.

I runner shadow aggiungono il campo `diagnostics` al report. Il backup runner propaga `diagnostics` e `diagnosticsCount` nel formato safe.

## Test passati

Il test dedicato `tests/deliveryPlannerShadowDiagnostics.test.js` copre:

- Q5 dirty `cache-street`;
- Q5 clean Google;
- Q5 `andata_min >= 20` non-Google;
- Q1 alta non marcata automaticamente come Q5/Marina dirty;
- slot forno 5/4, 6-7/4, 8+/4;
- slot saturo da soli ritiri;
- assenza PII nell'output;
- `shadow_ok` invariato;
- nessun accesso DB/rete/env nel nuovo test/helper.

## Limiti

- La diagnostica non corregge dati geo sporchi.
- Non ricalcola durate Google.
- Non cambia aggregazione, `forno_out`, `salida`, `entrega`, `retraso` o `verdict`.
- Non introduce multi-rider.
- Non sostituisce una futura pulizia di `geo_cache`.

## Safety

- Nessuna logica core scheduling pesante modificata.
- Nessun DB.
- Nessun Supabase.
- Nessun deploy.
- Nessun endpoint.
- Nessun frontend.
- Solo reporting layer e test offline.

## Prossimo step

Usare i nuovi `diagnostics` nei prossimi report shadow backup/live per leggere separatamente:

- differenze legate a input geo sporchi Q5/Marina;
- carico forno globale causato anche dai ritiri.
