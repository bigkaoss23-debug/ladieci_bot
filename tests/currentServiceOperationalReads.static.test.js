"use strict";
// language-guard: allow-legacy PRANZO is the existing service_kind enum value, named in this file's own comments to describe the P0-C2 boundary, not new vocabulary

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("operator order board is lifecycle-scoped and uses an active allowlist", () => {
  const source = read("index.js");
  const block = source.slice(source.indexOf('if (action === "getOrdenes")'), source.indexOf('} else if (action === "getWaMsgs")'));
  // P0-C2 — widened from the single-session getCurrentOperationalSession/
  // serviceSessionQuery to the (still lifecycle-authoritative, still
  // fail-closed) multi-id getOperationalSessionIds/serviceSessionsQuery,
  // language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
  // so an intraday-carried table's orders stay visible across a PRANZO->SERA
  // rollover — see SERVICE_LIFECYCLE_ECONOMIC_BOUNDARY_AUDIT_REPORT.md and
  // P0_C2_INTRADAY_ECONOMIC_BOUNDARY_REPORT.md.
  assert.match(block, /getOperationalSessionIds\(/);
  assert.match(block, /serviceSessionsQuery\(/);
  assert.match(block, /estado=in\.\(POR_CONFIRMAR,NUEVO,EN_COCINA,LISTO,EN_ENTREGA\)/);
  assert.doesNotMatch(block, /estado=not\.in/);
});

test("close preview scopes orders, tables, and legacy conversations to the current service window", () => {
  const source = read("src/utils/servizio.js");
  const block = source.slice(source.indexOf("async function scanServizio"), source.indexOf("// ─── Backup raw"));
  assert.match(block, /getCurrentOperationalSession\(\)/);
  assert.match(block, /serviceSessionQuery\(currentService\.id/);
  assert.match(block, /table_sessions[\s\S]*sessionFilter\("status=eq\.open"\)/);
  assert.match(block, /conversationWindow = `ts=gte\.\$\{openedAtMs\}`/);
});

test("service backup is scoped and the close passes its immutable session id", () => {
  const source = read("src/utils/servizio.js");
  assert.match(source, /async function backupSerata\(\{ serviceSessionId = null \} = \{\}\)/);
  assert.match(source, /serviceSessionQuery\(targetSessionId, "select=\*"\)/);
  assert.match(source, /backupSerata\(\{ serviceSessionId \}\)/);
  assert.doesNotMatch(source, /sbSelect\("ordenes", "select=\*"\)/);
});

// P0-C3 — widened from the single-session getCurrentOperationalSession()/
// serviceSessionQuery() to the business-date-scoped getOperationalSessionIds()/
// serviceSessionsQuery(), same primitives getOrdenes itself now uses: real
// oven/delivery capacity must include a same-business-date carried session's
// still-active orders, or capacity checks under-count and over-promise new
// language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
// slots the moment an intraday PRANZO->SERA rollover happens. Still correctly
// excludes anything outside the current business_date (P0_C3 report §4/§5).
test("oven and delivery capacity ignore orders from closed services or a previous business_date", () => {
  const source = read("src/agents/agentCucina.js");
  assert.match(source, /getOperationalSessionIds\(\{ select: sbSelect \}\)/);
  assert.match(source, /serviceSessionsQuery\(sessionIds, "estado=eq\.EN_COCINA"\)/);
  // language-guard: allow-legacy tipo_consegna is the existing column name this test already asserts on elsewhere, not new vocabulary
  assert.match(source, /serviceSessionsQuery\([\s\S]*tipo_consegna=eq\.DOMICILIO/);
});
