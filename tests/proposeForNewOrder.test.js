// Test sintetici per proposeForNewOrder (slot-search algorithm)
// Eseguire: node tests/proposeForNewOrder.test.js
//
// Verifica le regole prodotto post-incidente 28/05/2026:
//   - ordini futuri = intervalli occupati LOCALI, non barriere globali
//   - cliente "¿cuándo podéis?" → primo buco da now in avanti
//   - hora esplicita libera → ok=true, hora preservata
//   - aggregazione same-zone-slot10 invariata

const { proposeForNewOrder, simulateDriverSchedule, ZONE_DELIVERY } = require("../src/utils/zones");

let passed = 0, failed = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
};
const section = (s) => console.log(`\n── ${s} ──`);

// Helper: ordine fake con coords del centro zona (Plaza Itálica) — calcolaTempoGiro
// userà il fallback zona.tempoGiro se le coords cadono fuori dal poligono diretto.
const ord = (id, zona, hora, opts = {}) => ({
  id, zona, hora,
  tipo_consegna: "DOMICILIO",
  estado: opts.estado || "EN_COCINA",
  zona_lat: opts.lat ?? null,
  zona_lon: opts.lon ?? null,
  durata_andata_min: opts.tg ?? null,
  items: opts.items || [{ q: 1, cat: "Pizzas", n: "Margherita" }],
});

// ═══════════════════════════════════════════════════════════════════════════
section("T1 — ordine futuro 23:00 NON blocca walk-in 'quando potete?' alle 21:00");
// Setup: now=21:00, esiste Q5 hora 23:00 (parte ~22:30, rientra ~23:31)
// Nuovo Q1 senza hora → deve proporre slot vicino a 21:00, NON dopo le 23:31
{
  const orders = [ord("#X", "Q5", "23:00", { tg: 30 })];
  const newOrd = { zona: "Q1", durata_andata_min: 15 }; // hora assente
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 21*60 });
  assert("ok = true (slot libero trovato)", r.ok === true);
  assert(`consegnaPropostaH ben prima delle 22:30 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaMin < 22*60 + 30,
         `aspettato < 22:30, ricevuto ${r.consegnaPropostaH}`);
  assert("aggregato = false", r.aggregato === false);
}

// ═══════════════════════════════════════════════════════════════════════════
section("T2 — cliente WA chiede esplicitamente 23:00, slot libero");
{
  const orders = []; // timeline vuota
  const newOrd = { zona: "Q5", hora: "23:00", durata_andata_min: 30 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 21*60 });
  assert("ok = true (slot libero)", r.ok === true);
  assert(`hora richiesta preservata 23:00 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaH === "23:00");
}

// ═══════════════════════════════════════════════════════════════════════════
section("T3 — cliente chiede 21:30 con ordine futuro Q5 23:00");
// partTeorica Q1 = 21:30 - 15 = 21:15, roundtrip = 15+3+15 = 33 → rientro 21:48
// Q5 occupato [22:30, 23:31]. [21:15, 21:48] vs [22:30, 23:31] → no collisione.
{
  const orders = [ord("#X", "Q5", "23:00", { tg: 30 })];
  const newOrd = { zona: "Q1", hora: "21:30", durata_andata_min: 15 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 21*60 });
  assert("ok = true (slot 21:30 libero)", r.ok === true);
  assert(`hora preservata 21:30 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaH === "21:30");
}

// ═══════════════════════════════════════════════════════════════════════════
section("T4 — timeline davvero piena, propone primo buco reale");
// Costruisco 3 giri Q1 back-to-back: 20:00 (rientro ~20:33), 20:40 (rientro ~21:13),
// 21:20 (rientro ~21:53). Nuovo Q1 "quando potete?" alle 20:05 → primo buco DOPO 21:53.
{
  const orders = [
    ord("#A", "Q1", "20:00", { tg: 15 }),
    ord("#B", "Q1", "20:40", { tg: 15 }),
    ord("#C", "Q1", "21:20", { tg: 15 }),
  ];
  const newOrd = { zona: "Q1", durata_andata_min: 15 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 20*60 + 5 });
  assert("ok = true", r.ok === true);
  // Aggregation può scattare: same-zone Q1 slot10 — il backend usa SLOT esatto,
  // se nessuno coincide aggrega solo se c'è un giro stesso slot. Qui new non
  // ha hora → aggregation skip (richiede slot10(horaNew) match), va in slot-search.
  // Atteso: consegnaProposta dopo 21:53 (= dopo rientro del giro più tardi).
  assert(`consegnaProposta dopo saturazione (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaMin >= 21*60 + 53,
         `aspettato >= 21:53, ricevuto ${r.consegnaPropostaH}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("T5 — aggregazione same-zone same-slot10 invariata");
{
  const orders = [ord("#X", "Q5", "21:00", { tg: 30 })];
  const newOrd = { zona: "Q5", hora: "21:00", durata_andata_min: 30 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 20*60 });
  assert("aggregato = true", r.aggregato === true);
  assert("ok = true", r.ok === true);
  assert(`hora coincide con giro esistente 21:00 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaH === "21:00");
}

