# ORDER-STATE-MACHINE-WIRE-GUARD-49B — Allow ready→kitchen operational undo

**Data:** 2026-06-05 · **Base:** task 49 `d46b1d7` (su `origin/main = 5d9e2de`)
**Branch:** `order-state-machine/wire-guard-49b-allow-ready-undo`
**Stato:** codice + test locali. NESSUN deploy, NESSUN push su main, NESSUNA scrittura DB.

## Perché `LISTO → EN_COCINA` è permesso
Il pulsante **LISTO** della dashboard non ha conferma: l'operatore può marcarlo per
errore. Serve poter **rimettere l'ordine in cucina** senza workaround. Quindi
`LISTO → EN_COCINA` è ora un **undo operativo esplicito**, non un backward generico.

Implementazione (`src/utils/orderStateMachine.js`): aggiunta una mappa dedicata
`OPERATIONAL_UNDO = { LISTO: ["EN_COCINA"] }`, fusa in `LEGAL_TRANSITIONS` accanto a
`CANCELLABLE_FROM`. È l'**unica** eccezione backward, isolata e documentata.

## Comportamento timestamp / log sull'undo
Quando `LISTO → EN_COCINA` viene eseguito:
- `estado` → `EN_COCINA`, `en_cocina_at` + `updated_at` valorizzati;
- `confirmado_at` NON ri-valorizzato (from ≠ POR_CONFIRMAR);
- **`listo_at` NON cancellato** (l'undo resta visibile nello storico — decisione esplicita del task, da analizzare in seguito);
- log append-only creato con `event_type = sent_to_kitchen`, **senza PII**.

## Transizioni che restano VIETATE
- Stati malformati: `"EN_COCINA cambiaStato"`, `"foo"`, `""`, `null`, `" listo "` → `unknown_target_state`.
- Backward pericolosi (NON estesi dall'undo): `EN_ENTREGA → LISTO`, `EN_ENTREGA → EN_COCINA`, `RETIRADO → EN_COCINA`, `RETIRADO → LISTO` → `illegal_transition`.
- Resurrezione da terminale duro: `COMPLETADO → EN_COCINA`, `COMPLETATO → LISTO`, `CANCELADO → EN_COCINA` → `from_terminal_state`.

## Flussi validi invariati
`POR_CONFIRMAR/NUEVO → EN_COCINA`, `EN_COCINA → LISTO`, `LISTO → EN_ENTREGA`,
`LISTO → RETIRADO`, `EN_ENTREGA → RETIRADO`, `RETIRADO → COMPLETADO/COMPLETATO`,
CANCELADO da ogni non-terminale, no-op idempotente. `orderStateTransitions` resta verde.

## Test
- `tests/orderStateMachine.test.js`: 38 pass (sezione "undo operativo (49B)": `LISTO→EN_COCINA` reason=legal; `EN_ENTREGA→LISTO`/`EN_ENTREGA→EN_COCINA` ancora illegali).
- `tests/orderStateMachineWireGuard.test.js`: 61 pass (caso 3B: undo esegue update+log, `listo_at` preservato, no PII; backward/terminal ancora rifiutati).
- `tests/orderStateTransitions.test.js`: 33 pass · `closingTimeGuard`: OK.
- Full suite: **34/34 suite pass, 0 fail**.

## No deploy / No prod
Solo codice e test locali. Nessun deploy, nessun push su main, nessuna scrittura DB
reale, nessuna migration, nessun ordine creato, frontend non toccato, no PII/secrets.
