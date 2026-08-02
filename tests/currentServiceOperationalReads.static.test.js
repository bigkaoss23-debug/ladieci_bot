"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("operator order board is lifecycle-scoped and uses an active allowlist", () => {
  const source = read("index.js");
  const block = source.slice(source.indexOf('if (action === "getOrdenes")'), source.indexOf('} else if (action === "getWaMsgs")'));
  assert.match(block, /getCurrentOperationalSession\(\)/);
  assert.match(block, /serviceSessionQuery\(/);
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

test("oven and delivery capacity ignore orders from closed services", () => {
  const source = read("src/agents/agentCucina.js");
  assert.match(source, /getCurrentOperationalSession\(\)/);
  assert.match(source, /serviceSessionQuery\(currentService\.id, "estado=eq\.EN_COCINA"\)/);
  assert.match(source, /serviceSessionQuery\([\s\S]*tipo_consegna=eq\.DOMICILIO/);
});
