# ORDER-STATE-MACHINE-WIRE-GUARD-49 — Report

**Data:** 2026-06-05 · **Base:** `origin/main = 5d9e2de` · **Branch:** `order-state-machine/wire-guard-49`
**Stato:** codice + test locali. NESSUN deploy, NESSUN push su main, NESSUNA scrittura DB.

## 1. Problema
Nel post-deploy smoke 47, un bug di harness ha inviato a `cambiaStato` uno stato
malformato (`"EN_COCINA cambiaStato"`). Il backend lo ha **salvato letteralmente**:
`cambiaStato` faceva `upd = { estado: nuovoStato }` senza alcuna validazione, quindi
accettava qualsiasi stringa e qualsiasi transizione (anche all'indietro o da stato
chiuso). Non era un bug del logging, ma una mancanza di guardia lato server.

## 2. Helper usato
`src/utils/orderStateMachine.js` (puro, già testato offline in task 48):
- `KNOWN_STATES`: POR_CONFIRMAR, NUEVO, EN_COCINA, LISTO, EN_ENTREGA, RETIRADO,
  COMPLETADO, COMPLETATO, CANCELADO.
- `TERMINAL_STATES` (duri, nessuna uscita): COMPLETADO, COMPLETATO, CANCELADO.
- `validateTransition(from, to) → { ok, reason }`.

## 3. Wiring in `cambiaStato` (src/agents/agentOrdini.js)
- Aggiunto `require("../utils/orderStateMachine")`.
- Inserito il guard **dopo** la lettura dello stato corrente (`estadoActual`) e
  **prima** di `buildStateTimestampPatch` / `sbUpdate` / `logOrderStateTransition`:
  se `validateTransition` fallisce → `return { success:false, error:"invalid_state_transition",
  reason, estado_actual, estado_solicitado }`. Nessun update ordenes, nessun log.
- `estadoActual = null` (ordine non trovato o fetch fallito) → semantica "create":
  gli stati malformati restano **comunque rifiutati**, ma la legalità della
  transizione non viene forzata (fail-open, coerente col comportamento "lo stato
  cambia comunque" preesistente). Il bug esatto dello smoke-47 è rifiutato anche
  in questo caso (stato sconosciuto).

## 4. Transizioni permesse (invariate)
create→POR_CONFIRMAR/NUEVO; POR_CONFIRMAR/NUEVO→EN_COCINA; EN_COCINA→LISTO;
LISTO→EN_ENTREGA; LISTO→RETIRADO (ritiro); EN_ENTREGA→RETIRADO;
RETIRADO→COMPLETADO/COMPLETATO; CANCELADO da ogni stato non terminale;
no-op idempotente (X→X) sempre lecito. Il test esistente `orderStateTransitions`
(flusso lifecycle completo) resta **verde** → flussi reali non bloccati.

## 5. Transizioni rifiutate
- Stato sconosciuto: `"EN_COCINA cambiaStato"`, `"foo"`, `""`, `null`, `" listo "`
  → `unknown_target_state` (scelta: rifiuto chiaro, niente normalizzazione silenziosa).
- Backward: `LISTO→EN_COCINA`, `EN_ENTREGA→LISTO`, `RETIRADO→EN_COCINA` → `illegal_transition`.
- Resurrezione da terminale duro: `COMPLETADO→EN_COCINA`, `COMPLETATO→LISTO`,
  `CANCELADO→EN_COCINA` → `from_terminal_state`.
In tutti i casi: nessun update `ordenes`, nessun insert `orden_estado_logs`.

## 6. Test
- `tests/orderStateMachine.test.js`: 34 pass (helper puro).
- `tests/orderStateMachineWireGuard.test.js` (NUOVO): 53 pass (guard cablato:
  valido scrive, invalido NON tocca ordenes/log, catena completa, no PII).
- `tests/orderStateTransitions.test.js`: 33 pass (lifecycle invariato).
- `tests/closingTimeGuard.test.js`: OK.
- Full suite: **34/34 suite pass, 0 fail**.

## 7. Safety
Nessuna PII salvata/stampata (l'errore espone solo `estado_actual`/`estado_solicitado`).
Nessun secret, nessun CommitWriter. Le occorrenze PII in `agentOrdini.js` sono
codice preesistente (geo_cache/cliente/insert), non toccate dal guard.

## 8. No deploy / No DB / No prod
Solo codice e test locali. Nessun deploy, nessun push su main, nessuna scrittura DB
reale, nessuna migration, nessun ordine reale creato, geo_cache non toccata.

## 9. Rischi residui
- Se la dashboard supporta **correzioni di stato all'indietro** legittime (es.
  operatore che riporta LISTO→EN_COCINA), ora verrebbero rifiutate. La modifica è
  in linea con la richiesta del task; va verificata con uno smoke controllato su
  ambiente prima del deploy.
- Transizioni "salto" usate raramente (es. EN_COCINA→RETIRADO diretto) non sono
  nel grafo: se un flusso reale le usa, andrà aggiunto l'arco.
- Normalizzazione: `" listo "` viene rifiutato (non normalizzato). Se un client
  invia stati con spazi/case diversi servirà adeguare il client o aggiungere una
  normalizzazione esplicita.
