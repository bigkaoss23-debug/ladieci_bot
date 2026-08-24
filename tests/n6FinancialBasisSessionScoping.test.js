// tests/n6FinancialBasisSessionScoping.test.js — N-6 financial basis session scoping.
// NON-EXECUTING: inspects SQL + JS text. No DB, no apply.
//
// THE INVARIANT THIS FILE OWNS: "events belonging to this order" must have exactly ONE
// definition across all four financial writers. N-6 deliberately did NOT introduce a
// shared SQL helper (the certified _ledger_write_payment must stay untouched, so a
// helper would be used by three functions and not the fourth). The single definition is
// therefore enforced HERE, by asserting the identical predicate text in all four and by
// asserting that every financial lookup carries it.
//
// The behavioural proof (a refund/void/import on a colliding display id sees only its
// own service's money; the generated event stays in the target service; ambiguous
// ownership fails closed; idempotency replays in-session and refuses cross-session)
// runs separately as rollback-safe probes against real staging -- see this slice's report.
// Run: node tests/n6FinancialBasisSessionScoping.test.js
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const FWD = "migrations/2026-08-24_n6_financial_basis_session_scoping.sql";
const RB = "migrations/2026-08-24_n6_financial_basis_session_scoping.ROLLBACK.sql";
const sql = read(FWD);
const rollbackSql = read(RB);
const dao = read("src/auth/financialDao.js");

// The reference predicate, character for character as _ledger_write_payment carries it.
const PREDICATE = "service_session_id IS NOT DISTINCT FROM v_ord.service_session_id";

// Extract one function body from a migration file.
function bodyOf(text, name) {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start === -1) return "";
  const end = text.indexOf("$function$;", start);
  return end === -1 ? "" : text.slice(start, end);
}
const countOf = (hay, needle) => hay.split(needle).length - 1;

const TARGETS = [
  { name: "order_refund", lookups: 4 },
  { name: "order_void", lookups: 2 },
  { name: "order_import_legacy_payment", lookups: 2 },
];

console.log("\n── every financial lookup is session-scoped ──");
for (const { name, lookups } of TARGETS) {
  const body = bodyOf(sql, name);
  check(`${name} is redefined by this migration`, body.length > 0);
  const found = countOf(body, "FROM public.order_financial_events");
  check(`${name} has exactly ${lookups} financial lookup(s)`, found === lookups);
  check(`${name} carries the predicate on EVERY one of them`,
    countOf(body, PREDICATE) === lookups);
  check(`${name} has no lookup left on order_id alone`, found === countOf(body, PREDICATE));
}

console.log("\n── the predicate is IDENTICAL to the reference implementation ──");
{
  // All three must use the exact same text — not a paraphrase, not `=`, not a
  // COALESCE, which would silently differ on NULL sessions.
  const bodies = TARGETS.map((t) => bodyOf(sql, t.name));
  check("no function substitutes plain equality for the NULL-correct form",
    bodies.every((b) => !/service_session_id\s*=\s*v_ord\.service_session_id/.test(b)));
  check("no function paraphrases it with COALESCE",
    bodies.every((b) => !/COALESCE\([^)]*service_session_id/.test(b)));
  check("the migration asserts the reference still carries the predicate before copying it",
    /_ledger_write_payment does not carry the reference scoping predicate/.test(sql));
  check("the migration does NOT redefine the reference implementation",
    !/CREATE OR REPLACE FUNCTION public\._ledger_write_payment/.test(sql));
  check("a post-condition proves the reference kept its predicate",
    /_ledger_write_payment lost its scoping predicate/.test(sql));
}

console.log("\n── the authoritative session comes from the order row ──");
for (const { name } of TARGETS) {
  const body = bodyOf(sql, name);
  check(`${name} reads the order under FOR UPDATE before any basis lookup`,
    body.indexOf("FROM public.ordenes WHERE id = p_order_id FOR UPDATE")
      < body.indexOf("FROM public.order_financial_events")
      && body.includes("FROM public.ordenes WHERE id = p_order_id FOR UPDATE"));
  check(`${name} takes no caller-supplied service session`,
    !/p_service_session_id|p_session_id/.test(body));
}

console.log("\n── ambiguous ownership fails closed ──");
for (const { name } of TARGETS) {
  const body = bodyOf(sql, name);
  check(`${name} refuses when the target order has no service session`,
    /IF v_ord\.service_session_id IS NULL THEN/.test(body)
      && body.includes("ORDER_WITHOUT_SERVICE_SESSION"));
  check(`${name} refuses BEFORE touching the ledger`,
    body.indexOf("ORDER_WITHOUT_SERVICE_SESSION") < body.indexOf("FROM public.order_financial_events"));
}
{
  check("it reuses the EXISTING code, inventing no second vocabulary",
    /already raised by\n-- `service_session_assign_financial_event`|EXISTING code `ORDER_WITHOUT_SERVICE_SESSION`/.test(sql));
  check("the DAO recognises it instead of collapsing to an opaque internal error",
    /'ORDER_WITHOUT_SERVICE_SESSION',/.test(dao));
  check("the DAO still collapses anything unrecognised", /INTERNAL_ERROR_CODE/.test(dao));
}

