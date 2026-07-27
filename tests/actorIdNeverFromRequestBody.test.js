'use strict';
// S2-7D6E3 — orden_estado_logs.actor_id is an audit-trail identity claim. Before this fix,
// the dashboard legacy actions (cambiaStato, creaOrdine, updateEstado) took actor_id
// straight from req.body — any holder of the shared DASHBOARD_API_KEY could forge who
// performed a state transition. The money ledger already fixed this class of defect
// (registerOperatorPayment takes by_actor exclusively from req.authCtx, never req.body —
// see src/financial/registerOperatorPayment.js:63-69); this test asserts the same rule now
// holds for the state-log call sites in index.js.
//
// Static source-text assertion (no server boot, no DB, no mocking): the exact literal
// `req.body.actor_id` must never appear as the actor_id source in these three call sites,
// and `req.authCtx` (or `req.authCtx?.actor`) must be the source instead.
//
// Run: node tests/actorIdNeverFromRequestBody.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Slice out each action block by its `if/else if (action === "...")` up to the next
// `} else if (action ===` (or a safe bound), so assertions are scoped and cannot pass by
// matching an unrelated part of the file.
function actionBlock(name) {
  const marker = `action === "${name}"`;
  const start = src.indexOf(marker);
  if (start < 0) return '';
  const lineStart = src.lastIndexOf('\n', start);
  const nextIdx = src.indexOf('} else if (action ===', start + marker.length);
  const end = nextIdx === -1 ? start + 2000 : nextIdx;
  return src.slice(lineStart, end);
}

const cambiaStatoBlock = actionBlock('cambiaStato');
const creaOrdineBlock = actionBlock('creaOrdine');
const updateEstadoBlock = actionBlock('updateEstado');

console.log('\n[cambiaStato]');
check('cambiaStato block found', cambiaStatoBlock.length > 0);
check('does NOT read req.body.actor_id', !/req\.body\.actor_id/.test(cambiaStatoBlock), cambiaStatoBlock);
check('actor_id is sourced from req.authCtx', /actor_id:\s*req\.authCtx\??\.actor/.test(cambiaStatoBlock));

console.log('\n[creaOrdine]');
check('creaOrdine block found', creaOrdineBlock.length > 0);
check('does NOT read req.body.actor_id', !/req\.body\.actor_id/.test(creaOrdineBlock), creaOrdineBlock);
check('actor_id override is sourced from req.authCtx (applied AFTER the ...req.body spread, so it always wins)',
  /\.\.\.req\.body,\s*actor_id:\s*req\.authCtx\??\.actor/.test(creaOrdineBlock));

console.log('\n[updateEstado]');
check('updateEstado block found', updateEstadoBlock.length > 0);
check('does NOT read req.body.actor_id', !/req\.body\.actor_id/.test(updateEstadoBlock), updateEstadoBlock);
check('extras.actor_id is sourced from req.authCtx', /extras\.actor_id\s*=\s*req\.authCtx\??\.actor/.test(updateEstadoBlock));

console.log('\n[no regression: legacy actor_type/origin still honour the body — only identity is locked down]');
check('cambiaStato still reads actor_type from the body (not a forgeable identity, just a label)',
  /actor_type:\s*req\.body\.actor_type/.test(cambiaStatoBlock));
check('updateEstado still reads origin from the body', /extras\.origin\s*=\s*req\.body\.origin/.test(updateEstadoBlock));

console.log('');
console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
