# PREVIEW_ORDER_PLANNER_V1_SPEC

## 1. Obiettivo

`previewOrderPlanner` e' il nuovo endpoint read-only per la schermata Premium `Nuevo Pedido`.

Lo scopo e' dare al frontend una risposta unica, stabile e gia' decisa dal backend/planner su:

- prima ora consigliata;
- confermabilita' dell'ora richiesta;
- uscita forno;
- uscita rider;
- consegna stimata;
- giro consigliato;
- alternative operative;
- warning e blocker.

Regola architetturale:

- backend/planner = fonte di verita';
- frontend Premium = consuma e mostra;
- il frontend Premium non calcola disponibilita';
- il frontend Premium non calcola lead time;
- il frontend Premium non decide se un giro e' usable, started o too-close;
- se manca una decisione, si estende il planner o il contratto API.

## 2. Decisione endpoint

Scelta consigliata: **A) nuovo endpoint `previewOrderPlanner`**.

Motivazione:

- `previewOrderTiming` e' gia' backend-authoritative, ma usa ancora la logica storica `proposeForNewOrder` da `zones.js`;
- il Premium deve consumare il nuovo planner, in particolare `src/core/delivery/planner.js` e `evaluateNewOrder`;
- estendere `previewOrderTiming` rischia di mescolare vecchia semantica e nuovo planner;
- `shadow-preview` e' utile come diagnostica/read-only di giornata, ma non e' il contratto ideale per una preview puntuale di un nuovo ordine;
- un endpoint nuovo permette un contract chiaro, testabile e migrabile senza rompere il live.

## 3. Endpoint / action

Nome consigliato:

```txt
previewOrderPlanner
```

Pattern consigliato:

```txt
POST /api/proxy
```

Payload:

```json
{
  "action": "previewOrderPlanner"
}
```

Vincoli:

- read-only;
- nessuna scrittura DB;
- nessuna creazione/modifica ordini;
- nessuna creazione/modifica clienti;
- nessuna modifica `manual_giros`;
- nessuna scrittura `geo_cache`, salvo futura autorizzazione esplicita;
- compatibile con il proxy/action pattern Netlify esistente;
- nessun side effect osservabile.

## 4. Input contract

Input minimo:

```json
{
  "action": "previewOrderPlanner",
  "tipo_consegna": "DOMICILIO",
  "direccion": "C. Delfin, 45-47",
  "zona": "Q2 Buenavista",
  "zonaManuale": null,
  "hora": "16:55",
  "items": [
    {
      "id": "pizza-zizou",
      "nombre": "Zizou",
      "cantidad": 1,
      "categoria": "pizza"
    }
  ],
  "pizzas_count": 1,
  "cliente_id": null,
  "now": null
}
```

Campi:

- `tipo_consegna`: obbligatorio. Valori attesi: `DOMICILIO` o `RITIRO`.
- `direccion`: obbligatorio per `DOMICILIO`, non necessario per `RITIRO`.
- `zona`: opzionale se la zona viene risolta da geo.
- `zonaManuale`: opzionale; se presente deve essere trattata come input operatore, non come calcolo frontend.
- `hora`: ora richiesta o attualmente selezionata dall'operatore, formato `HH:mm`.
- `items`: lista prodotti, utile per stimare carico/preparazione se il planner lo supporta.
- `pizzas_count`: numero pizze, opzionale se derivabile da `items`; utile come input normalizzato.
- `cliente_id`: opzionale, solo per contesto read-only se necessario.
- `now`: opzionale solo per test deterministici o preview controllate. In produzione il backend deve usare il proprio tempo server.

Nota:

- il frontend non deve inviare decisioni gia' prese localmente;
- il frontend puo' inviare solo input operatore e dati ordine correnti.

## 5. Backend flow

Flow desiderato:

1. Validare input.
2. Normalizzare `tipo_consegna`, `hora`, `items`, `pizzas_count`.
3. Se `tipo_consegna = RITIRO`:
   - non risolvere consegna;
   - non assegnare driver;
   - non proporre giro;
   - calcolare/leggere solo dati forno secondo regole planner.
4. Se `tipo_consegna = DOMICILIO`:
   - risolvere geo/zona con lo stesso livello di affidabilita' gia' usato da `previewOrderTiming`;
   - non scrivere `geo_cache`;
   - se la geo non e' risolvibile, restituire errore pulito o blocker.