console.log("\n── nothing else about these functions changed ──");
{
  const refund = bodyOf(sql, "order_refund");
  const voidBody = bodyOf(sql, "order_void");
  const imp = bodyOf(sql, "order_import_legacy_payment");
  // Prior B7 fixes must survive: session_version guard, replay-basis integrity, void digest.
  check("refund keeps the session_version guard", /p_session_version <> v_by\.session_version/.test(refund));
  check("refund keeps the historical replay-basis integrity check",
    /AUTH_REFUND_BASIS_INTEGRITY/.test(refund) && /basis_event_id/.test(refund));
  check("refund keeps its admin-only gate", /v_role <> 'admin'/.test(refund));
  check("refund still derives amount and method from the basis, never a caller",
    /VALUES \(p_order_id, 'refund', v_basis\.amount, v_basis\.payment_method/.test(refund));
  check("void keeps its replay-integrity check", /AUTH_VOID_REPLAY_INTEGRITY/.test(voidBody));
  check("void keeps its state gate", /AUTH_VOID_STATE_FORBIDDEN/.test(voidBody));
  check("void still writes amount 0 / method NULL", /VALUES \(p_order_id, 'void', 0, NULL/.test(voidBody));
  check("import keeps the explicit confirmation", /IMPORT_LEGACY_PAYMENT/.test(imp));
  check("import keeps the legacy-paid precondition", /AUTH_NOT_LEGACY_PAID/.test(imp));
  check("import keeps its admin-only gate", /v_role <> 'admin'/.test(imp));
  check("import authority is not broadened", /legacy-import authority was weakened/.test(sql));
  check("no digest computation was altered",
    countOf(sql, "sha256(convert_to(") === 6);
}

console.log("\n── the migration writes no data and asserts its own scope ──");
{
  check("no business DML on financial or order tables",
    !/^\s*(INSERT INTO|UPDATE|DELETE FROM) public\.(order_financial_events|order_obligations)/m
      .test(sql.replace(/\$function\$[\s\S]*?\$function\$/g, "")));
  check("it refuses a double apply", /order_refund is already session-scoped/.test(sql));
  check("it refuses without the ownership-assigning trigger",
    /financial_event_assign_service_session is missing/.test(sql));
  check("a post-condition pins each function's lookup count",
    /order_refund must have exactly 4 scoped financial lookups/.test(sql)
      && /order_void must have exactly 2 scoped financial lookups/.test(sql)
      && /order_import_legacy_payment must have exactly 2 scoped financial lookups/.test(sql));
  check("a post-condition proves event ownership stays inherited",
    /financial_event_assign_service_session disappeared/.test(sql));
  check("browser roles are revoked by name and service_role re-granted",
    /REVOKE ALL ON FUNCTION public\.order_refund[^\n]*FROM PUBLIC, anon, authenticated/.test(sql)
      && /GRANT EXECUTE ON FUNCTION public\.order_refund[^\n]*TO service_role/.test(sql));
  check("a post-condition proves no browser role holds EXECUTE",
    /a browser role holds EXECUTE on a financial RPC/.test(sql));
}

console.log("\n── rollback is honest and complete ──");
{
  for (const { name } of TARGETS) {
    check(`rollback restores ${name}`, bodyOf(rollbackSql, name).length > 0);
  }
  check("rollback removes every scoping clause", countOf(rollbackSql, PREDICATE) === 0);
  check("rollback removes the ownership guard",
    !/IF v_ord\.service_session_id IS NULL THEN/.test(rollbackSql));
  check("rollback deletes NO financial evidence",
    !/DELETE FROM public\.order_financial_events/.test(rollbackSql));
  check("rollback verifies the ledger is not empty afterwards",
    /evidence must never be deleted/.test(rollbackSql));
  check("rollback verifies the reference implementation was not collaterally unscoped",
    /_ledger_write_payment was collaterally unscoped/.test(rollbackSql));
  check("rollback states plainly what comes back",
    /resolve their financial basis from `order_id` ALONE/.test(rollbackSql));
  // The restored bodies must still carry every pre-N-6 contract.
  check("restored refund keeps its contract",
    /AUTH_NO_PAYMENT_BASIS/.test(rollbackSql) && /AUTH_ALREADY_REFUNDED/.test(rollbackSql));
  check("restored void keeps its contract", /AUTH_VOID_STATE_FORBIDDEN/.test(rollbackSql));
  check("restored import keeps its contract", /AUTH_NOT_LEGACY_PAID/.test(rollbackSql));
}

console.log("");
console.log("Totale: " + (pass + fail) + " | PASS: " + pass + " | FAIL: " + fail);
process.exit(fail === 0 ? 0 : 1);
