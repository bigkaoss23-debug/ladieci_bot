// Test mirato BUG-FORNO-OUT-WRAP-00-01.
// Eseguire: node tests/fornoOutWrap.test.js
//
// Verifica la matematica centrale: forno_out = hora - durata deve wrappare
// modulo 24, non clampare a 00:00.

const { calcolaFornoOut, diffServiceDayMinutes, toServiceDayMin } = require("../src/utils/zones");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);

const forno = (hora, durata) =>
  calcolaFornoOut({ tipoConsegna: "DOMICILIO", hora, durataAndataMin: durata, driverLiberoMin: 0 }).forno_out;

section("Wrap modulo 24 per hora - durata");
[
  ["00:05", 13, "23:52"],
  ["00:10", 12, "23:58"],
  ["00:11", 12, "23:59"],
  ["00:22", 13, "00:09"],
  ["00:25", 12, "00:13"],
  ["22:00", 13, "21:47"],
].forEach(([hora, durata, expected]) => {
  const got = forno(hora, durata);
  assert(`${hora} - ${durata} -> ${expected}`, got === expected, `got=${got}`);
});

section("Ritiro e formato");
{
  const r = calcolaFornoOut({ tipoConsegna: "RITIRO", hora: "00:10", durataAndataMin: 12 });
  assert("RITIRO: forno_out = hora", r.forno_out === "00:10", `forno=${r.forno_out}`);
  assert("nessun valore 24/25", !/\b2[4-9]:\d\d/.test(JSON.stringify(r)), JSON.stringify(r));
}

section("Controllo service-day-aware, non confronto stringhe");
{
  const diff = diffServiceDayMinutes(toServiceDayMin("23:58"), toServiceDayMin("00:10"));
  assert("23:58 -> 00:10 = +12 min service-day", diff === 12, `diff=${diff}`);
  assert("forno_out 23:58 non è anomalo per hora 00:10", diff >= 0, `diff=${diff}`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
