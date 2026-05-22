// Test stand-alone per isAcceptableLocationType (DELIVERY-ETA-03).
// Eseguire: node src/utils/isAcceptableLocationType.test.js
const { isAcceptableLocationType } = require("./geoResolver");

const cases = [
  // [locationType, allowApproximate, expected, descrizione]
  ["ROOFTOP",            false, true,  "ROOFTOP sempre accettato"],
  ["ROOFTOP",            true,  true,  "ROOFTOP sempre accettato (anche con approximate)"],
  ["RANGE_INTERPOLATED", false, true,  "RANGE_INTERPOLATED sempre accettato"],
  ["RANGE_INTERPOLATED", true,  true,  "RANGE_INTERPOLATED sempre accettato (anche con approximate)"],
  ["GEOMETRIC_CENTER",   false, false, "GEOMETRIC_CENTER scartato in modalità default (civico richiesto)"],
  ["GEOMETRIC_CENTER",   true,  true,  "GEOMETRIC_CENTER accettato in retry stripped"],
  ["APPROXIMATE",        false, false, "APPROXIMATE sempre scartato"],
  ["APPROXIMATE",        true,  false, "APPROXIMATE scartato anche con allowApproximate (troppo basso)"],
  [null,                 false, false, "null scartato"],
  [null,                 true,  false, "null scartato (anche con approximate)"],
  [undefined,            false, false, "undefined scartato"],
  ["",                   false, false, "stringa vuota scartata"],
  ["UNKNOWN_TYPE",       true,  false, "tipo sconosciuto scartato anche con approximate"],
  // Default param: allowApproximate omesso = false
  ["ROOFTOP",            undefined, true,  "default false: ROOFTOP OK"],
  ["GEOMETRIC_CENTER",   undefined, false, "default false: GEOMETRIC_CENTER scartato"],
];

let pass = 0, fail = 0;
for (const [loc, flag, expected, desc] of cases) {
  const got = isAcceptableLocationType(loc, flag);
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${desc} → ${got}${ok ? "" : `  (expected ${expected})`}`);
  ok ? pass++ : fail++;
}
console.log(`\nTotale: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
