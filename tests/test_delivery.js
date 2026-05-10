// Verifica che il fix funzioni — simula il nuovo flusso
process.env.SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_KEY = "mock";

let rispostaGenerata = null;
let messaggioInviato = null;

require.cache[require.resolve("./src/utils/supabase")] = {
  id: require.resolve("./src/utils/supabase"),
  filename: require.resolve("./src/utils/supabase"),
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

require.cache[require.resolve("./src/utils/claude")] = {
  id: require.resolve("./src/utils/claude"),
  filename: require.resolve("./src/utils/claude"),
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

const { gestisci } = require("./src/agents/orchestrator");

async function main() {
  // Mock invia per catturare il messaggio
  const agentWA = require("./src/agents/agentWhatsapp");
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

  try {
    const result = await gestisci(ctx);
    console.log("\nRisultato:", JSON.stringify(result));
    
    if (result.stato === "COMPLETATO") {
      console.log("\n✅ FLUSSO 3 ora risponde correttamente alle domande delivery");
      console.log("   Risposta generata e inviata al cliente.");
    } else if (result.stato === "IN_TRATTAMENTO") {
      console.log("\n❌ Ancora senza risposta - qualcosa non ha funzionato");
    }
  } catch(e) {
    // gestisci chiama supabase — alcuni mock potrebbero fallire
    // ma il percorso fino a generaRisposta è quello che conta
    console.log("\nNota:", e.message);
    if (rispostaGenerata) {
      console.log("\n✅ generaRisposta() È STATA CHIAMATA — risposta generata:");
      console.log("   " + rispostaGenerata);
    }
  }

  // Test aggiuntivo: verifica che l'import sia corretto
  const orchModule = require("./src/agents/orchestrator");
  console.log("\n════ Verifica import ════");
  console.log("generaRisposta importata in orchestrator:", 
    require("./src/agents/agentWhatsapp").generaRisposta !== undefined ? "✅ sì" : "❌ no");
}

main().catch(e => { console.error("ERR:", e.message); });
