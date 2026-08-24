// tests/n5PaidOrderEconomicMutationGuard.test.js — N-5 paid-order economic mutation safety:
// the pure application-layer contract (refusal detection, refusal shape, the collect+discount
// pre-check) + static assertions on the migration and on the three writers that must honour it.
//
// The DB-side behaviour (unpaid edit allowed and N-2 appends revision 2; partial-paid,
// fully-paid and legacy-paid economic edits refused; identical-value rewrite allowed;
// state-only transition allowed; same-transaction payment-then-rewrite refused; a refused
// edit leaves zero residue) is proven separately by rollback-safe probes against real
// staging data, recorded in this slice's report.
// Run: node tests/n5PaidOrderEconomicMutationGuard.test.js
const fs = require("fs");
const path = require("path");
const {
  PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
  OPERATOR_MESSAGE,
  isEconomicMutationRefusal,
  economicMutationRefusal,
  collectionWouldMutateEconomicBasis,
} = require("../src/financial/paidOrderEconomicGuard");

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

const MIG = path.join(__dirname, "..", "migrations", "2026-08-24_n5_paid_order_economic_mutation_guard.sql");
const ROLLBACK = path.join(__dirname, "..", "migrations", "2026-08-24_n5_paid_order_economic_mutation_guard.ROLLBACK.sql");
const sql = fs.readFileSync(MIG, "utf8");
const rollbackSql = fs.readFileSync(ROLLBACK, "utf8");
// language-guard: allow-legacy agentOrdini.js is the existing module filename being read, not new vocabulary
const writersSrc = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "agentOrdini.js"), "utf8");
const indexJs = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

console.log("\n── refusal detection (the silent-success defect) ──");
{
  // PostgREST's shape for a PL/pgSQL RAISE.
  const pgErr = {
    code: "P0001",
    message: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN,
    details: "order_id=#42 field=totale old=25.00 new=30.00",
    hint: "This order already carries payment evidence.",
  };
  check("a real PostgREST refusal is recognised", isEconomicMutationRefusal(pgErr) === true);
  check("recognised from `details` alone (message relocated)",
    isEconomicMutationRefusal({ details: `x ${PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN} y` }) === true);
  check("recognised from `hint` alone",
    isEconomicMutationRefusal({ hint: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN }) === true);
  check("recognised from singular `detail`",
    isEconomicMutationRefusal({ detail: PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN }) === true);
}
{
  // A successful PATCH returns "" (empty body, minimal prefer) or the row array.
  check("empty-string success is NOT a refusal", isEconomicMutationRefusal("") === false);
  check("undefined success is NOT a refusal", isEconomicMutationRefusal(undefined) === false);
  check("null is NOT a refusal", isEconomicMutationRefusal(null) === false);
  check("a returned row array is NOT a refusal",
    isEconomicMutationRefusal([{ id: "#42", totale: 30 }]) === false);
  check("an unrelated PostgREST error is NOT a refusal",
    isEconomicMutationRefusal({ code: "23505", message: "duplicate key value" }) === false);
  check("a different DB guard is NOT mistaken for this one",
    isEconomicMutationRefusal({ code: "P0001", message: "ORDER_HAS_FINANCIAL_EVIDENCE" }) === false);
  check("a number is NOT a refusal", isEconomicMutationRefusal(42) === false);
}

console.log("\n── the refusal returned to callers ──");
{
  const r = economicMutationRefusal("#42");
  check("success is false (never a fabricated success)", r.success === false);
  check("`error` carries the contract code", r.error === PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN);
  check("`code` carries it too (both conventions are read by callers)",
    r.code === PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN);
  check("the order id is echoed back", r.id === "#42");
  check("the operator message is Spanish and jargon-free", r.message === OPERATOR_MESSAGE);
  check("the message never leaks the raw code", !r.message.includes("PAID_ORDER"));
  check("a non-string id degrades to undefined rather than junk",
    economicMutationRefusal(42).id === undefined);
}

console.log("\n── collect + discount pre-check (money must not move first) ──");
{
  check("a real EURO discount is refused early",
    collectionWouldMutateEconomicBasis({ descuento_tipo: "EURO", descuento_valor: 5 }) === true);
  check("a real PERCENT discount is refused early",
    collectionWouldMutateEconomicBasis({ descuento_tipo: "PERCENT", descuento_valor: 10 }) === true);
  check("a bare positive valor (no tipo) is refused early",
    collectionWouldMutateEconomicBasis({ descuento_valor: 3 }) === true);
  check("a string valor is still read as a number",
    collectionWouldMutateEconomicBasis({ descuento_valor: "3" }) === true);
}
{
  // THE REGRESSION THIS EXISTS TO PREVENT: TabListos' discount state defaults to
  // {tipo:null, valor:0} and api.updateEstado forwards descuento_valor whenever it is
  // non-null, so an ordinary "Retirado + efectivo" with no discount can carry valor: 0.
  // A blunt "any descuento key" rule would refuse every collection from Listos.
  check("descuento_valor: 0 is NOT an economic change (plain collection still works)",
    collectionWouldMutateEconomicBasis({ descuento_valor: 0 }) === false);
  check("a negative valor is not a discount either",
    collectionWouldMutateEconomicBasis({ descuento_valor: -5 }) === false);
  check("tipo null + valor 0 (the literal default) passes",
    collectionWouldMutateEconomicBasis({ descuento_tipo: null, descuento_valor: 0 }) === false);
  check("an empty-string tipo is not a discount",
    collectionWouldMutateEconomicBasis({ descuento_tipo: "   ", descuento_valor: 0 }) === false);
  check("no discount keys at all passes",
    collectionWouldMutateEconomicBasis({ metodo_pago: "efectivo" }) === false);
  check("a non-object is safe", collectionWouldMutateEconomicBasis(null) === false);
  check("NaN valor is not a discount",
    collectionWouldMutateEconomicBasis({ descuento_valor: "abc" }) === false);
}

