// ===============================================================
// claude.js — Anthropic API helper
// ===============================================================

async function chiamaClaude(systemPrompt, userMessage, cfg, maxTokens = 400) {
  const apiKey = cfg["ANTHROPIC_KEY"] || process.env.ANTHROPIC_KEY;
  if (!apiKey || apiKey.includes("INSERISCI")) return null;
  const modello = cfg["AI_MODELLO"] || process.env.AI_MODELLO || "claude-haiku-4-5-20251001";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: modello,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }]
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("chiamaClaude HTTP", res.status, err.slice(0, 200));
      return null;
    }
    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.error("chiamaClaude exception:", err.message);
    return null;
  }
}

module.exports = { chiamaClaude };
