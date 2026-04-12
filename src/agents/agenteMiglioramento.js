// ===============================================================
// agenteMiglioramento.js — suggerimenti settimanali
// ===============================================================

const { sbSelect, sbUpsert, sbDelete, getConfig } = require("../utils/supabase");
const { INFO_RISTORANTE } = require("../config");

function sanitize(s) {
  return String(s || "").replace(/[^\u0000-\u007E\u00A0-\u00FF\u0100-\u017F ]/g, "").trim();
}

async function rigeneraSuggerimenti() {
  const cfg = await getConfig();
  const apiKey = cfg["ANTHROPIC_KEY"] || process.env.ANTHROPIC_KEY;
  if (!apiKey || apiKey.includes("INSERISCI")) return { ok: false, error: "no_api_key" };

  const storico  = await sbSelect("storico",       "order=ts.desc&limit=60") || [];
  const convArch = await sbSelect("archivio_conv", "order=ts.desc&limit=20") || [];

  if (!storico.length && !convArch.length) return { ok: false, error: "nessun dato in storico" };

  const storicoTesto = (Array.isArray(storico) ? storico : []).map(o => {
    const items = (o.items || []).map(it => `${it.q || 1}x ${sanitize(it.n)}`).join(", ");
    return `${sanitize(o.fecha || "?")} ${sanitize(o.hora || "?")}h - ${sanitize(o.canal || "?")} - ${items} - ${o.totale || "?"}eur`;
  }).join("\n");

  const convTesto = (Array.isArray(convArch) ? convArch : []).slice(0, 15).map(c => {
    const chat = (c.chat || []).slice(-6).map(m => `${m.da === "cliente" ? "C" : "B"}: ${sanitize(m.txt || "").slice(0, 80)}`).join(" | ");
    return `${sanitize(c.nombre || c.wa_id || "?")}: ${chat}`;
  }).join("\n");

  const regoleEsistenti = cfg["REGOLE_APPRESE"] || "";
  const modello = cfg["AI_MODELLO"] || process.env.AI_MODELLO || "claude-haiku-4-5-20251001";

  const systemPrompt =
    "Eres el coach del bot WhatsApp de La Dieci, pizzería italiana en Roquetas de Mar. " +
    "Analiza los datos reales del restaurante y genera de 2 a 4 sugerencias concretas para mejorar el bot.\n\n" +
    "DATOS REALES DEL RESTAURANTE:\n" + INFO_RISTORANTE + "\n\n" +
    "REGLA ABSOLUTA: basa las sugerencias SOLO en los datos reales. NO inventes funcionalidades.\n\n" +
    "REGLAS YA APROBADAS (no reproponer):\n" + (regoleEsistenti || "ninguna todavía") + "\n\n" +
    "Para cada sugerencia:\n" +
    "- testo: regla concreta en ESPAÑOL (max 2 lineas)\n" +
    "- motivazione: resumen breve del problema observado\n" +
    "- tipo: 'prompt' | 'menu' | 'comportamento'\n" +
    "- casi: array de 1 a 3 casos reales. Cada caso: { \"cliente\": \"...\", \"estratto\": \"... (max 120 chars)\", \"highlight\": \"... (max 40 chars, subcadena exacta de estratto)\" }\n\n" +
    "Responde SOLO con array JSON valido (sin emojis): [{\"testo\":\"...\",\"motivazione\":\"...\",\"tipo\":\"...\",\"casi\":[{\"cliente\":\"...\",\"estratto\":\"...\",\"highlight\":\"...\"}]}]";

  const userMsg =
    `HISTÓRICO DE PEDIDOS (${storico.length} pedidos):\n${storicoTesto}` +
    (convTesto ? `\n\nCONVERSACIONES RECIENTES:\n${convTesto}` : "");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: modello, max_tokens: 2500, system: systemPrompt, messages: [{ role: "user", content: userMsg }] })
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: "claude_http_" + res.status, detail: err.slice(0, 300) };
  }

  const data = await res.json();
  const risposta = data.content?.[0]?.text;
  if (!risposta) return { ok: false, error: "no_claude" };

  let suggerimenti = [];
  try {
    const clean = risposta.replace(/```json/g, "").replace(/```/g, "").trim();
    suggerimenti = JSON.parse(clean);
    if (!Array.isArray(suggerimenti)) throw new Error("not array");
  } catch {
    return { ok: false, error: "parse", raw: risposta.slice(0, 500) };
  }

  await sbDelete("suggerimenti", "stato=eq.pending");

  const oggi = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < suggerimenti.length; i++) {
    const s = suggerimenti[i];
    const casi = Array.isArray(s.casi) ? s.casi : [];
    const motivazioneJson = JSON.stringify({ m: s.motivazione || "", c: casi });
    await sbUpsert("suggerimenti", { id: `sug_${Date.now()}_${i}`, settimana: oggi, testo: s.testo || "", motivazione: motivazioneJson, tipo: s.tipo || "comportamento", stato: "pending", ts: Date.now() });
  }

  return { ok: true, n_suggerimenti: suggerimenti.length };
}

async function approvaSuggerimento(id, stato) {
  if (!id || !stato) return { ok: false, error: "id o stato mancante" };
  const { sbUpdate } = require("../utils/supabase");
  await sbUpdate("suggerimenti", `id=eq.${id}`, { stato });

  if (stato === "approvato") {
    const approvati = await sbSelect("suggerimenti", "stato=eq.approvato&order=ts.asc") || [];
    const regole = (Array.isArray(approvati) ? approvati : []).map((s, i) => {
      let testo = s.testo || "";
      try { if (s.motivazione?.startsWith("{")) { const p = JSON.parse(s.motivazione); testo = p.m ? `${testo} (${p.m})` : testo; } } catch {}
      return `${i + 1}. ${testo}`;
    }).join("\n");
    await sbUpsert("config", { chiave: "REGOLE_APPRESE", valore: regole });
  }

  return { ok: true, id, stato };
}

module.exports = { rigeneraSuggerimenti, approvaSuggerimento };
