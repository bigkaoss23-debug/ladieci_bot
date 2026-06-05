# SHADOW-PREVIEW-FROZEN-ORDERS-FALSE-CRITICAL-41

## 1. Problema osservato

Durante `REALISTIC-MANUAL-ORDER-STRESS-39`, la Shadow Preview poteva mostrare `critical` anche quando il servizio reale era ok.

Il caso tipico era un ordine gia' partito o terminale:

- `EN_ENTREGA`
- `RETIRADO`
- `COMPLETADO`
- `CANCELADO`

Questi ordini non sono piu' liberamente ricalcolabili. Se il planner non li riproietta o ritorna valori committati/null, non deve scattare un blocco operativo.

## 2. Causa tecnica

Nel runner `scripts/deliveryPlannerShadowReadOnly.js`, le invarianti rosse:

- `noImpossibleFornoOut`
- `noDriverBeforePizza`

venivano valutate su tutti i delivery grezzi.

Per un delivery `RETIRADO`, il planner puo' non produrre una proiezione perche' l'ordine e' gia' fuori dallo scheduling. L'invariante interpretava `projection missing` come errore reale, producendo `shadow_red`, poi `critical` e action `do_not_apply_plan`.

## 3. Fix

Modificato solo il livello Shadow Preview / runner read-only:

- aggiunto `isFrozenOrTerminalOrder(order)`;
- aggiunto `isRecomputableDelivery(order)`;
- `noImpossibleFornoOut` e `noDriverBeforePizza` ora guardano solo delivery ricalcolabili;
- le differenze operative saltano gli ordini frozen/terminali;
- aggiunto diagnostic info `frozen_committed_order`;
- aggiunto wording operatore `Pedido ya comprometido`.

Non e' stato modificato il planner core pesante.

## 4. Esempi coperti

- `EN_ENTREGA` con baseline forno valida ma non riproiettata: non diventa `critical`.
- `RETIRADO` con `hora_salida`/`hora_entrega` gia' presenti: non diventa `critical`, niente `do_not_apply_plan`.
- Mix `EN_COCINA` sano + `RETIRADO`: il terminale non contamina lo status.
- Bug reale su pianificabile: invariant falsa resta `critical` e mantiene `do_not_apply_plan`.
- Shape Stress 39 con `#002/#003 RETIRADO` e `#017 EN_COCINA`: terminali non generano false critical.

## 5. Test

Nuovo test:

- `tests/deliveryPlannerShadowPreviewFrozenOrders.test.js`

Test mirati eseguiti:

- `node tests/deliveryPlannerShadowPreviewFrozenOrders.test.js`
- `node tests/deliveryPlannerShadowPreview.test.js`
- `node tests/deliveryPlannerShadowPreviewContract.test.js`
- `node tests/deliveryPlannerShadowPreviewEndpoint.test.js`
- `node tests/deliveryPlannerShadowReadOnly.test.js`
- `node tests/deliveryPlannerShadowLiveReadOnly.test.js`
- `node tests/deliveryPlannerShadowBackupReadOnly.test.js`

Risultato: tutti PASS.

Full suite:

- `for f in tests/*.test.js; do node "$f" || exit 1; done`

Risultato: tutti PASS.

## 6. Safety

- Nessun deploy.
- Nessun push su `main`.
- Nessuna migration applicata.
- Nessuna scrittura DB.
- Nessun ordine creato/modificato/cancellato.
- Nessun cleanup.
- Nessun frontend toccato.
- Nessuna `geo_cache` toccata.
- Nessun CommitWriter collegato.
- Nessun PII/secrets stampato.

Safety grep:

- PII nei file toccati: nessun match.
- DB/network/write token nei file toccati: solo commento storico read-only nel runner; nessun path operativo di scrittura aggiunto.

## 7. Rischi

Il fix classifica `EN_ENTREGA`, `RETIRADO`, `COMPLETADO`, `COMPLETATO`, `CANCELADO` come non ricalcolabili per le invarianti che richiedono riproiezione. `LISTO` resta fuori da questa esclusione: e' ancora trattato con prudenza per non allargare troppo il cambiamento.

Se in futuro si decide che `LISTO` deve essere trattato come frozen artifact in Shadow Preview live, va aggiunto con un test dedicato.

## 8. Next step

Prima del deploy: fare una smoke read-only su Shadow Preview live con una giornata che contiene `EN_ENTREGA`/`RETIRADO`, verificando:

- status non `critical` se l'unico problema e' frozen/terminal;
- nessuna action `do_not_apply_plan` falsa;
- eventuali warning rider/forno reali restano visibili.

Separatamente, pianificare il deploy/migration del task `ORDER-STATE-TRANSITION-LOGS-40`; non mescolare quel rollout con questa correzione.

STOP.
