// tests/s4PendingGiroIntentBuilder.test.js — S4 operator-intent prerequisite (DORMANT):
// the pure builder contract (S4-I01..I11) and the trusted HTTP plumbing that calls it
// (S4-H01..H06). Mirrors tests/n3CanonicalInitialPayment.test.js's structure and the same
// static-source-reading technique for the index.js assertions.
//
// The DB/trigger side (capture_giro_intent_v1, consume_intent_v1, the W5 capture trigger
// itself) is untouched by this packet and is certified separately, elsewhere. This file
// proves only: the builder never throws and never guesses, the trust boundary (actor/sv
// from authCtx only) holds, and both HTTP operator actions call it correctly.
//
// Run: node tests/s4PendingGiroIntentBuilder.test.js
const fs = require("fs");
const path = require("path");
const { buildPendingGiroIntentV1 } = require("../src/delivery/pendingGiroIntent");

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

const indexJs = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

const OK_CTX = { actor: "owner", sv: 7 };
const GIRO_CAND = { giroId: "G-42", anchorOrderId: "#101", isGiro: true };
const ANCHOR_CAND = { giroId: "#101", anchorOrderId: "#101", isGiro: false };

console.log("\n── S4-I01 no candidate → intent null ──");
{
  check("undefined body", buildPendingGiroIntentV1({ body: undefined, authCtx: OK_CTX }).intent === null);
  check("body with no pending_giro_intent key", buildPendingGiroIntentV1({ body: {}, authCtx: OK_CTX }).intent === null);
  check("pending_giro_intent explicitly null", buildPendingGiroIntentV1({ body: { pending_giro_intent: null }, authCtx: OK_CTX }).intent === null);
}

console.log("\n── S4-I02 valid GIRO candidate + valid authCtx → exact V1 payload ──");
{
  const r = buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: OK_CTX });
  check("intent built", !!r.intent);
  check("v is literal 1", r.intent.v === 1);
  check("target_kind GIRO", r.intent.target_kind === "GIRO");
  check("target_ref is giroId", r.intent.target_ref === "G-42");
  check("source is the literal operator_http", r.intent.source === "operator_http");
  check("actor from authCtx", r.intent.actor === "owner");
  check("sv serialized as a digit string", r.intent.sv === "7");
  check("intent carries exactly these 6 fields, nothing else",
    Object.keys(r.intent).sort().join(",") === "actor,source,sv,target_kind,target_ref,v");
}

console.log("\n── S4-I03 valid ANCHOR candidate + valid authCtx → exact V1 payload ──");
{
  const r = buildPendingGiroIntentV1({ body: { pending_giro_intent: ANCHOR_CAND }, authCtx: OK_CTX });
  check("intent built", !!r.intent);
  check("target_kind ANCHOR", r.intent.target_kind === "ANCHOR");
  check("target_ref is anchorOrderId", r.intent.target_ref === "#101");
  check("v/source/actor/sv unchanged shape", r.intent.v === 1 && r.intent.source === "operator_http"
    && r.intent.actor === "owner" && r.intent.sv === "7");
}
{
  // ANCHOR with no distinct anchorOrderId falls back to giroId, per the target mapping rule.
  const r = buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "#101", anchorOrderId: null, isGiro: false } }, authCtx: OK_CTX,
  });
  check("ANCHOR falls back to giroId when anchorOrderId is absent", r.intent && r.intent.target_ref === "#101");
}

console.log("\n── S4-I04 candidate missing isGiro → null, no guessing ──");
{
  check("isGiro undefined", buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "G-1", anchorOrderId: "#1" } }, authCtx: OK_CTX,
  }).intent === null);
  check("isGiro null", buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "G-1", anchorOrderId: "#1", isGiro: null } }, authCtx: OK_CTX,
  }).intent === null);
  check("isGiro non-boolean truthy (string 'true')", buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "G-1", anchorOrderId: "#1", isGiro: "true" } }, authCtx: OK_CTX,
  }).intent === null);
  check("isGiro 1 (number)", buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "G-1", anchorOrderId: "#1", isGiro: 1 } }, authCtx: OK_CTX,
  }).intent === null);
}

