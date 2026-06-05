// tests/orderStateMachine.test.js
// ===============================================================
// ORDER-STATE-MACHINE-01 — test della PROPOSTA di hardening (audit 2026-06-05).
// Verifica src/utils/orderStateMachine.js (helper PURO, non ancora cablato).
// Documenta anche il gap reale: oggi cambiaStato accetta stati inventati.
// Eseguire: node tests/orderStateMachine.test.js
// ===============================================================
"use strict";

const {
  isKnownState,
  isTerminalState,
  validateTransition,
  isValidTransition,
} = require("../src/utils/orderStateMachine");

let passed = 0, failed = 0;
const section = (s) => console.log(`\n── ${s} ──`);
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const ok = (from, to) => assert(`${from ?? "∅"} → ${to} consentita`, isValidTransition(from, to));
const no = (from, to, reason) => {
  const v = validateTransition(from, to);
  assert(`${from ?? "∅"} → ${to} RIFIUTATA (${reason})`, v.ok === false && v.reason === reason,
    `ok=${v.ok} reason=${v.reason}`);
};

// ── stati noti / terminali ───────────────────────────────────────────────────
section("stati noti e terminali");
assert("EN_COCINA noto", isKnownState("EN_COCINA"));
assert("COMPLETADO noto (ES)", isKnownState("COMPLETADO"));
assert("COMPLETATO noto (IT)", isKnownState("COMPLETATO"));
assert("stringa inventata NON nota", !isKnownState("EN_COCINA cambiaStato"));
assert("COMPLETADO terminale", isTerminalState("COMPLETADO"));
assert("CANCELADO terminale", isTerminalState("CANCELADO"));
assert("RETIRADO NON terminale duro (può chiudere a COMPLETADO)", !isTerminalState("RETIRADO"));
assert("EN_COCINA non terminale", !isTerminalState("EN_COCINA"));

// ── creazione: from null → qualsiasi stato noto ──────────────────────────────
section("creazione (from vuoto)");
ok(null, "POR_CONFIRMAR");
ok(null, "NUEVO");
ok("", "EN_COCINA");

// ── flusso felice ────────────────────────────────────────────────────────────
section("flusso felice");
ok("POR_CONFIRMAR", "EN_COCINA");
ok("NUEVO", "EN_COCINA");
ok("EN_COCINA", "LISTO");
ok("LISTO", "EN_ENTREGA");      // domicilio
ok("LISTO", "RETIRADO");        // ritiro al banco
ok("EN_ENTREGA", "RETIRADO");
ok("RETIRADO", "COMPLETADO");
ok("RETIRADO", "COMPLETATO");

// ── idempotenza e cancellazione ──────────────────────────────────────────────
section("no-op e cancellazione");
assert("no-op EN_COCINA→EN_COCINA reason=noop", validateTransition("EN_COCINA", "EN_COCINA").reason === "noop");
ok("EN_COCINA", "EN_COCINA");
ok("POR_CONFIRMAR", "CANCELADO");
ok("EN_COCINA", "CANCELADO");
ok("LISTO", "CANCELADO");
ok("EN_ENTREGA", "CANCELADO");

// ── undo operativo 49B: LISTO → EN_COCINA consentito ─────────────────────────
section("undo operativo (49B)");
assert("LISTO→EN_COCINA reason=legal", validateTransition("LISTO", "EN_COCINA").reason === "legal");
ok("LISTO", "EN_COCINA");                        // click LISTO accidentale → rimetti in cucina
no("EN_ENTREGA", "LISTO", "illegal_transition"); // l'undo NON si estende oltre LISTO
no("EN_ENTREGA", "EN_COCINA", "illegal_transition");

// ── RIFIUTI (il cuore dell'hardening) ────────────────────────────────────────
section("transizioni rifiutate");
no("EN_COCINA", "EN_COCINA cambiaStato", "unknown_target_state");   // ← bug reale di oggi
no("LISTO", "PIZZA_VOLANTE", "unknown_target_state");
no("RETIRADO", "EN_COCINA", "illegal_transition");                // consegnato → indietro: vietato
no("COMPLETADO", "LISTO", "from_terminal_state");                  // resurrezione ordine chiuso
no("CANCELADO", "EN_COCINA", "from_terminal_state");
no("POR_CONFIRMAR", "RETIRADO", "illegal_transition");             // salto illegale
no("NUEVO", "LISTO", "illegal_transition");
no("EN_COCINA", "EN_ENTREGA", "illegal_transition");               // salta LISTO

// ── il gap di oggi sarebbe stato intercettato ────────────────────────────────
section("regressione gap 2026-06-05");
{
  // In task 47 cambiaStato accettò "EN_COCINA cambiaStato" e una catena di stati
  // malformati. L'helper li avrebbe rifiutati tutti.
  const malformati = ["EN_COCINA cambiaStato", "LISTO cambiaStato", "RETIRADO marcar"];
  const tuttiRifiutati = malformati.every(s => !isValidTransition("POR_CONFIRMAR", s));
  assert("tutti gli stati malformati di oggi sarebbero stati rifiutati", tuttiRifiutati);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
