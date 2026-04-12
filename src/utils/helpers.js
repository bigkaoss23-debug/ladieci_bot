// ===============================================================
// helpers.js — calcoli, messaggi, conversazione
// ===============================================================

const { sbSelect, sbUpsert, sbUpdate } = require("./supabase");

// --- CALCOLI ---

function calcolaTotale(items = []) {
  return Math.round(items.reduce((t, it) => t + (parseFloat(it.p || 0) * parseInt(it.q || 1)), 0) * 100) / 100;
}

function isBevanda(n = "") {
  n = n.toLowerCase();
  return ["cerveza","heineken","estrella","peroni","refresco","agua","cola","coca"].some(k => n.includes(k));
}

function isDesert(n = "") {
  return n.toLowerCase().includes("tiramisu");
}

function mergeItems(existing = [], newItems = []) {
  const result = existing.map(i => ({ ...i }));
  newItems.forEach(ni => {
    const idx = result.findIndex(r => r.n === ni.n);
    if (idx >= 0) {
      result[idx].q = (Number(result[idx].q) || 1) + (Number(ni.q) || 1);
      if (ni.sub) result[idx].sub = ni.sub;
    } else {
      result.push(ni);
    }
  });
  return result;
}

function mergeItemsBevande(existing, newItems) {
  return mergeItems(existing, newItems);
}

// --- MESSAGGI ---

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function introConferma(primo) {
  return rand([
    `${primo}, el horno ya está en marcha. 🔥`,
    `Anotado, ${primo}. El pizzaiolo ya tiene la masa lista.`,
    `${primo}, esta noche va a salir bien. 🍕`,
    `¡Hecho, ${primo}! El horno ya está caliente y tu pedido en marcha.`,
    `${primo}, el pizzaiolo ya tiene los ojos en tu pedido. 👀🍕`,
    `Todo confirmado, ${primo}. El horno no para esta noche. 🔥`
  ]);
}

function introChiediOra(primo) {
  return rand([
    `Todo anotado, ${primo}. Solo falta saber a qué hora pasas.`,
    `${primo}, ya lo tenemos todo. ¿A qué hora te esperamos?`,
    `El pedido está listo, ${primo}. ¿A qué hora encendemos el horno para ti?`,
    `${primo}, el pizzaiolo se pone manos a la obra en cuanto nos dices la hora. 🍕`,
    `Anotado, ${primo}. Solo falta la hora de recogida y arrancamos.`
  ]);
}

function closingMsg() {
  return rand([
    "¿Algo más para esta noche? Aquí seguimos.",
    "¿Añadimos algo más? Estamos aquí.",
    "¿Todo bien? Si necesitas algo más, escríbenos aquí.",
    "Cualquier cosa más, aquí estamos hasta las 23h."
  ]);
}

function ctaRisposta() {
  return rand([
    "👇 _Si te apetece añadir algo, escríbelo aquí abajo — estamos pendientes._",
    "👇 _Escríbenos aquí y lo añadimos al momento._",
    "👇 _Cualquier cosa más, aquí abajo — nuestro equipo está contigo._",
    "👇 _Añade lo que quieras aquí — en un momento lo tenemos._",
    "👇 _Si quieres completar el pedido, escríbelo aquí debajo._"
  ]);
}

function buildUpsell(items = []) {
  const tieneBebida = items.some(i => isBevanda(i.n));
  const tieneDolce  = items.some(i => {
    const n = (i.n || "").toLowerCase();
    return n.includes("tiramisu") || n.includes("tartufo") || n.includes("nutella");
  });

  if (!tieneBebida && !tieneDolce) {
    return rand([
      "¿Lo acompañamos con algo? Una cerveza bien fría y un Tiramisù para cerrar la noche como se merece. 🍺🍮",
      "El pizzaiolo dice que la pizza sola es buena, pero con una Heineken y un Tartufo es otra cosa. ¿Te apunto algo? 🍺🍮",
      "¿Añadimos algo para beber y un dulce? Los Tiramisù están esperando. 🍺🍮",
      "Una cerveza fría mientras espera la pizza y un Tiramisù de postre — ¿lo ponemos? 🍺🍮"
    ]) + "\n\n" + ctaRisposta();
  }
  if (!tieneBebida) {
    return rand([
      "¿Y para beber? Una cerveza bien fría siempre cae bien con la pizza. 🍺",
      "El Heineken y la pizza son buenos amigos — ¿te apunto una? 🍺",
      "¿Algo para beber para acompañar? Heineken, Estrella, Peroni... 🍺"
    ]) + "\n\n" + ctaRisposta();
  }
  if (!tieneDolce) {
    return rand([
      "¿Y de postre? Los Tiramisù y Tartufo están ahí esperando. 🍮",
      "Para cerrar la noche — ¿un Tiramisù o un Tartufo? 🍮",
      "El pizzaiolo recomienda no irse sin el Tiramisù. Solo lo decimos. 🍮"
    ]) + "\n\n" + ctaRisposta();
  }
  return closingMsg();
}

function buildResumen(items = []) {
  return items.map(it => {
    let r = `${it.e || ""} ${it.q || 1}x ${it.n} — ${((Number(it.p) || 0) * (Number(it.q) || 1)).toFixed(2)}€`;
    if (it.sub) r += ` (${it.sub})`;
    return r;
  }).join("\n");
}