console.log("\n── S4-I05 client supplies actor → ignored, trusted authCtx.actor used ──");
{
  const r = buildPendingGiroIntentV1({
    body: { pending_giro_intent: { ...GIRO_CAND, actor: "forged_client_actor" } }, authCtx: OK_CTX,
  });
  check("actor is authCtx's, never the candidate's", r.intent && r.intent.actor === "owner" && r.intent.actor !== "forged_client_actor");
}

console.log("\n── S4-I06 client supplies sv → ignored, trusted authCtx.sv used ──");
{
  const r = buildPendingGiroIntentV1({
    body: { pending_giro_intent: { ...GIRO_CAND, sv: 999 } }, authCtx: OK_CTX,
  });
  check("sv is authCtx's, never the candidate's", r.intent && r.intent.sv === "7" && r.intent.sv !== "999");
}

console.log("\n── S4-I07 missing/invalid auth actor → null ──");
{
  check("authCtx null", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: null }).intent === null);
  check("authCtx.actor missing", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { sv: 7 } }).intent === null);
  check("authCtx.actor blank", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { actor: "   ", sv: 7 } }).intent === null);
  check("authCtx.actor non-string", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { actor: 123, sv: 7 } }).intent === null);
}

console.log("\n── S4-I08 missing/invalid auth sv → null ──");
{
  check("sv missing", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { actor: "owner" } }).intent === null);
  check("sv zero", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { actor: "owner", sv: 0 } }).intent === null);
  check("sv negative", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { actor: "owner", sv: -1 } }).intent === null);
  check("sv non-integer", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { actor: "owner", sv: 1.5 } }).intent === null);
  check("sv as string", buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx: { actor: "owner", sv: "7" } }).intent === null);
}

console.log("\n── S4-I09 malformed target_ref → null ──");
{
  check("empty giroId", buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "", anchorOrderId: "#1", isGiro: true } }, authCtx: OK_CTX,
  }).intent === null);
  check("giroId over 64 chars", buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "G".repeat(65), anchorOrderId: "#1", isGiro: true } }, authCtx: OK_CTX,
  }).intent === null);
  check("ANCHOR with both refs missing", buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: null, anchorOrderId: null, isGiro: false } }, authCtx: OK_CTX,
  }).intent === null);
  check("target_ref exactly 64 chars is accepted (boundary)", !!buildPendingGiroIntentV1({
    body: { pending_giro_intent: { giroId: "G".repeat(64), anchorOrderId: "#1", isGiro: true } }, authCtx: OK_CTX,
  }).intent);
}

console.log("\n── S4-I10 builder never throws for hostile/random body shapes ──");
{
  const hostile = [
    undefined, null, 42, "string", true, [], [1, 2, 3],
    { pending_giro_intent: "not-an-object" },
    { pending_giro_intent: 42 },
    { pending_giro_intent: [] },
    { pending_giro_intent: { isGiro: true, giroId: { nested: "object" } } },
    { pending_giro_intent: { isGiro: true, giroId: Symbol("x") } },
    { pending_giro_intent: { toString() { throw new Error("boom"); } } },
    { get pending_giro_intent() { throw new Error("boom"); } },
  ];
  let threw = false;
  for (const body of hostile) {
    try { buildPendingGiroIntentV1({ body, authCtx: OK_CTX }); } catch (_) { threw = true; }
  }
  check("zero throws across all hostile shapes", threw === false);

  const hostileAuth = [undefined, null, 42, "string", [], { actor: {} }, { actor: "owner", sv: {} }, { get sv() { throw new Error("boom"); } }];
  let threwAuth = false;
  for (const authCtx of hostileAuth) {
    try { buildPendingGiroIntentV1({ body: { pending_giro_intent: GIRO_CAND }, authCtx }); } catch (_) { threwAuth = true; }
  }
  check("zero throws across all hostile authCtx shapes", threwAuth === false);

  check("no-args call does not throw", (() => { try { buildPendingGiroIntentV1(); return true; } catch (_) { return false; } })());
}

