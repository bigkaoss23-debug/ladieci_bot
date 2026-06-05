// tests/addressGuard.test.js
// ===============================================================
// WA-ADDRESS-GUARD-COVERAGE-01 — copertura mancante (audit 2026-06-05).
// Verifica isDireccionConcretaParaDelivery (src/utils/addressGuard.js): la
// guardia che decide se una direccion libera da WhatsApp è abbastanza concreta
// per geocodare e consegnare in automatico. Affronta il rischio "indirizzo
// sbagliato / pin sbagliato". Funzione PURA, nessun DB/rete.
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
const okAddr = (dir) => {
  const r = isDireccionConcretaParaDelivery(dir);
  assert(`"${dir}" → CONCRETA (ok)`, r.ok === true, `motivo=${r.motivo}`);
};
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

// ── frasi qualitative → bloccano SEMPRE (anche con nome via) ──────────────────
section("frasi vaghe");
noAddr("cerca del puerto", "frase_vaga");
noAddr("al lado de la farmacia", "frase_vaga");
noAddr("junto al mercadona", "frase_vaga");
noAddr("enfrente de la playa", "frase_vaga");
noAddr("detras de la iglesia", "frase_vaga");
noAddr("donde siempre", "frase_vaga");
noAddr("por aqui", "frase_vaga");
noAddr("Calle Mayor cerca del puerto", "frase_vaga");   // via + frase vaga → vince la frase

// ── riferimenti personali ────────────────────────────────────────────────────
section("riferimenti personali");
noAddr("mi casa", "referencia_personal");
noAddr("mi piso", "referencia_personal");
noAddr("mi domicilio de siempre", "referencia_personal");

// ── concreti: prefisso via (+/- numero) ──────────────────────────────────────
section("indirizzi concreti");
okAddr("Calle Cuba 5");
okAddr("C/ Cuba 5, 3A");
okAddr("Avenida Playa Serena 12");      // prefisso+numero vince anche con POI "playa"
okAddr("Calle Cuba");                    // prefisso senza numero: borderline accettato
okAddr("Antonio Machado 69");            // numero senza prefisso esplicito (comune ES)
okAddr("Paseo Maritimo 100");

// ── località/POI + numero, frase corta → bloccata ────────────────────────────
section("solo località/POI + numero");
noAddr("puerto 10", "solo_localidad_o_poi_con_numero");
noAddr("playa 5", "solo_localidad_o_poi_con_numero");
noAddr("hotel 3", "solo_localidad_o_poi_con_numero");

// ── località/POI senza numero → bloccata ─────────────────────────────────────
section("solo località/POI");
noAddr("puerto", "solo_localidad_o_poi");
noAddr("centro", "solo_localidad_o_poi");
noAddr("playa", "solo_localidad_o_poi");

// ── né via né numero, non POI → bloccata ─────────────────────────────────────
section("nessuna via né numero");
noAddr("algo raro aqui", "sin_via_y_numero");

// ── BORDERLINE noto: POI + numero ma >3 token → passa (documentato) ──────────
// Limite attuale del guard: una descrizione vaga con abbastanza parole + una
// cifra supera il check. Caratterizzato qui per renderlo VISIBILE; candidato a
// irrobustimento futuro (vedi report audit).
section("borderline noto (documentato, non un bug bloccante)");
{
  const r = isDireccionConcretaParaDelivery("hotel sol y playa 5");
  assert('"hotel sol y playa 5" → passa per via dei >3 token (limite noto)', r.ok === true, `ok=${r.ok} motivo=${r.motivo}`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
