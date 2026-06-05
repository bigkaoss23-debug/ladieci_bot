// Test stand-alone per isDireccionConcretaParaDelivery (WA-ADDRESS-GUARD-01).
// Eseguire: node src/utils/addressGuard.test.js
const { isDireccionConcretaParaDelivery } = require("./addressGuard");

const passCases = [
  "Antonio Machado 69",
  "Avenida Antonio Machado 110",
  "Calle Cuba 1",
  "Avenida Playa Serena 12",       // contiene "playa" ma è una via reale
  "Calle Mayor 12",                 // fuori zona ma indirizzo concreto
  "C/ Lursena 5",
  "Av. España 250",
  "Paseo Marítimo 3",
  "Urbanización Las Marinas, 4",
];

const failCases = [
  "cerca del puerto",
  "hotel cerca de la playa",
  "cerca de la playa",
  "por el centro",
  "Roquetas de Mar",
  "Aguadulce",
  "al lado del puerto",
  "donde siempre",
  "mi casa",
  "hotel",
  "",
  null,
  undefined,
  "cerca del Mercadona",
  "un hotel en la playa",
  "junto al puerto",
  "enfrente del centro",
  "por la zona",
];

let pass = 0, fail = 0;

console.log("── PASS cases (devono restituire ok=true) ──");
for (const d of passCases) {
  const r = isDireccionConcretaParaDelivery(d);
  const ok = r.ok === true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(d)} → ${JSON.stringify(r)}`);
  ok ? pass++ : fail++;
}

console.log("\n── FAIL cases (devono restituire ok=false) ──");
for (const d of failCases) {
  const r = isDireccionConcretaParaDelivery(d);
  const ok = r.ok === false;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(d)} → ${JSON.stringify(r)}`);
  ok ? pass++ : fail++;
}

console.log(`\nTOTAL  pass=${pass}  fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
