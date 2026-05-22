// Test stand-alone per stripHouseNumber (DELIVERY-ETA-02).
// Eseguire: node src/utils/stripHouseNumber.test.js
const { stripHouseNumber } = require("./geoResolver");

const cases = [
  ["Calle Lursena, 12",            "Calle Lursena"],
  ["Calle Lursena 12",             "Calle Lursena"],
  ["C/ Lursena 12",                "C/ Lursena"],
  ["Calle Lursena 12B",            "Calle Lursena"],
  ["Avenida Reino de España, 250", "Avenida Reino de España"],
  ["Av. España, 250-A",            "Av. España"],
  ["Calle 14 de Abril 5",          "Calle 14 de Abril"],
  ["Calle 14 de Abril, 5",         "Calle 14 de Abril"],
  ["Calle Lursena",                "Calle Lursena"],          // no-op
  ["Paseo Marítimo",               "Paseo Marítimo"],          // no-op
  ["",                             ""],
  [null,                            null],
  [undefined,                       undefined],
  [42,                              42],                       // non-string passthrough
  ["Calle  Cuba   ,  5  ",         "Calle  Cuba"],            // multi-space ok
  ["C/ X 3º",                      "C/ X"],                    // suffisso º
];

let pass = 0, fail = 0;
for (const [input, expected] of cases) {
  const got = stripHouseNumber(input);
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(input)} → ${JSON.stringify(got)}${ok ? "" : `  (expected ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}
console.log(`\nTotale: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
