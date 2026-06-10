// tests/getCaricoDeliveryRiderFloor.test.js
// ===============================================================
// C2.1 — agentCucina.getCaricoDelivery deve derivare il "rider busy"
// dalla STESSA fonte autoritativa di previewOrderTiming:
// resolveRiderAvailability(ordenes EN_ENTREGA + hora_salida),
// NON da config.DRIVER_STATO.
//
// Run: node tests/getCaricoDeliveryRiderFloor.test.js
//
// Stub DB: sovrascriviamo sbSelect nella cache del modulo supabase PRIMA di
// require-are agentCucina (che destruttura sbSelect a import-time).
//   • Lo stub THROW se qualcuno interroga config.DRIVER_STATO → prova che la
//     funzione non legge più quella chiave.
//   • Per la query ordenes ritorna gli ordini di test.
// Nessuna rete, nessuna scrittura.
// ===============================================================
"use strict";

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}  ${extra}`); }
}

// ── Stub supabase.sbSelect PRIMA di caricare agentCucina ──
const supaPath = require.resolve("../src/utils/supabase");
require(supaPath); // forza il caricamento in cache

let ORDENES_ROWS = [];
require.cache[supaPath].exports.sbSelect = async (table, query) => {
  const q = String(query || "");
  if (q.includes("DRIVER_STATO") || table === "config") {
    throw new Error("REGRESSION: getCaricoDelivery non deve più leggere config.DRIVER_STATO");
  }
  if (table === "ordenes") return ORDENES_ROWS;
  return [];
};

const { getCaricoDelivery } = require("../src/agents/agentCucina");

// Madrid clock minutes "adesso" — coerente con toMadridMinutes(Date.now()) usato dentro.
const nowParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false,
}).formatToParts(new Date());
const nowH = Number(nowParts.find(p => p.type === "hour").value);
const nowM = Number(nowParts.find(p => p.type === "minute").value);
const nowHHMM = `${String(nowH).padStart(2,"0")}:${String(nowM).padStart(2,"0")}`;
const nowMin = nowH * 60 + nowM;

(async () => {
  // ── Caso 1: un ordine EN_ENTREGA con hora_salida reale (= adesso) e durata 15.
  // DRIVER_STATO NON viene neppure interrogato (lo stub esploderebbe). Il rider
  // risulta occupato dalla sola evidenza in `ordenes`.
  ORDENES_ROWS = [{
    id: "TEST_ENTREGA_1",
    tipo_consegna: "DOMICILIO",
    estado: "EN_ENTREGA",
    zona: "Q2",
    hora: nowHHMM,
    hora_salida: Date.now(),       // salida reale ms → ~ adesso (Madrid)
    durata_andata_min: 15,         // return = salida + 2*15 + 3 = +33 min → nel futuro
  }];
  const r1 = await getCaricoDelivery("Q2", nowHHMM, 10);
  check("rider EN_ENTREGA ⇒ driverInGiro=true (fonte ordenes, non DRIVER_STATO)",
    r1.driverInGiro === true, JSON.stringify(r1));
  // Se cade dentro la finestra di servizio (slot non null), lo slot non può essere
  // anteriore ad adesso: il floor reale del rider ha spinto minMin in avanti.
  if (r1.slotAssegnato != null) {
    const [sh, sm] = String(r1.slotAssegnato).split(":").map(Number);
    check("floor applicato: slotAssegnato >= adesso",
      (sh * 60 + sm) >= nowMin, `slot=${r1.slotAssegnato} now=${nowHHMM}`);
  } else {
    console.log("  · slotAssegnato null (fuori finestra servizio a quest'ora) — floor non verificabile ora, ok");
  }

  // ── Caso 2: nessun ordine EN_ENTREGA (tutti LISTO, nessuna salida reale) ⇒
  // nessun floor rider ⇒ driverInGiro=false.
  ORDENES_ROWS = [{
    id: "TEST_LISTO_1",
    tipo_consegna: "DOMICILIO",
    estado: "LISTO",
    zona: "Q2",
    hora: nowHHMM,
    durata_andata_min: 15,
  }];
  const r2 = await getCaricoDelivery("Q2", nowHHMM, 10);
  check("nessun EN_ENTREGA ⇒ driverInGiro=false",
    r2.driverInGiro === false, JSON.stringify(r2));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
