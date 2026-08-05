"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  scanText,
  isAllowlisted,
  compareToBaseline,
  parseAddedLines,
  countsByFileAndTerm,
} = require("../scripts/lib/domainLanguageGuard");
const { ALLOWLIST_PATTERNS } = require("../scripts/check-domain-language");

function violatingTerms(text) {
  return scanText(text, "fixture.js").violations.map((v) => v.term);
}

test("1. chiudiServizio is blocked (camelCase)", () => {
  // "chiudi" is itself blocked too (see term 15) — both halves of the split
  // camelCase identifier are checked independently.
  assert.deepEqual(violatingTerms("function chiudiServizio() {}"), ["chiudi", "servizio"]);
});

test("2. cerrarServicio passes", () => {
  assert.deepEqual(violatingTerms("function cerrarServicio() {}"), []);
});

test("3. serata_summary is blocked (snake_case)", () => {
  assert.deepEqual(violatingTerms("const t = 'serata_summary';"), ["serata"]);
});

test("4. resumen_cierre_servicio passes", () => {
  assert.deepEqual(violatingTerms("const t = 'resumen_cierre_servicio';"), []);
});

test("5. agentCucina is blocked", () => {
  assert.deepEqual(violatingTerms("const agentCucina = require('./agentCucina');"), ["cucina", "cucina"]);
});

test("6. agentCocina passes", () => {
  assert.deepEqual(violatingTerms("const agentCocina = require('./agentCocina');"), []);
});

test("7. COMPLETATO (all-caps enum) is blocked", () => {
  assert.deepEqual(violatingTerms("if (estado === 'COMPLETATO') return;"), ["completato"]);
});

test("8. COMPLETADO passes", () => {
  assert.deepEqual(violatingTerms("if (estado === 'COMPLETADO') return;"), []);
});

test("9. messa_open_session_v1 is blocked in a new runtime file (not allowlisted)", () => {
  const newFilePath = "src/tables/newMesaHandler.js";
  assert.equal(isAllowlisted(newFilePath, ALLOWLIST_PATTERNS), false);
  assert.deepEqual(violatingTerms("await rpc('messa_open_session_v1', args);"), ["messa"]);
});

test("10. the same term is allowed in an explicitly allowlisted historical migration", () => {
  const historicalPath = "migrations/2026-08-01_v3h_messa_billing_foundation.sql";
  assert.equal(isAllowlisted(historicalPath, ALLOWLIST_PATTERNS), true);
  const historicalTestPath = "tests/v3hMessaMigration.static.test.js";
  assert.equal(isAllowlisted(historicalTestPath, ALLOWLIST_PATTERNS), true);
});

test("11. an increase over the baseline fails", () => {
  const baseline = { entries: [{ file: "a.js", term: "servizio", count: 2 }] };
  const current = countsByFileAndTerm([
    { file: "a.js", term: "servizio" },
    { file: "a.js", term: "servizio" },
    { file: "a.js", term: "servizio" },
  ]);
  const cmp = compareToBaseline(current, baseline);
  assert.equal(cmp.ok, false);
  assert.equal(cmp.increasedEntries.length, 1);
  assert.equal(cmp.increasedEntries[0].count, 3);
  assert.equal(cmp.increasedEntries[0].baselineCount, 2);
});

test("12. a decrease from the baseline passes", () => {
  const baseline = { entries: [{ file: "a.js", term: "servizio", count: 5 }] };
  const current = countsByFileAndTerm([{ file: "a.js", term: "servizio" }]);
  const cmp = compareToBaseline(current, baseline);
  assert.equal(cmp.ok, true);
  assert.equal(cmp.increasedEntries.length, 0);
  assert.equal(cmp.newEntries.length, 0);
});

test("13. a motivated local suppression passes and is reported as a visible exception", () => {
  const text = [
    "// language-guard: allow-legacy kept until the B7 migration lands",
    "const x = chiudiServizio();",
  ].join("\n");
  const { violations, suppressions } = scanText(text, "fixture.js");
  assert.deepEqual(violations, []);
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0].line, 2);
  assert.match(suppressions[0].reason, /kept until the B7 migration lands/);
  assert.deepEqual(suppressions[0].terms.sort(), ["chiudi", "servizio"]);
});

test("14. a suppression without a reason fails", () => {
  const text = [
    "// language-guard: allow-legacy",
    "const x = chiudiServizio();",
  ].join("\n");
  const { violations, invalidSuppressions } = scanText(text, "fixture.js");
  assert.equal(invalidSuppressions.length, 1);
  assert.equal(invalidSuppressions[0].line, 1);
  // With no valid motive the marker does not suppress anything either.
  assert.equal(violations.length, 2);
});

test("15. camelCase, snake_case, kebab-case and action strings are all recognized", () => {
  assert.deepEqual(violatingTerms("const action = 'creaOrdine';"), ["ordine"]);
  assert.deepEqual(violatingTerms("const tipo_ritiro = 'RITIRO';"), ["ritiro", "ritiro"]);
  assert.deepEqual(violatingTerms("// chiudi-servizio-action"), ["chiudi", "servizio"]);
  assert.deepEqual(violatingTerms("if (action === 'updateWaStato') {}"), []);
});

test("parseAddedLines: only + lines are reported, at their correct new-file line numbers", () => {
  const diff = [
    "diff --git a/src/foo.js b/src/foo.js",
    "index 1111111..2222222 100644",
    "--- a/src/foo.js",
    "+++ b/src/foo.js",
    "@@ -10,2 +10,3 @@",
    " unchanged line",
    "-const old = removed();",
    "+const nuevo = added1();",
    "+const otro = added2();",
    " unchanged line 2",
  ].join("\n");
  const added = parseAddedLines(diff);
  assert.deepEqual([...added.get("src/foo.js")].sort((a, b) => a - b), [11, 12]);
});

test("no false positive: 'message' does not match the 'messa' blocklist entry", () => {
  assert.deepEqual(violatingTerms("function handleMessage(message) { logMessages(); }"), []);
});
