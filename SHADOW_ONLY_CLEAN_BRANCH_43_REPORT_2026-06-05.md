# SHADOW-ONLY-CLEAN-BRANCH-43

Data: 2026-06-05

## Base

- Branch candidate: `shadow-only/frozen-rider-chain-43`
- Base production: `origin/main`
- Base commit: `bc807b217c7d9db1e3120595bd218548ee09e37d`
- Obiettivo: branch deploy candidate pulita con solo fix Shadow Preview 41 + 42.

## Incluso

- Fix frozen/terminal false-critical Shadow Preview:
  - ordini `EN_ENTREGA` / `RETIRADO` / terminali esclusi dalle invarianti ricalcolabili;
  - differenze operative non marcate critical per ordini gia' committati;
  - wording informativo `Pedido ya comprometido`.

- Fix rider-chain explanation:
  - helper puro `riderChainExplanation`;
  - `riderChain` / `riderChainCount` in Shadow Preview;
  - action `review_rider_chain`;
  - baseline live read-only con campi driver persistiti preservati per reporting e rimossi prima del planner.

## Escluso

- State logs 40.
- Migration state logs.
- `src/utils/orderStateLogger.js`.
- Cambi lifecycle in `src/agents/agentOrdini.js`.
- Cambi actor/origin state logs in `index.js`.
- `tests/orderStateTransitions.test.js`.
- Report state logs 40.
- Frontend.
- Geo cache.
- CommitWriter.

## File inclusi

- `scripts/deliveryPlannerShadowLiveReadOnly.js`
- `scripts/deliveryPlannerShadowReadOnly.js`
- `src/core/delivery/diagnosticWording.js`
- `src/core/delivery/riderChainExplanation.js`
- `src/core/delivery/shadowPreview.js`
- `src/core/delivery/shadowPreviewContract.js`
- `tests/deliveryPlannerRiderChainExplanation.test.js`
- `tests/deliveryPlannerShadowLiveReadOnly.test.js`
- `tests/deliveryPlannerShadowPreviewFrozenOrders.test.js`

## Test

Targeted Shadow tests: PASS

- `tests/deliveryPlannerRiderChainExplanation.test.js`
- `tests/deliveryPlannerShadowPreview.test.js`
- `tests/deliveryPlannerShadowPreviewContract.test.js`
- `tests/deliveryPlannerShadowPreviewGrouping.test.js`
- `tests/deliveryPlannerShadowPreviewEndpoint.test.js`
- `tests/deliveryPlannerShadowReadOnly.test.js`
- `tests/deliveryPlannerShadowLiveReadOnly.test.js`
- `tests/deliveryPlannerShadowBackupReadOnly.test.js`

Full suite `for f in tests/*.test.js; do node "$f"; done`: PASS.

## Safety

- `git diff --check`: PASS.
- Forbidden file check: PASS, nessun file state logs/migration/agent lifecycle/index incluso.
- Write-token grep sui file staged: solo commenti/test di sicurezza; nessun nuovo write path.
- PII-token grep sui file staged: solo assert anti-PII nei test; nessuna stampa PII introdotta.
- Nessun DB write eseguito.
- Nessun deploy eseguito.
- Nessuna migration eseguita.
- Nessun push su `main`.

## Deploy Note

Questa candidate branch e' deployabile senza migration per il solo perimetro Shadow Preview.
I cambi state logs 40 restano separati e richiedono ciclo dedicato con migration/deploy separati.
