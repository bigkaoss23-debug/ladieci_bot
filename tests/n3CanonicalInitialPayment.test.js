// tests/n3CanonicalInitialPayment.test.js — N-3 canonical initial payment for Nuevo Pedido:
// the pure intent-building contract, the refusal mapping, and static assertions on the
// migration, on the order writer, and on the two creation entry points.
//
// The DB-side behaviour (paid-at-creation writes exactly one canonical payment equal to the
// obligation; unpaid creation writes none; efectivo/tarjeta/bizum; discount ordering; retry
// idempotency; a refused payment rolls the whole order back; Mesa and legacy-flag refusals;
// N-5 still freezes the result) is proven separately by rollback-safe probes against real
// staging data, recorded in this slice's report.
// Run: node tests/n3CanonicalInitialPayment.test.js
const fs = require("fs");
const path = require("path");
const {
  PAYMENT_METHODS,
  CONTEXT_UNAVAILABLE,
  METHOD_INVALID,
  NOT_FOR_TABLE_ORDER,
  GENERIC_FAILURE,
  MESSAGES,
  requestsInitialPayment,
  buildInitialPaymentIntent,
  describeInitialPaymentFailure,
} = require("../src/financial/initialPaymentIntent");

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

const MIG = path.join(__dirname, "..", "migrations", "2026-08-24_n3_canonical_initial_payment.sql");
const ROLLBACK = path.join(__dirname, "..", "migrations", "2026-08-24_n3_canonical_initial_payment.ROLLBACK.sql");
const sql = fs.readFileSync(MIG, "utf8");
const rollbackSql = fs.readFileSync(ROLLBACK, "utf8");
// language-guard: allow-legacy agentOrdini.js is the existing module filename being read, not new vocabulary
const writersSrc = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "agentOrdini.js"), "utf8");
const indexJs = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

const OK_CTX = { actor: "owner", sv: 15 };
const ipHashOk = () => "a".repeat(32);
const ipHashNull = () => null;

console.log("\n── is a paid-at-creation actually being requested? ──");
{
  check("ya_pagado true requests it", requestsInitialPayment({ ya_pagado: true }) === true);
  check("the string 'true' also requests it (form-encoded callers)",
    requestsInitialPayment({ ya_pagado: "true" }) === true);
  check("ya_pagado false does not", requestsInitialPayment({ ya_pagado: false }) === false);
  check("absent does not", requestsInitialPayment({ metodo_pago: "efectivo" }) === false);
  check("a non-object is safe", requestsInitialPayment(null) === false);
}

console.log("\n── unpaid creation is completely untouched ──");
{
  const r = buildInitialPaymentIntent({ body: { ya_pagado: false }, authCtx: OK_CTX, ipHash: ipHashOk });
  check("no intent is built", r.ok === true && r.intent === null);
  const noCtx = buildInitialPaymentIntent({ body: {}, authCtx: null, ipHash: ipHashNull });
  check("an unpaid order does NOT need a verified context (the bot/Mesa keep working)",
    noCtx.ok === true && noCtx.intent === null);
}

console.log("\n── the intent carries only verified, server-side values ──");
{
  const r = buildInitialPaymentIntent({
    body: { ya_pagado: true, metodo_pago: "efectivo", actor: "forged", sv: 999 },
    authCtx: OK_CTX, ipHash: ipHashOk, trustedClientIp: "1.2.3.4",
  });
  check("an intent is built", r.ok === true && !!r.intent);
  check("actor comes from the verified context, never the body", r.intent.actor === "owner");
  check("sv comes from the verified context, never the body", r.intent.sv === 15);
  check("method is normalized to canonical vocabulary", r.intent.method === "efectivo");
  check("ip_hash is present", typeof r.intent.ip_hash === "string" && r.intent.ip_hash.length > 0);
  check("the intent carries nothing else (no amount, no flags)",
    Object.keys(r.intent).sort().join(",") === "actor,ip_hash,method,sv");
  check("an amount is NEVER carried — SQL derives it from ordenes.totale",
    !("amount" in r.intent) && !("totale" in r.intent));
}
{
  const upper = buildInitialPaymentIntent({
    body: { ya_pagado: true, metodo_pago: "  TARJETA " }, authCtx: OK_CTX, ipHash: ipHashOk,
  });
  check("method is trimmed and lowercased", upper.ok === true && upper.intent.method === "tarjeta");
  for (const m of PAYMENT_METHODS) {
    const r = buildInitialPaymentIntent({ body: { ya_pagado: true, metodo_pago: m }, authCtx: OK_CTX, ipHash: ipHashOk });
    check(`${m} is accepted`, r.ok === true && r.intent.method === m);
  }
}