5. Costruire snapshot read-only:
   - ordini attivi;
   - manual giros;
   - eventi rider/manual route se disponibili;
   - stato giri;
   - ora server;
   - eventuali dati necessari al planner.
6. Costruire `newOrder` per `evaluateNewOrder(snapshot, newOrder)`.
7. Chiamare il planner nuovo:

```js
evaluateNewOrder(snapshot, newOrder)
```

8. Mappare `selected`, `recommended`, `options`, `proximo_slot`, `warnings` nel contract Premium.
9. Restituire JSON stabile.

Divieti:

- non chiamare `proposeForNewOrder`;
- non duplicare logica di `zones.js`;
- non calcolare compatibilita' nel frontend;
- non creare fallback decisionali locali nel frontend;
- non scrivere su DB.

## 6. Output contract

Shape consigliata:

```json
{
  "ok": true,
  "contract": "nuevo-pedido-planner-preview-v1",
  "source": "planner",
  "mode": "read_only",
  "input": {
    "tipo_consegna": "DOMICILIO",
    "requested_hora": "16:55",
    "pizzas_count": 1
  },
  "geo": {
    "resolved": true,
    "direccion": "C. Delfin, 45-47",
    "zona": "Q2 Buenavista",
    "zona_lat": 0,
    "zona_lon": 0,
    "durata_andata_min": 8,
    "durata_google_min": 8,
    "durata_haversine_min": null,
    "source": "google"
  },
  "recommendation": {
    "requested_hora": "16:55",
    "recommended_hora": "16:55",
    "can_confirm_requested_hora": true,
    "forno_out": "16:47",
    "salida_driver": "16:47",
    "entrega_estimada": "16:55",
    "reason": "recommended_by_planner"
  },
  "driver": {
    "required": true,
    "available": true,
    "has_conflict": false,
    "message": null
  },
  "giro": {
    "recommended": true,
    "giro_id": "manual-giro-123",
    "zona": "Q2 Buenavista",
    "slot_hora": "17:10",
    "salida_driver": "17:02",
    "entrega_estimada": "17:10",
    "reason": "compatible_route",
    "can_attach": true
  },
  "alternatives": [
    {
      "type": "giro",
      "label": "Giro compatible Q2",
      "hora": "17:10",
      "giro_id": "manual-giro-123",
      "can_attach": true,
      "reason": "compatible_route"
    }
  ],
  "availability_rows": [
    {
      "type": "planner_option",
      "hora": "16:55",
      "label": "Disponible",
      "status": "ok",
      "reason": "recommended_by_planner"
    }
  ],
  "warnings": [],
  "blockers": [],
  "explanation": [
    "Planner source of truth",
    "Read-only preview"
  ]
}
```

Note:

- `recommendation.recommended_hora` e' la proposta principale da mostrare nel Premium;
- `recommendation.can_confirm_requested_hora` decide se l'ora richiesta puo' essere confermata;
- `blockers` blocca o spiega problemi reali;
- `warnings` informa senza trasformare alternative operative in allarmi;
- `alternatives` contiene opzioni positive/neutre, non warning;
- `availability_rows` puo' alimentare una centralina/planner UI senza calcoli frontend.

## 7. Mapping da planner

Il planner attuale espone concetti come:

- `selected`;
- `recommended`;
- `options`;
- `proximo_slot`;
- `warnings`;
- `snapshot_now`.

Mapping consigliato:

- `selected` -> `recommendation` quando rappresenta la scelta principale del planner.
- `recommended` -> `recommendation` o `giro` in base al tipo di opzione.
- `options` -> `alternatives` e `availability_rows`.
- `proximo_slot` -> fallback backend-authoritative per `recommended_hora` se non c'e' una scelta immediata.
- `warnings` -> `warnings`, gia' sanificati.
- opzioni non utilizzabili -> `blockers` se bloccano conferma, oppure `availability_rows` con `status = "disabled"` se sono solo spiegazioni.

Il mapping deve essere implementato nel backend, non nel frontend.

## 8. Error contract

Shape errore:

```json
{
  "ok": false,
  "contract": "nuevo-pedido-planner-preview-v1",
  "source": "planner",
  "mode": "read_only",
  "error": {
    "code": "invalid_hora",
    "message": "Hora invalida",
    "safe": true
  },
  "warnings": [],
  "blockers": [
    {
      "code": "invalid_hora",
      "message": "Selecciona una hora valida"
    }
  ]
}
```

Errori minimi:

