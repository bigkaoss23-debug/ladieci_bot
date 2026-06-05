// tests/moneyMath.test.js
// ===============================================================
// MONEY-MATH-COVERAGE-01 — copertura mancante (audit 2026-06-05).
// Funzioni pure di src/utils/helpers.js: calcolaTotale, deliveryFeeFor,
// calcolaTotaleOrdine, aplicarDescuento. Nessun DB/rete.
// Eseguire: node tests/moneyMath.test.js
// ===============================================================
"use strict";

const {
  calcolaTotale,
  deliveryFeeFor,
  calcolaTotaleOrdine,
  aplicarDescuento,
} = require("../src/utils/helpers");
const { COSTO_CONSEGNA } = require("../src/config");

let passed = 0;
let failed = 0;
const section = (s) => console.log(`\n── ${s} ──`);
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
// Uguaglianza "a centesimi": evita falsi negativi da floating point.
const cents = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const eqMoney = (name, got, exp) => assert(`${name} (=${exp})`, cents(got, exp), `got ${got}`);
const eqDesc = (name, got, expTot, expImp) =>
  assert(`${name} → totale ${expTot} / importe ${expImp}`,
    cents(got.totale, expTot) && cents(got.importe, expImp),
    `got totale ${got.totale} / importe ${got.importe}`);

// ── calcolaTotale: somma p*q, arrotondata a 2 decimali ───────────────────────
section("calcolaTotale");
eqMoney("lista vuota", calcolaTotale([]), 0);
eqMoney("singolo 8x1", calcolaTotale([{ n: "M", p: 8, q: 1 }]), 8);
eqMoney("singolo 8x2", calcolaTotale([{ n: "M", p: 8, q: 2 }]), 16);
eqMoney("somma 8 + 5.5x2", calcolaTotale([{ p: 8, q: 1 }, { p: 5.5, q: 2 }]), 19);
eqMoney("arrotonda 3.33x3", calcolaTotale([{ p: 3.33, q: 3 }]), 9.99);
eqMoney("q mancante → default 1", calcolaTotale([{ p: 8 }]), 8);
eqMoney("p mancante → 0", calcolaTotale([{ q: 3 }]), 0);
eqMoney("prezzi/quantità stringa", calcolaTotale([{ p: "8.50", q: "2" }]), 17);
eqMoney("float pulito 0.1x3", calcolaTotale([{ p: 0.1, q: 3 }]), 0.3);

// ── deliveryFeeFor: SOLO da tipo_consegna ────────────────────────────────────
section("deliveryFeeFor");
eqMoney("DOMICILIO → COSTO_CONSEGNA", deliveryFeeFor("DOMICILIO"), COSTO_CONSEGNA);
eqMoney("RITIRO → 0", deliveryFeeFor("RITIRO"), 0);
eqMoney("undefined → 0", deliveryFeeFor(undefined), 0);
eqMoney("tipo sconosciuto → 0", deliveryFeeFor("OTHER"), 0);

// ── calcolaTotaleOrdine: items + delivery_fee ────────────────────────────────
section("calcolaTotaleOrdine");
eqMoney("RITIRO = solo items", calcolaTotaleOrdine([{ p: 8, q: 1 }], "RITIRO"), 8);
eqMoney("DOMICILIO = items + delivery", calcolaTotaleOrdine([{ p: 8, q: 1 }], "DOMICILIO"), 8 + COSTO_CONSEGNA);
eqMoney("vuoto DOMICILIO = solo delivery", calcolaTotaleOrdine([], "DOMICILIO"), COSTO_CONSEGNA);
eqMoney("default tipo = RITIRO", calcolaTotaleOrdine([{ p: 12.5, q: 2 }]), 25);

// ── aplicarDescuento — EURO (€ fisso) ────────────────────────────────────────
section("aplicarDescuento — EURO");
eqDesc("5€ su 20", aplicarDescuento(20, "EURO", 5), 15, 5);
eqDesc("0.5€ su 10.5", aplicarDescuento(10.5, "EURO", 0.5), 10, 0.5);
eqDesc("sconto = totale → 0", aplicarDescuento(20, "EURO", 20), 0, 20);
eqDesc("sconto > totale → CLAMP a 0 (mai negativo)", aplicarDescuento(20, "EURO", 25), 0, 20);

// ── aplicarDescuento — PERCENT (%) ───────────────────────────────────────────
section("aplicarDescuento — PERCENT");
eqDesc("10% su 20", aplicarDescuento(20, "PERCENT", 10), 18, 2);
eqDesc("33% su 10 (arrotonda)", aplicarDescuento(10, "PERCENT", 33), 6.70, 3.30);
eqDesc("15% su 9.99 (round half-up cent)", aplicarDescuento(9.99, "PERCENT", 15), 8.49, 1.50);
eqDesc("100% → totale 0", aplicarDescuento(20, "PERCENT", 100), 0, 20);
eqDesc("150% → CLAMP a 0 (mai negativo)", aplicarDescuento(20, "PERCENT", 150), 0, 20);

// ── aplicarDescuento — guardie / edge ────────────────────────────────────────
section("aplicarDescuento — guardie");
eqDesc("tipo null → nessuno sconto", aplicarDescuento(20, null, 5), 20, 0);
eqDesc("valor 0 → nessuno sconto", aplicarDescuento(20, "EURO", 0), 20, 0);
eqDesc("valor negativo → nessuno sconto", aplicarDescuento(20, "EURO", -5), 20, 0);
eqDesc("base 0 → nessuno sconto", aplicarDescuento(0, "EURO", 5), 0, 0);
eqDesc("tipo sconosciuto → no-op sicuro", aplicarDescuento(20, "FOO", 5), 20, 0);
{
  const r = aplicarDescuento(20, "PERCENT", 50);
  assert("importe + totale == base (invariante somma)", cents(r.importe + r.totale, 20),
    `importe ${r.importe} + totale ${r.totale}`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
