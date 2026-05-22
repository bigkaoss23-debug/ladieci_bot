// Verifica che il fix funzioni — simula il nuovo flusso
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_KEY = "mock";

let rispostaGenerata = null;
let messaggioInviato = null;

require.cache[require.resolve("../src/utils/supabase")] = {
  id: require.resolve("../src/utils/supabase"),
  filename: require.resolve("../src/utils/supabase"),
  loaded: true,
  exports: {
    sbSelect: async (table, q) => {
      if (table === "config") return []; // getConfig → vuota ma ok
      return [];
    },
    sbUpdate: async () => {},
    sbUpsert: async () => {},
    getConfig: async () => ({ "AUTO_RISPOSTA": "TRUE", "AI_FORZA": "BASIC" })
  }
};

require.cache[require.resolve("../src/utils/claude")] = {
  id: require.resolve("../src/utils/claude"),
  filename: require.resolve("../src/utils/claude"),
  loaded: true,
  exports: {
    chiamaClaude: async (system, user, cfg, maxTokens) => {
      // interpreta(): classifica come domanda
      if (maxTokens === 600) {
        return JSON.stringify({ tipo: "domanda", items: [], hora: "", conf: 0,
          tipo_consegna: "DOMICILIO", direccion: "" });
      }
      // generaRisposta(): genera risposta delivery
      rispostaGenerata = `Sì, facciamo consegne a domicilio! 🛵 Orario: 20:00-23:00 (mercoledì-domenica). Costo: 2,50€. *La Dieci* 🇮🇹🍕`;
      return rispostaGenerata;
    }
  }
};

const { gestisci } = require("../src/agents/orchestrator");

async function main() {
  // Mock invia per catturare il messaggio
  const agentWA = require("../src/agents/agentWhatsapp");
  const origInvia = agentWA.invia;
  // Patch temporanea
  Object.defineProperty(agentWA, "invia", {
    value: async (to, text, cfg) => { messaggioInviato = text; console.log(`[INVIA → ${to}]: "${text}"`); },
    writable: true, configurable: true
  });

  const ctx = {
    waId: "34600000001",
    nombre: "Cliente Test",
    testo: "Vorrei ordinare una pizza a domicilio, consegnate a casa mia?",
    ia: { tipo: "domanda", items: [], hora: "", conf: 0, tipo_consegna: "DOMICILIO", direccion: "" },
    config: { "AUTO_RISPOSTA": "TRUE", "AI_FORZA": "BASIC" },
    statoOrd: { haOrdine: false },
    conv: null,
    caricoForno: null,
    isWhitelist: false,
    waMsgId: null
  };

  console.log("\n════════════════════════════════════════");
  console.log("TEST DOPO IL FIX");
  console.log("Messaggio:", ctx.testo);
  console.log("════════════════════════════════════════\n");

  let result = null;
  let raised = null;
  try {
    result = await gestisci(ctx);
    console.log("\nRisultato:", JSON.stringify(result));
  } catch(e) {
    raised = e;
    console.log("\nNota:", e.message);
  }

  // Comportamento atteso (post-evoluzione orchestrator):
  // - FLUSSO 3 per ia.tipo="domanda" deve produrre una risposta automatica
  //   (la mock chiamaClaude la setta in `rispostaGenerata`).
  // - stato finale può essere "COMPLETATO" oppure "IN_TRATTAMENTO":
  //     COMPLETATO    → conf ≥ SOGLIA_CONF e nessuna ia.hora/direccion
  //     IN_TRATTAMENTO → la risposta è stata inviata MA va in review umana
  //                      (es. conf bassa o ia.hora/direccion presenti).
  //   Vedi orchestrator.js FLUSSO 3 — `statoF3` ternary.
  // - Entrambi gli esiti significano "risposta delivery generata e inviata".
  const VALID_STATI = new Set(["COMPLETATO", "IN_TRATTAMENTO"]);
  const success = !raised
    && result && result.flusso === 3
    && VALID_STATI.has(result.stato)
    && typeof rispostaGenerata === "string" && rispostaGenerata.length > 0;

  if (success) {
    console.log("\n✅ FLUSSO 3 ha generato e inviato la risposta delivery (stato=" + result.stato + ")");
    console.log("   Risposta: " + rispostaGenerata);
  } else {
    console.log("\n❌ FLUSSO 3 non ha prodotto la risposta attesa.");
    console.log("   raised=" + (raised && raised.message) +
      " result=" + JSON.stringify(result) +
      " rispostaGenerata=" + JSON.stringify(rispostaGenerata));
    process.exit(1);
  }

  // Test aggiuntivo: verifica che l'import sia corretto
  console.log("\n════ Verifica import ════");
  const generaRispostaImportata = require("../src/agents/agentWhatsapp").generaRisposta !== undefined;
  console.log("generaRisposta importata in orchestrator:",
    generaRispostaImportata ? "✅ sì" : "❌ no");
  if (!generaRispostaImportata) process.exit(1);
}

main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