console.log("\n── fail closed: never silently create an unpaid order ──");
{
  const noMethod = buildInitialPaymentIntent({ body: { ya_pagado: true }, authCtx: OK_CTX, ipHash: ipHashOk });
  check("paid with no method is refused", noMethod.ok === false && noMethod.code === METHOD_INVALID);
  const alias = buildInitialPaymentIntent({ body: { ya_pagado: true, metodo_pago: "paypal" }, authCtx: OK_CTX, ipHash: ipHashOk });
  check("a non-canonical method is refused (no aliases invented)",
    alias.ok === false && alias.code === METHOD_INVALID);
  const noCtx = buildInitialPaymentIntent({ body: { ya_pagado: true, metodo_pago: "efectivo" }, authCtx: null, ipHash: ipHashOk });
  check("no verified context is refused, NOT downgraded to unpaid",
    noCtx.ok === false && noCtx.code === CONTEXT_UNAVAILABLE);
  const noSv = buildInitialPaymentIntent({ body: { ya_pagado: true, metodo_pago: "efectivo" }, authCtx: { actor: "owner" }, ipHash: ipHashOk });
  check("a context without session_version is refused", noSv.ok === false && noSv.code === CONTEXT_UNAVAILABLE);
  const badSv = buildInitialPaymentIntent({ body: { ya_pagado: true, metodo_pago: "efectivo" }, authCtx: { actor: "owner", sv: 0 }, ipHash: ipHashOk });
  check("session_version 0 is refused", badSv.ok === false && badSv.code === CONTEXT_UNAVAILABLE);
  const noIp = buildInitialPaymentIntent({ body: { ya_pagado: true, metodo_pago: "efectivo" }, authCtx: OK_CTX, ipHash: ipHashNull });
  check("a null ip_hash (IP_SECRET unset) is refused here, not at the trigger",
    noIp.ok === false && noIp.code === CONTEXT_UNAVAILABLE);
  const mesa = buildInitialPaymentIntent({
    body: { ya_pagado: true, metodo_pago: "efectivo", table_session_id: "9f0d-…" },
    authCtx: OK_CTX, ipHash: ipHashOk,
  });
  check("a table order is refused — Mesa settles through its own hub",
    mesa.ok === false && mesa.code === NOT_FOR_TABLE_ORDER);
  check("every refusal carries an operator sentence, never a bare code",
    [noMethod, noCtx, mesa].every((r) => typeof r.message === "string" && r.message.length > 20
      && !r.message.includes("INITIAL_PAYMENT")));
}

console.log("\n── recognising the refusal that came back from the DB ──");
{
  const pgErr = { code: "P0001", message: "AUTH_SESSION_STALE", details: "…", hint: null };
  const d = describeInitialPaymentFailure(pgErr);
  check("a canonical-writer refusal is recognised", !!d && d.code === "AUTH_SESSION_STALE");
  check("it maps to a specific Spanish sentence",
    d.message === MESSAGES.AUTH_SESSION_STALE && d.message !== GENERIC_FAILURE);
  check("the trigger's own codes are recognised too",
    describeInitialPaymentFailure({ message: "INITIAL_PAYMENT_LEGACY_FLAG_PRESENT" }).code
      === "INITIAL_PAYMENT_LEGACY_FLAG_PRESENT");
  check("recognised from `details` alone",
    describeInitialPaymentFailure({ details: "x AUTH_FORBIDDEN_ROLE y" }).code === "AUTH_FORBIDDEN_ROLE");
  check("a role refusal tells the operator what to do instead",
    MESSAGES.AUTH_FORBIDDEN_ROLE.includes("sin marcar Pagado"));
}
{
  check("an id-collision error is NOT a payment refusal",
    describeInitialPaymentFailure({ code: "23505", message: 'duplicate key value violates unique constraint "ordenes_pkey"' }) === null);
  check("a client_req_id collision is NOT a payment refusal (the idempotent branch must still run)",
    describeInitialPaymentFailure({ code: "23505", details: "Key (client_req_id)=(abc) already exists." }) === null);
  check("an unrelated error is not a refusal",
    describeInitialPaymentFailure({ code: "42703", message: "column x does not exist" }) === null);
  check("an empty/absent body is not a refusal",
    describeInitialPaymentFailure(null) === null && describeInitialPaymentFailure({}) === null);
  check("a successful insert (row array) is not a refusal",
    describeInitialPaymentFailure([{ id: "#42" }]) === null);
}

