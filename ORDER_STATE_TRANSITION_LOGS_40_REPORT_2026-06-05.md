# ORDER-STATE-TRANSITION-LOGS-40

## Preflight

- Repo: `/Users/bigart/Downloads/ladieci-bot`
- Branch iniziale: `main`
- Base iniziale: `bc807b217c7d9db1e3120595bd218548ee09e37d`
- `origin/main`: `bc807b217c7d9db1e3120595bd218548ee09e37d`
- Working tree iniziale: clean
- Produzione: non interrogata per scritture, nessuna migration applicata, nessun deploy.

## Audit

Punti di transizione stato trovati:

- `creaOrdine(...)`: crea ordini WhatsApp/dashboard con stato iniziale, default `POR_CONFIRMAR`.
- `cambiaStato(...)`: punto centrale per `POR_CONFIRMAR`, `EN_COCINA`, `LISTO`, `EN_ENTREGA`, `RETIRADO`, `COMPLETADO` e altri stati.
- Endpoint dashboard in `index.js`: `cambiaStato`, `updateEstado`, `marcarEnEntrega`, `marcarEntregado`.

Colonne legacy gia' usate:

- `hora_salida`
- `hora_entrega`
- `llegado`
- `estado`
- `ts`
- `created_at` e' lasciato alla definizione DB esistente/default.

## Design

Scelta schema:

- Tabella append-only `orden_estado_logs` senza PII.
- `orden_id` e `numero_ordine` sono `text`, senza foreign key hard, per non rompere cleanup/chiusura servizio e per poter mantenere log anche se l'ordine viene archiviato o cancellato.
- Metadata limitata a segnali operativi non-PII.
- Timestamp lifecycle su `ordenes` per lettura rapida dello stato corrente.

Colonne aggiunte a `ordenes` dalla migration preparata:

- `updated_at`
- `confirmado_at`
- `en_cocina_at`
- `listo_at`
- `en_entrega_at`
- `retirado_at`
- `completado_at`
- `cancelado_at`

## Migration

File preparato, non applicato:

- `migrations/2026-06-05_order_state_transition_logs.sql`

Contiene:

- `ALTER TABLE public.ordenes ADD COLUMN IF NOT EXISTS ...`
- `CREATE TABLE IF NOT EXISTS public.orden_estado_logs (...)`
- indici su `orden_id`, `created_at`, `estado_to`
- commento esplicito anti-PII
- nessuna policy RLS anon aggiunta.

## Helper

Nuovo file:

- `src/utils/orderStateLogger.js`

Funzioni:

- `buildStateTimestampPatch(...)`
- `stateEventType(...)`
- `sanitizeMetadata(...)`
- `logOrderStateTransition(...)`

Safety:

- Il log e' best-effort: se l'insert su `orden_estado_logs` fallisce, la transizione stato non viene bloccata.
- Il sanitizer rimuove chiavi come `nombre`, `tel`, `telefono`, `direccion`, `nota`, `wa_id`, `items`, anche se annidate.

## Backend

Modifiche:

- `creaOrdine(...)` ora prepara `updated_at` e timestamp stato iniziale.
- `creaOrdine(...)` scrive un log `created` best-effort.
- `cambiaStato(...)` legge stato/tipo corrente, aggiorna timestamp lifecycle nello stesso update dell'ordine e scrive un log best-effort.
- `index.js` passa `actor_type`/`origin` agli endpoint standard:
  - dashboard/operator per `cambiaStato` e `updateEstado`
  - rider/entregas per `marcarEnEntrega` e `marcarEntregado`

## Tests

Nuovo test:

- `tests/orderStateTransitions.test.js`

Copertura:

- creazione ordine con log `created`
- `POR_CONFIRMAR -> EN_COCINA`
- `EN_COCINA -> LISTO`
- `LISTO -> EN_ENTREGA`
- `EN_ENTREGA -> RETIRADO`
- ritiro `LISTO -> RETIRADO`
- log failure non blocca cambio stato
- sanitizer metadata anti-PII

Aggiornamento test esistente:

- `tests/closingTimeGuard.test.js` ora controlla l'ultima scrittura su `ordenes`, non l'ultima scrittura assoluta, perche' dopo l'ordine puo' esserci anche il log audit.

## Verification

Test mirato:

- `node tests/orderStateTransitions.test.js`
- Risultato: `33 passed, 0 failed`

Suite completa locale:

- `for f in tests/*.test.js; do node "$f" || exit 1; done`
- Risultato: tutti i test `.test.js` passati.

Safety:

- `git diff --check`: ok
- grep PII su nuovi file: occorrenze solo in denylist sanitizer, commenti anti-PII e test di rimozione.

## Safety Outcome

- Deploy: no.
- Migration produzione: no.
- DB write reale: no.
- Frontend: non toccato.
- `geo_cache`: non toccata.
- Push main: no.
- Codice backend modificato solo localmente e poi su backup branch.

## Rischi / Sequenza Live

Rischio principale: il codice scrive nuove colonne (`updated_at`, `listo_at`, ecc.). Quindi in produzione la migration deve essere applicata prima del deploy backend. Se si deploya il codice prima della migration, Supabase/PostgREST puo' rifiutare insert/update su colonne sconosciute.

Step live consigliato:

1. Applicare migration in produzione in finestra controllata.
2. Smoke read-only schema: verificare colonne e tabella `orden_estado_logs`.
3. Deploy backend.
4. Creare un ordine test manuale e passarlo `EN_COCINA -> LISTO -> RETIRADO`.
5. Verificare `ordenes` timestamp + `orden_estado_logs` senza PII.
6. Cleanup del solo ordine test.

STOP.