- `missing_tipo_consegna`;
- `missing_hora`;
- `invalid_hora`;
- `missing_direccion`;
- `unresolved_geo`;
- `planner_unavailable`;
- `snapshot_read_failed`;
- `internal_error`.

Regole errore:

- niente stacktrace in output;
- niente PII non necessaria;
- messaggi operator-friendly;
- diagnostics raw solo in log server, se necessario;
- nessuna scrittura anche in caso errore.

## 9. Safety

Garanzie:

- endpoint read-only;
- nessun `insert`;
- nessun `update`;
- nessun `delete`;
- nessuna creazione ordine;
- nessuna modifica cliente;
- nessuna modifica manual giro;
- nessuna modifica rider events;
- nessuna scrittura `geo_cache` salvo futura autorizzazione esplicita;
- nessuna chiamata esterna con side effect;
- nessuna PII superflua in output;
- raw diagnostics nascosti o sanificati.

Guard consigliati nei test:

- mock DB client e assert che non vengano chiamate operazioni di write;
- fixture per geo senza scrivere cache;
- fixture planner deterministica con `now`;
- snapshot shape del contract.

## 10. Test minimi

Test da scrivere:

1. `RITIRO`
   - `recommended_hora` coerente;
   - `forno_out` coerente;
   - `driver.required = false`;
   - nessun giro consigliato.

2. `DOMICILIO Q1 semplice`
   - geo risolta;
   - durata presente;
   - `recommendation` presente;
   - nessun fallback frontend necessario.

3. `Q5 / durata andata`
   - durata corretta;
   - uscita driver e consegna stimata coerenti;
   - eventuali warning dal planner.

4. `Giro futuro compatibile`
   - `giro.recommended = true`;
   - `can_attach = true`;
   - alternativa positiva/neutra.

5. `Giro gia' partito / too-close`
   - non aggregabile;
   - nessuna raccomandazione di attach;
   - blocker/warning spiegato dal planner.

6. `Manual route / rider block`
   - conflitto espresso in `driver` o `blockers`;
   - nessun calcolo frontend.

7. `Ora manuale +5/+10`
   - `can_confirm_requested_hora` corretto;
   - `recommended_hora` backend-authoritative.

8. `Planner returns blockers`
   - blockers stabili;
   - frontend puo' disabilitare conferma usando il contract.

9. `No DB write guard`
   - nessuna chiamata write durante preview.

10. `Contract shape stable`
    - snapshot JSON v1.

11. `Missing/invalid params`
    - errori puliti;
    - niente stacktrace;
    - niente PII.

## 11. Frontend migration dopo endpoint

Quando `previewOrderPlanner` esiste, il Premium potra' rimuovere:

- `slotFeedback`;
- `proposeForNewOrder` dal frontend;
- fallback locale `deliveryStatus`;
- `buildDisponibilidad` locale se decide o interpreta disponibilita';
- CTA locali che applicano orari non arrivati dal backend;
- copy tipo `Sin giros activos · todo libre` se non arriva dal planner;
- qualunque `setHora(...)` basato su calcolo locale;
- qualunque logica frontend che decide giro compatibile;
- qualunque fallback decisionale se backend non risponde.

Il frontend dovra':

- chiamare `api.previewOrderPlanner`;
- mostrare `recommendation`;
- mostrare `warnings` e `blockers`;
- mostrare `giro` e `alternatives`;
- aprire la centralina/planner per dettagli profondi;
- applicare orari solo se selezionati da output backend/planner;
- non inventare timing.

## 12. Piano consigliato

Step 1:

- implementare endpoint/action `previewOrderPlanner` read-only nel backend;
- aggiungere test backend contract e no-write guard;
- non toccare frontend Premium.

Step 2:

- migrare `NuevoPedidoModal.jsx` a `previewOrderPlanner`;
- rimuovere fallback decisionali locali;
- mantenere solo display e microcopy.

Step 3:

- collegare centralina/planner UI a `availability_rows`, `alternatives`, `warnings`, `blockers`;
- evitare nuove logiche locali nel frontend.

## 13. Raccomandazione finale

Consiglio **A) nuovo endpoint `previewOrderPlanner`**.

Non consiglio di estendere `previewOrderTiming` per il Premium, perche' oggi quella action resta legata alla logica storica `proposeForNewOrder`.

Non consiglio di adattare direttamente `shadow-preview`, perche' e' una diagnostica/read-only di giornata, non il contratto operativo puntuale della schermata `Nuevo Pedido`.

`previewOrderPlanner` deve diventare il contratto v1 testabile tra Premium UI e planner backend.