console.log("\n── migration: atomic by construction, delegating to ONE writer ──");
{
  check("the trigger is AFTER INSERT on ordenes", /AFTER INSERT ON public\.ordenes/.test(sql));
  check("it is WHEN-scoped, so every intent-less creation skips it entirely",
    /WHEN \(NEW\.initial_payment_intent IS NOT NULL\)/.test(sql));
  check("it is named to sort AFTER the N-2 obligation anchor",
    "ordenes_order_obligation_anchor_v1" < "ordenes_paid_at_creation_payment_v1"
      && /CREATE TRIGGER ordenes_paid_at_creation_payment_v1/.test(sql));
  check("the migration ASSERTS that firing order rather than assuming it",
    /would fire the payment before the obligation/.test(sql));
  check("it delegates to the canonical writer", /PERFORM public\.order_mark_paid\(/.test(sql));
  check("it writes NO ledger row of its own",
    !/INSERT INTO public\.order_financial_events/.test(sql));
  check("a post-condition forbids it ever writing the ledger directly",
    /must not write order_financial_events directly/.test(sql));
  check("the idempotency key is the canonical per-order one",
    /'pay-order-' \|\| regexp_replace\(NEW\.id/.test(sql));
  check("no amount is passed to the writer — SQL derives it",
    !/p_amount|'amount'\s*,\s*NEW\.totale/.test(sql));
}

console.log("\n── migration: the legacy flag is an OUTPUT, never an input ──");
{
  check("the trigger refuses an order that already carries a legacy paid flag",
    /INITIAL_PAYMENT_LEGACY_FLAG_PRESENT/.test(sql));
  check("it refuses table orders (Mesa has its own hub)",
    /INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER/.test(sql));
  check("it validates the method against canonical vocabulary",
    /v_method NOT IN \('efectivo','tarjeta','bizum'\)/.test(sql));
  check("it refuses an unverifiable context", /INITIAL_PAYMENT_CONTEXT_INVALID/.test(sql));
  check("AUTH_LEGACY_IMPORT_REQUIRED is left intact (never dropped or weakened)",
    !/DROP|REPLACE/.test((sql.match(/.*AUTH_LEGACY_IMPORT_REQUIRED.*/g) || []).join(" ")));
  check("_ledger_write_payment is not redefined here",
    !/CREATE OR REPLACE FUNCTION public\._ledger_write_payment/.test(sql));
  check("order_mark_paid is not redefined here",
    !/CREATE OR REPLACE FUNCTION public\.order_mark_paid/.test(sql));
}

console.log("\n── migration: the intent column is ephemeral and safe ──");
{
  check("the column is added, nullable jsonb", /ADD COLUMN initial_payment_intent jsonb/.test(sql));
  check("the trigger clears it in the same transaction",
    /UPDATE public\.ordenes SET initial_payment_intent = NULL WHERE id = NEW\.id/.test(sql));
  check("a CHECK constrains its shape and method", /ordenes_initial_payment_intent_chk/.test(sql));
  check("the CHECK pins the canonical methods",
    /initial_payment_intent->>'method' IN \('efectivo','tarjeta','bizum'\)/.test(sql));
  check("the CHECK caps its size", /length\(initial_payment_intent::text\) <= 512/.test(sql));
  check("a post-condition proves no existing order carries an intent",
    /no existing order may carry an intent/.test(sql));
  check("a post-condition proves the browser still cannot write orders",
    /anon\/authenticated must not be able to write orders/.test(sql));
  check("browser roles cannot EXECUTE the trigger function",
    /REVOKE ALL ON FUNCTION public\.order_initial_payment_v1\(\) FROM PUBLIC, anon, authenticated/.test(sql));
  check("search_path is pinned", /SET search_path TO 'public', 'pg_temp'/.test(sql));
  check("it refuses a double apply", /N-3 refused: ordenes\.initial_payment_intent already exists/.test(sql));
  check("it refuses to run without N-2", /N-3 refused: the N-2 obligation anchor is missing/.test(sql));
  check("it refuses to run without N-5", /N-3 refused: the N-5 economic mutation guard is missing/.test(sql));
  check("it writes no business DML",
    !/^\s*(INSERT INTO|UPDATE) public\.(ordenes|order_obligations|order_financial_events)/m
      .test(sql.replace(/\$fn\$[\s\S]*\$fn\$/, "")));
}

console.log("\n── migration: rollback is honest about money ──");
{
  check("rollback drops the trigger and the function",
    /DROP TRIGGER IF EXISTS ordenes_paid_at_creation_payment_v1/.test(rollbackSql)
      && /DROP FUNCTION IF EXISTS public\.order_initial_payment_v1/.test(rollbackSql));
  check("it NEVER deletes the canonical payments this slice caused",
    !/DELETE FROM public\.order_financial_events/.test(rollbackSql));
  check("it says so explicitly", /Deleting evidence of money that was\n-- genuinely collected/.test(rollbackSql));
  check("it preserves the column if any intent were stranded",
    /column PRESERVED for inspection/.test(rollbackSql));
  check("it verifies N-2, N-5 and Mesa survived",
    /the N-2 obligation anchor was collaterally removed/.test(rollbackSql)
      && /the N-5 economic mutation guard was collaterally removed/.test(rollbackSql)
      && /the Mesa line-snapshot trigger was collaterally removed/.test(rollbackSql));
}

console.log("\n── the order writer: pay-at-creation legacy is retired ──");
{
  check("ya_pagado is hard-coded false — no longer accepted from any caller",
    /ya_pagado:\s*false,/.test(writersSrc) && !/ya_pagado:\s*params\.ya_pagado/.test(writersSrc));
  check("metodo_pago is left to the canonical writer when an intent is present",
    /metodo_pago:\s*initialPaymentIntent \? "" : \(params\.metodo_pago \|\| ""\)/.test(writersSrc));
  check("the intent is attached to the INSERT",
    /initial_payment_intent: initialPaymentIntent/.test(writersSrc));
  check("the intent comes from the caller, never derived from the body here",
    /const initialPaymentIntent = params\.initial_payment_intent \|\| null;/.test(writersSrc));
  check("a refused payment is returned as a typed failure, not 'errore DB'",
    /const paymentRefusal = describeInitialPaymentFailure\(result\);/.test(writersSrc));
  // The ordering below is the one that matters: a payment refusal must NOT reach the
  // 23505 branch, or a refused payment would be retried once per fresh order id.
  check("the payment-refusal check precedes the id-collision retry branch",
    writersSrc.indexOf("const paymentRefusal = describeInitialPaymentFailure(result);")
      < writersSrc.indexOf('if (errCode === "23505")'));
}

console.log("\n── both creation entry points build the intent from verified context ──");
{
  const built = (indexJs.match(/buildInitialPaymentIntent\(\{/g) || []).length;
  check("both creation actions build an intent", built === 2);
  check("the body is never trusted for the actor",
    (indexJs.match(/authCtx: req\.authCtx, ipHash, trustedClientIp: trustedClientIp\(req\)/g) || []).length === 2);
  check("a refusal answers 409 with the typed code and message",
    (indexJs.match(/status\(409\)[\s\S]{0,180}code: intent[AB]\.code/g) || []).length === 2);
  {
    // Scope to the Nuevo Pedido branch itself rather than measuring character distance,
    // which a comment or a reformat would silently break.
    const start = indexJs.indexOf('action === "createOrden"');
    const branch = start === -1 ? "" : indexJs.slice(start, start + 1600);
    check("createOrden now threads the verified actor too (attribution gap closed)",
      branch.includes("const intentB = buildInitialPaymentIntent(")
        && branch.includes("actor_id: req.authCtx?.actor || null,"));
  }
  check("the intent is passed into the order writer at both sites",
    (indexJs.match(/initial_payment_intent: intent[AB]\.intent,/g) || []).length === 2);
}

console.log("");
console.log("Totale: " + (pass + fail) + " | PASS: " + pass + " | FAIL: " + fail);
process.exit(fail === 0 ? 0 : 1);
