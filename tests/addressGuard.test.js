// tests/addressGuard.test.js
// ===============================================================
// WA-ADDRESS-GUARD-HARDENING-51 (2026-06-05).
// Verifica isDireccionConcretaParaDelivery (src/utils/addressGuard.js): la
// guardia che decide se una direccion libera da WhatsApp è abbastanza concreta
// per geocodare e consegnare in AUTOMATICO. Affronta il rischio "indirizzo
// sbagliato / pin sbagliato". Funzione PURA, nessun DB/rete, solo fixture fake.
//
// Hardening: il vecchio limite documentato in OFFLINE-SAFETY-GAPS-TESTS-48
// ("hotel sol y playa 5" passava per via dei >3 token) è ora CHIUSO: senza un
// ancoraggio via esplicito + numero, le frasi con POI vanno a operatore.
// Eseguire: node tests/addressGuard.test.js
// ===============================================================
"use strict";

const { isDireccionConcretaParaDelivery } = require("../src/utils/addressGuard");

let passed = 0, failed = 0;
const section = (s) => console.log(`\n── ${s} ──`);
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
// Concreta (ok=true) — motivo irrilevante.
const okAddr = (dir) => {
  const r = isDireccionConcretaParaDelivery(dir);
  assert(`"${dir}" → CONCRETA (ok)`, r.ok === true, `motivo=${r.motivo}`);
};
// Bloccata (ok=false) con motivo atteso.
const noAddr = (dir, motivo) => {
  const r = isDireccionConcretaParaDelivery(dir);
  assert(`"${dir}" → BLOCCATA (${motivo})`, r.ok === false && r.motivo === motivo, `ok=${r.ok} motivo=${r.motivo}`);
};

// ── vuoto / nullo ────────────────────────────────────────────────────────────
section("vuoto / nullo");
noAddr(null, "vacia");
noAddr(undefined, "vacia");
noAddr("", "vacia");
noAddr("   ", "vacia");

// ── frasi qualitative → bloccano SEMPRE (anche con nome via / con cifra) ──────
section("frasi vaghe");
noAddr("cerca del puerto", "frase_vaga");
noAddr("cerca del puerto 7", "frase_vaga");            // cifra non salva la frase vaga
noAddr("al lado de la farmacia", "frase_vaga");
noAddr("al lado del mercadona 3", "frase_vaga");
noAddr("junto al mercadona", "frase_vaga");
noAddr("enfrente de la playa", "frase_vaga");
noAddr("detras de la iglesia", "frase_vaga");
noAddr("donde siempre", "frase_vaga");
noAddr("por aqui", "frase_vaga");
noAddr("por la zona", "frase_vaga");
noAddr("Calle Mayor cerca del puerto", "frase_vaga");  // via + frase vaga → vince la frase

// ── riferimenti personali ────────────────────────────────────────────────────
section("riferimenti personali");
noAddr("mi casa", "referencia_personal");
noAddr("mi piso", "referencia_personal");
noAddr("mi domicilio de siempre", "referencia_personal");

// ── POSITIVI: prefisso via + numero civico chiaro ────────────────────────────
section("indirizzi concreti (via + numero)");
okAddr("Avenida Carlos III 50");
okAddr("Calle Anade 35");
okAddr("Av. Sabinar 12");
okAddr("Plaza Mayor 4");
okAddr("Calle Real 8, portal 2");        // "portal" tollerato: c'è il prefisso via
okAddr("Paseo del Mar 15");
okAddr("Calle X 10 piso 2");             // "piso" tollerato: c'è il prefisso via
// regressione: positivi storici sicuri restano true
okAddr("Calle Cuba 5");
okAddr("C/ Cuba 5, 3A");
okAddr("Avenida Playa Serena 12");       // "playa" tollerato: prefisso via vince
okAddr("Avenida Antonio Machado 110");
okAddr("Av. España 250");
okAddr("Paseo Maritimo 100");
okAddr("Urbanización Las Marinas, 4");

// ── POSITIVO speciale ES: "Nombre Apellido <numero>" corto, senza POI ────────
section("nombre apellido + numero (senza prefisso, corto)");
okAddr("Antonio Machado 69");

// ── NEGATIVI: prefisso via SENZA numero → operatore ──────────────────────────
section("via senza numero");
noAddr("calle", "sin_numero");
noAddr("avenida sin numero", "sin_numero");
noAddr("Calle Cuba", "sin_numero");      // hardening: prima passava, ora no
noAddr("Calle Mayor", "sin_numero");

// ── NEGATIVI: POI / località senza prefisso via (con o senza numero) ─────────
section("POI / località senza via");
noAddr("hotel sol y playa 5", "poi_sin_via");   // ← limite noto 48, ora CHIUSO
noAddr("hotel sol y playa", "poi_sin_via");
noAddr("en el hotel", "poi_sin_via");
noAddr("playa serena", "poi_sin_via");
noAddr("playa serena 5", "poi_sin_via");
noAddr("bloque 5", "poi_sin_via");
noAddr("portal 3", "poi_sin_via");
noAddr("piso 2", "poi_sin_via");
noAddr("roquetas", "poi_sin_via");
noAddr("roquetas 12", "poi_sin_via");
noAddr("la marina", "poi_sin_via");
noAddr("marina 4", "poi_sin_via");
noAddr("evershine", "poi_sin_via");
noAddr("evershine 7", "poi_sin_via");
noAddr("puerto 10", "poi_sin_via");
noAddr("hotel 3", "poi_sin_via");
noAddr("puerto", "poi_sin_via");
noAddr("centro", "poi_sin_via");
noAddr("playa", "poi_sin_via");
noAddr("Roquetas de Mar", "poi_sin_via");
noAddr("Aguadulce", "poi_sin_via");
noAddr("un hotel en la playa", "poi_sin_via");

// ── NEGATIVI: numero senza via chiara / solo numero / codice zona ────────────
section("numero senza via chiara");
noAddr("5", "numero_sin_via_clara");
noAddr("Q5", "numero_sin_via_clara");
noAddr("entrega rapida en la esquina del fondo 5", "numero_sin_via_clara"); // frase lunga + cifra

// ── NEGATIVI: né via né numero, non POI ──────────────────────────────────────
section("nessuna via né numero");
noAddr("algo raro aqui", "sin_via_y_numero");

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