function buildMsgRicevuto(primo, items, total, hora) {
  let msg = introConferma(primo) + "\n\n" + buildResumen(items) + "\n\n" + `*Total: ${total.toFixed(2)}€*`;
  if (hora) msg += `\n*Recogida: ${hora}*`;
  msg += "\n\n" + buildUpsell(items) + "\n*La Dieci* 🇮🇹🍕";
  return msg;
}

// --- CONVERSAZIONE ---

async function appendChat(waId, mittente, testo, iaData) {
  const conv = await getConversazione(waId);
  const record = { da: mittente || "cliente", txt: testo || "", ts: Date.now() };
  if (iaData && mittente === "cliente") record.ia = iaData;

  if (!conv) {
    const anyRows = await sbSelect("conv", `wa_id=eq.${waId}&order=ts.desc&limit=1`);
    const existingChat = (anyRows?.[0]?.chat) || [];
    const isDup = existingChat.some(c => c.da === record.da && c.txt === record.txt && Math.abs((c.ts || 0) - record.ts) < 30000);
    if (!isDup) existingChat.push(record);
    await sbUpsert("conv", { wa_id: String(waId), nombre: "", chat: existingChat, items: [], hora: "", stato_ordine: "aperta", ts: Date.now() });
    return;
  }
  const chat = conv.chat || [];
  const isDuplicate = chat.some(c => c.da === record.da && c.txt === record.txt && Math.abs((c.ts || 0) - record.ts) < 30000);
  if (isDuplicate) return;
  chat.push(record);
  await sbUpdate("conv", `wa_id=eq.${waId}&stato_ordine=not.eq.chiusa`, { chat, ts: Date.now() });
}

async function updateConvDati(waId, items, hora) {
  const upd = { ts: Date.now() };
  if (items) upd.items = items;
  if (hora) upd.hora = hora;
  await sbUpdate("conv", `wa_id=eq.${waId}&stato_ordine=not.in.(ritirata,chiusa)`, upd);
}

async function createConv(waId, nombre, items, hora, stato) {
  const existing = await getConversazione(waId);
  if (existing) {
    await sbUpdate("conv", `wa_id=eq.${waId}&stato_ordine=not.eq.chiusa`, {
      nombre: nombre || "", items: items || [], hora: hora || "",
      stato_ordine: stato || "aperta", ts: Date.now()
    });
    return;
  }
  await sbUpsert("conv", { wa_id: String(waId), nombre: nombre || "", chat: [], items: items || [], hora: hora || "", stato_ordine: stato || "aperta", ts: Date.now() });
}

async function getConversazione(waId) {
  if (!waId) return null;
  const rows = await sbSelect("conv", `wa_id=eq.${waId}&stato_ordine=not.in.(ritirata,chiusa)&order=ts.desc&limit=1`);
  if (!rows || !Array.isArray(rows) || rows.length === 0) return null;
  const r = rows[0];
  return { wa_id: r.wa_id, nombre: r.nombre || "", chat: r.chat || [], items: r.items || [], hora: r.hora || "", stato_ordine: r.stato_ordine || "aperta", ts: r.ts || 0 };
}

async function upsertWaMsg(waId, nombre, txt, stato, conf, items, hora, botRisposta, forceNew = false, targetId = null) {
  if (!forceNew && targetId) {
    const upd = { ts: Date.now() };
    if (nombre) upd.nombre = nombre;
    if (txt) upd.txt = txt;
    if (stato) upd.stato = stato;
    if (conf != null) upd.ia_conf = conf;
    if (items) upd.ia_items = items;
    if (hora) upd.ia_hora = hora;
    if (botRisposta != null) upd.bot_risposta = botRisposta;
    await sbUpdate("wa_msgs", `id=eq.${targetId}`, upd);
    return { success: true, id: targetId };
  }
  let existing = null;
  if (!forceNew) {
    const rows = await sbSelect("wa_msgs", `wa_id=eq.${waId}&stato=not.in.(COMPLETATO,COCINA)&order=ts.desc&limit=1`);
    if (rows && Array.isArray(rows) && rows.length > 0) existing = rows[0];
  }
  const now = Date.now();
  if (existing) {
    const upd = { ts: now };
    if (nombre) upd.nombre = nombre;
    if (txt) upd.txt = txt;
    if (stato) upd.stato = stato;
    if (conf != null) upd.ia_conf = conf;
    if (items) upd.ia_items = items;
    if (hora) upd.ia_hora = hora;
    if (botRisposta != null) upd.bot_risposta = botRisposta;
    await sbUpdate("wa_msgs", `id=eq.${existing.id}`, upd);
    return { success: true, id: existing.id };
  }
  const id = "w" + now;
  await sbUpsert("wa_msgs", { id, wa_id: String(waId), nombre: nombre || "", txt: txt || "", ts: now, stato: stato || "NUEVO", ia_conf: conf || 0, ia_items: items || [], ia_hora: hora || "", bot_risposta: botRisposta || "", ordine_ref: "" });
  return { success: true, id };
}

module.exports = {
  calcolaTotale, isBevanda, isDesert, mergeItems, mergeItemsBevande,
  buildResumen, buildUpsell, buildMsgRicevuto, introChiediOra, ctaRisposta,
  appendChat, updateConvDati, createConv, getConversazione, upsertWaMsg
};