// ═══════════════════════════════════════════════════════════════════════════
section("T6 — hora pedida troppo presto (cottura non basta)");
// now=21:00, cliente chiede 21:05 per Q5 (tg=30). partTeorica = 21:05-30 = 20:35,
// minPart = 21:05. partTeorica (20:35) < minPart (21:05) → infeasible.
{
  const orders = [];
  const newOrd = { zona: "Q5", hora: "21:05", durata_andata_min: 30 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 21*60 });
  assert("ok = false (cottura insufficiente)", r.ok === false);
  assert("motivo cita cocina+andata", /muy pronta|cocina/i.test(r.motivo || ""));
  // Min realistico: minPart (21:05) + tg (30) = 21:35
  assert(`consegnaProposta >= 21:35 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaMin >= 21*60 + 35);
}

// ═══════════════════════════════════════════════════════════════════════════
section("T7 — collisione effettiva con giro esistente → propone DOPO il rientro");
// now=21:00, giro Q5 hora 21:00 (parte 20:30, rientra 21:33).
// Nuovo Q3 hora 21:30 (tg=25): partTeorica 21:05 (>= minPart 21:05 OK feasibility),
// rientroNew 21:05+53=21:58. [21:05, 21:58] vs [20:30, 21:33] → collide → cerca dopo.
{
  const orders = [ord("#X", "Q5", "21:00", { tg: 30 })];
  const newOrd = { zona: "Q3", hora: "21:30", durata_andata_min: 25 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 21*60 });
  assert("ok = false (collide con Q5 in giro)", r.ok === false);
  assert("motivo cita Q5", /Q5/.test(r.motivo || ""), r.motivo);
  // Driver rientra 21:33, nuovo Q3 può partire a 21:33 + tg25 = consegna 21:58 → ceil5 = 22:00
  assert(`consegnaProposta >= 22:00 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaMin >= 22*60,
         `motivo=${r.motivo}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("T8 — ordine futuro Q5 23:00, nuovo Q3 'quando potete?' → propone slot vicino al now");
// Replica T1 ma con hora-richiesta assente e zona diversa. Verifica che la
// strategia copra anche zone diverse (no aggregation possibile).
{
  const orders = [ord("#X", "Q5", "23:00", { tg: 30 })];
  const newOrd = { zona: "Q3", durata_andata_min: 25 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 21*60 });
  assert("ok = true", r.ok === true);
  assert(`consegnaProposta ben prima delle 22:30 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaMin < 22*60 + 30,
         `prima del partTeorica del Q5 = 22:30`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("T9 — regressione: scenario incidente live (#001 22:18 + #006 22:56 contaminanti)");
// Scenario originale del bug PRIMA della normalizzazione. Con il nuovo algoritmo,
// un walk-in alle 20:20 deve poter ricevere uno slot vicino, non spinto a 23:00+.
{
  const orders = [
    ord("#001", "Q1", "22:18", { tg: 8, estado: "LISTO" }),
    ord("#006", "Q3", "22:56", { tg: 8, estado: "LISTO" }),
  ];
  const newOrd = { zona: "Q2", durata_andata_min: 20 };
  const r = proposeForNewOrder(orders, newOrd, { nowMin: 20*60 + 20 });
  assert("ok = true", r.ok === true);
  // Buco prima di Q1 (parte 22:10) deve essere ampio: now+5=20:25, roundtrip Q2 = 43min
  // → finisce 21:08, ben prima delle 22:10. Slot OK.
  assert(`consegnaProposta < 22:00 (got ${r.consegnaPropostaH})`,
         r.consegnaPropostaMin < 22*60,
         `il vecchio bug suggeriva 23:00+`);
}

// ═══════════════════════════════════════════════════════════════════════════
section("T10 — return shape compatibile con callers esistenti");
{
  const orders = [];
  const r = proposeForNewOrder(orders, { zona: "Q1", hora: "20:30", durata_andata_min: 15 },
                                { nowMin: 20*60 });
  const keys = Object.keys(r).sort();
  const expected = ["aggregato","consegnaPropostaH","consegnaPropostaMin",
                    "driverLiberoMin","giroEsistente","motivo","ok","sim","tgNew"];
  assert("contiene tutte le chiavi attese",
         expected.every(k => keys.includes(k)),
         `keys=${keys.join(",")}`);
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