console.log("\n── migration: the guard fires on value change, not column presence ──");
{
  check("the trigger is BEFORE UPDATE", /BEFORE UPDATE OF/.test(sql));
  check("it is scoped to all five economic-basis columns",
    /BEFORE UPDATE OF totale, delivery_fee, descuento_tipo, descuento_valor, descuento_importe/.test(sql));
  for (const col of ["totale", "delivery_fee", "descuento_tipo", "descuento_valor", "descuento_importe"]) {
    check(`${col} is compared OLD vs NEW with IS DISTINCT FROM`,
      new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`).test(sql));
  }
  check("an unchanged basis returns without consulting evidence (state-only path)",
    /ELSE\s*\n\s*--[\s\S]*?RETURN NEW;/.test(sql));
  check("`items` is deliberately NOT part of the comparison (Post-send Editing V2)",
    !/NEW\.items IS DISTINCT FROM OLD\.items/.test(sql));
}

console.log("\n── migration: the payment-evidence predicate ──");
{
  check("legacy ya_pagado is read on OLD", /OLD\.ya_pagado IS TRUE/.test(sql));
  check("legacy cobrado is read on OLD", /OLD\.cobrado IS TRUE/.test(sql));
  check("legacy ya_pagado is ALSO read on NEW (one statement cannot pay and move money)",
    /NEW\.ya_pagado IS TRUE/.test(sql));
  check("legacy cobrado is ALSO read on NEW", /NEW\.cobrado IS TRUE/.test(sql));
  check("order_financial_events is an evidence source",
    /FROM public\.order_financial_events e/.test(sql));
  check("payment_allocations is an evidence source, joined through payment_transactions",
    /FROM public\.payment_allocations pa[\s\S]{0,120}JOIN public\.payment_transactions pt/.test(sql));
  // The M-1 trap: table_order_lines exists for every Mesa order from creation.
  check("table_order_lines is NOT an evidence source (would freeze unpaid Mesa orders)",
    !/table_order_lines/.test(sql.replace(/^--.*$/gm, "")));
  check("service_incidents is NOT an evidence source (not money)",
    !/service_incidents/.test(sql.replace(/^--.*$/gm, "")));
  check("evidence is scoped by composite (order_id, service_session_id)",
    /e\.service_session_id = v_session/.test(sql) && /pt\.service_session_id = v_session/.test(sql));
  check("a NULL-session evidence row counts for any order (fail-closed arm)",
    /e\.service_session_id IS NULL/.test(sql) && /pt\.service_session_id IS NULL/.test(sql));
  check("the session is taken from OLD, never from the incoming row",
    /v_session uuid := OLD\.service_session_id/.test(sql));
  check("evidence is looked up by OLD.id, never NEW.id",
    /e\.order_id = OLD\.id/.test(sql) && /pa\.order_id = OLD\.id/.test(sql));
}

console.log("\n── migration: contract, safety and reversibility ──");
{
  check("it raises the documented contract code",
    sql.includes(`RAISE EXCEPTION '${PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN}'`));
  check("the exception carries which field moved, and from what to what",
    /DETAIL\s*=\s*format\('order_id=%s field=%s old=%s new=%s'/.test(sql));
  check("search_path is pinned", /SET search_path TO 'public', 'pg_temp'/.test(sql));
  check("browser roles cannot EXECUTE the guard",
    /REVOKE ALL ON FUNCTION public\.paid_order_economic_mutation_guard_v1\(\) FROM PUBLIC, anon, authenticated/.test(sql));
  check("a predecessor guard refuses a double apply",
    /N-5 refused: paid_order_economic_mutation_guard_v1 already exists/.test(sql));
  check("it refuses to run without N-2 in place",
    /N-5 refused: order_obligations \(N-2, ledger 112\) is missing/.test(sql));
  check("post-conditions assert the trigger is BEFORE UPDATE",
    /N-5 post-condition failed: the guard must be BEFORE UPDATE/.test(sql));
  check("post-conditions assert all five columns are in the UPDATE OF list",
    /not scoped to all five economic-basis columns/.test(sql));
  check("post-conditions assert N-2 survived", /the N-2 revision trigger disappeared/.test(sql));
  check("post-conditions assert Mesa survived", /Mesa line-snapshot trigger disappeared/.test(sql));
  check("it writes no business DML", !/^\s*(INSERT INTO|UPDATE) public\.(ordenes|order_obligations|order_financial_events)/m.test(sql));
  check("rollback drops the trigger before the function (no CASCADE needed)",
    rollbackSql.indexOf("DROP TRIGGER IF EXISTS ordenes_paid_order_economic_mutation_guard_v1")
      < rollbackSql.indexOf("DROP FUNCTION IF EXISTS public.paid_order_economic_mutation_guard_v1"));
  check("rollback verifies N-2 and Mesa were not collaterally removed",
    /the N-2 revision trigger was collaterally removed/.test(rollbackSql)
      && /the Mesa line-snapshot trigger was collaterally removed/.test(rollbackSql));
}

console.log("\n── the three writers must not report a refused edit as success ──");
{
  check("the order-writer module imports the refusal helpers",
    /require\("\.\.\/financial\/paidOrderEconomicGuard"\)/.test(writersSrc));
  const refusals = writersSrc.match(/if \(isEconomicMutationRefusal\([a-zA-Z]+\)\) return economicMutationRefusal\(ordenId\);/g) || [];
  // language-guard: allow-legacy modificaOrdine is the existing JS edit function name being cited, not new vocabulary
  check("all three writers check their sbUpdate result (modificaOrdine, cambiaStato, aggiungiItems)",
    refusals.length === 3);
  // Every `sbUpdate("ordenes", ...)` in the file must EITHER be checked (its result is
  // bound and tested) or be a writer that touches no economic column. Exactly one is
  // unchecked today: risincronizzaGiro's driver-schedule patch (advisory fields only).
  const writes = writersSrc.split("\n").filter((l) => l.includes('sbUpdate("ordenes"'));
  const unchecked = writes.filter((l) => !/^\s*const \w+ = await sbUpdate/.test(l));
  check("every ordenes writer is either result-checked or provably non-economic",
    writes.length === 4 && unchecked.length === 1 && unchecked[0].includes("u.patch"));

  // Scope the ordering checks to the function bodies, not the whole file: both
  // logOrderStateTransition and risincronizzaGiro also appear inside the creation path above.
  const bodyOf = (name) => {
    const start = writersSrc.indexOf(`async function ${name}(`);
    return start === -1 ? "" : writersSrc.slice(start, writersSrc.indexOf("\n}\n", start));
  };
  const cambiaStatoBody = bodyOf("cambiaStato");
  // language-guard: allow-legacy modificaOrdine is the existing JS edit function name whose body is sliced here, not new vocabulary
  const modificaBody = bodyOf("modificaOrdine");
  check("cambiaStato returns BEFORE writing a transition log for a rejected write",
    cambiaStatoBody.includes("isEconomicMutationRefusal(stateRes)")
      && cambiaStatoBody.indexOf("isEconomicMutationRefusal(stateRes)")
         < cambiaStatoBody.indexOf("await logOrderStateTransition("));
  check("cambiaStato returns BEFORE the DRIVER_STATO reconciliation hook",
    cambiaStatoBody.indexOf("isEconomicMutationRefusal(stateRes)")
      < cambiaStatoBody.indexOf("recordDeliveryAndMaybeReturn("));
  // language-guard: allow-legacy modificaOrdine is the same existing JS edit function name, restated for this assertion, not new vocabulary
  check("modificaOrdine returns BEFORE re-syncing the giro off a patch that never landed",
    modificaBody.includes("isEconomicMutationRefusal(modRes)")
      && modificaBody.indexOf("isEconomicMutationRefusal(modRes)")
         < modificaBody.indexOf("await risincronizzaGiro("));
}

console.log("\n── index.js: refuse the collect+discount combination before money moves ──");
{
  check("index.js imports the pre-check", /collectionWouldMutateEconomicBasis,/.test(indexJs));
  const guards = (indexJs.match(/collectionWouldMutateEconomicBasis\(extras\)/g) || []).length;
  check("both collecting call sites are guarded (updateEstado + marcarEntregado)", guards === 2);
  // Ordering is the whole point: the refusal must precede registerPayment.
  const firstGuard = indexJs.indexOf("collectionWouldMutateEconomicBasis(extras)");
  const firstPay = indexJs.indexOf("operatorPayments.registerPayment(");
  check("the first pre-check precedes the first registerPayment call", firstGuard < firstPay);
  const lastGuard = indexJs.lastIndexOf("collectionWouldMutateEconomicBasis(extras)");
  const lastPay = indexJs.lastIndexOf("operatorPayments.registerPayment(");
  check("the second pre-check precedes the second registerPayment call", lastGuard < lastPay);
  check("it answers 409 with the typed code, like the other collection refusals",
    /status\(409\)[\s\S]{0,200}PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN/.test(indexJs));
}

console.log("");
console.log("Totale: " + (pass + fail) + " | PASS: " + pass + " | FAIL: " + fail);
process.exit(fail === 0 ? 0 : 1);