console.log("\n── S4-I11 builder performs zero I/O ──");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "delivery", "pendingGiroIntent.js"), "utf8");
  check("no await anywhere in the module", !/\bawait\b/.test(src));
  check("no async function declared", !/\basync\s+function/.test(src));
  check("no require of supabase/sbSelect/sbInsert/sbRpc/sbUpdate", !/require\(.*supabase.*\)/i.test(src));
  check("no fetch/http/axios reference", !/\b(fetch|axios|http\.request|https\.request)\b/.test(src));
  check("only one require in the whole file (none — pure, zero dependencies)", !/require\(/.test(src));
}

console.log("\n── S4-H01 createOrden calls builder with req.authCtx ──");
{
  const start = indexJs.indexOf('action === "createOrden"');
  const branch = start === -1 ? "" : indexJs.slice(start, start + 2200);
  check("createOrden branch found", start !== -1);
  check("builder called with body:d and authCtx:req.authCtx",
    branch.includes("buildPendingGiroIntentV1({ body: d, authCtx: req.authCtx })"));
}

// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
console.log("\n── S4-H02 creaOrdine action calls builder with req.authCtx ──");
{
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  const start = indexJs.indexOf('action === "creaOrdine"');
  const nextAction = indexJs.indexOf('} else if (action ===', start + 1);
  const branch = start === -1 ? "" : indexJs.slice(start, nextAction === -1 ? start + 2200 : nextAction);
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  check("creaOrdine branch found", start !== -1);
  check("builder called with body:req.body and authCtx:req.authCtx",
    branch.includes("buildPendingGiroIntentV1({ body: req.body, authCtx: req.authCtx })"));
}

console.log("\n── S4-H03 trusted builder result overrides any body.pending_giro_intent ──");
{
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  check("both call sites pass pending_giro_intent: giroIntent{A,B}.intent into creaOrdine(), AFTER the body spread",
    (indexJs.match(/\.\.\.(?:req\.body|d),[\s\S]{0,220}pending_giro_intent: giroIntent[AB]\.intent,/g) || []).length === 2);
}

console.log("\n── S4-H04 body.actor cannot become payload actor ──");
{
  // The builder itself never reads candidate.actor (proven functionally in S4-I05); this
  // proves index.js doesn't thread any body-derived actor field into the builder call either.
  check("neither call site passes a body-derived actor into the builder call",
    !/buildPendingGiroIntentV1\(\{[^}]*actor:/s.test(indexJs));
}

console.log("\n── S4-H05 body.sv cannot become payload sv ──");
{
  check("neither call site passes a body-derived sv into the builder call",
    !/buildPendingGiroIntentV1\(\{[^}]*\bsv:/s.test(indexJs));
}

console.log("\n── S4-H06 WhatsApp/orchestrator does not invoke builder ──");
{
  const orchestratorSrc = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "orchestrator.js"), "utf8");
  check("orchestrator.js never requires the builder", !orchestratorSrc.includes("pendingGiroIntent"));
  check("orchestrator.js never calls buildPendingGiroIntentV1", !orchestratorSrc.includes("buildPendingGiroIntentV1"));
  const mesaSrc = fs.readFileSync(path.join(__dirname, "..", "src", "tables", "mesaService.js"), "utf8");
  check("mesaService.js never requires/calls the builder either (no Planner-intent wiring added to Mesa)",
    !mesaSrc.includes("pendingGiroIntent") && !mesaSrc.includes("buildPendingGiroIntentV1"));
}

console.log("");
console.log("Totale: " + (pass + fail) + " | PASS: " + pass + " | FAIL: " + fail);
process.exit(fail === 0 ? 0 : 1);
