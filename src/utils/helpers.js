// ===============================================================
// helpers.js — calcoli, messaggi, conversazione
// ===============================================================

const { sbSelect, sbUpsert, sbUpdate } = require("./supabase");
const { COSTO_CONSEGNA } = require("../config");

// --- CALCOLI ---
//
// Una sola sorgente di verità per il totale ordine:
//   totale = sum(items.p * items.q) + delivery_fee
// delivery_fee dipende SOLO da tipo_consegna ("DOMICILIO" → COSTO_CONSEGNA, altrimenti 0).
// Mai sommare il delivery in altri punti del codice — usare sempre queste funzioni.

function calcolaTotale(items = []) {
  return Math.round(items.reduce((t, it) => t + (parseFloat(it.p || 0) * parseInt(it.q || 1)), 0) * 100) / 100;
}

function deliveryFeeFor(tipoConsegna) {
  return (tipoConsegna === "DOMICILIO") ? COSTO_CONSEGNA : 0;
}

function calcolaTotaleOrdine(items = [], tipoConsegna = "RITIRO") {
  return Math.round((calcolaTotale(items) + deliveryFeeFor(tipoConsegna)) * 100) / 100;
}

// Sconto cliente: € fisso o % sul totale finale.
// Mirror del helper frontend (src/constants.js). Sorgente autoritativa sul backend.
function aplicarDescuento(totaleBase, tipo, valor) {
  const base = Number(totaleBase) || 0;
  const v    = Number(valor)      || 0;
  if (!tipo || v <= 0 || base <= 0) return { totale: base, importe: 0 };
  let importe = 0;
  if (tipo === "EURO")    importe = v;
  if (tipo === "PERCENT") importe = (base * v) / 100;
  if (importe > base) importe = base;
  importe = Math.round(importe * 100) / 100;
  const totale = Math.round((base - importe) * 100) / 100;
  return { totale, importe };
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
      "¿Lo acompañamos con algo? Una cerveza fría (Heineken, Estrella, Peroni) o un Tiramisù / Tartufo de postre. 🍺🍮",
      "¿Añadimos algo más? Tenemos cervezas bien frías y Tiramisù o Tartufo para cerrar la noche. 🍺🍮",
      "¿Una cerveza o un postre para acompañar? Heineken, Tiramisù, Tartufo — tú eliges. 🍺🍮"
    ]);
  }
  if (!tieneBebida) {
    return rand([
      "¿Y para beber? Una Heineken, Estrella o Peroni bien fría siempre cae bien. 🍺",
      "¿Añadimos algo para beber? Tenemos Heineken, Estrella, Peroni. 🍺"
    ]);
  }
  if (!tieneDolce) {
    return rand([
      "¿Y de postre? Un Tiramisù o un Tartufo para cerrar la noche en grande. 🍮",
      "Para terminar — ¿un Tiramisù o un Tartufo? 🍮"
    ]);
  }
  return rand([
    "¿Algo más para esta noche? Aquí seguimos.",
    "¿Todo bien? Si necesitas algo más, escríbenos.",
    "Cualquier cosa más, aquí estamos hasta las 23h."
  ]);
}

function buildResumen(items = []) {
  return items.map(it => {
    let r = `${it.e || ""} ${it.q || 1}x ${it.n} — ${((Number(it.p) || 0) * (Number(it.q) || 1)).toFixed(2)}€`;
    if (it.sub) r += ` (${it.sub})`;
    return r;
  }).join("\n");
}

function buildMsgRicevuto(primo, items, total, hora, tipoConsegna, costoConsegna, direccion, introOverride, descuentoImporte = 0) {
  const costo = costoConsegna || 0;
  const subtotalConConsegna = Math.round((total + costo) * 100) / 100;
  const desc = Math.max(0, Number(descuentoImporte) || 0);
  const totaleFinale = Math.round((subtotalConConsegna - desc) * 100) / 100;
  const pizzaItems = items.filter(i => i.n !== "Entrega a domicilio");

  let msg = (introOverride || introConferma(primo)) + "\n\n";
  msg += buildResumen(pizzaItems) + "\n\n";

  if (desc > 0) {
    msg += `Subtotal: ${subtotalConConsegna.toFixed(2)}€${costo > 0 ? `  🛵 Delivery: ${costo.toFixed(2)}€` : ""}\n`;
    msg += `Descuento: -${desc.toFixed(2)}€\n`;
    msg += `💰 *Total: ${totaleFinale.toFixed(2)}€*\n`;
  } else if (costo > 0) {
    msg += `💰 *Total: ${subtotalConConsegna.toFixed(2)}€*  🛵 Delivery: ${costo.toFixed(2)}€\n`;
  } else {
    msg += `💰 *Total: ${total.toFixed(2)}€*\n`;
  }

  const labelOra = tipoConsegna === "DOMICILIO" ? "Entrega" : "Recogida";
  if (hora) {
    if (tipoConsegna === "DOMICILIO" && direccion) {
      msg += `⏰ ${labelOra}: *${hora}* · 📍 *${direccion}*\n`;
    } else {
      msg += `⏰ ${labelOra}: *${hora}*\n`;
    }
  }

  const upsell = buildUpsell(pizzaItems);
  msg += "\n" + upsell + "\n\nSi quieres añadir algo, escríbenos aquí.\n*Bot La Dieci* 🇮🇹🍕";
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

// Normalizzazione "leggera": lowercase, accenti, punteggiatura → spazi.
// Usata per direccion_orig e display. NON per la cache key.
// Stessa logica usata sul frontend (api.js) — DEVE restare allineata.
function normalizzaDireccion(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalizzazione AGGRESSIVA "edificio-level" — chiave di cache stabile.
// Obiettivo: due clienti nello stesso condominio condividono la stessa chiave
// → una sola chiamata Google per edificio.
//
// "Calle Cuba 5, 3ºA"  ┐
// "C/ Cuba 5 piso 4"   ├─→ "calle cuba 5"
// "calle cuba 5 izq"   ┘
//
// Pipeline:
// 1. lowercase + togli accenti
// 2. rimuovi info appartamento (piso, planta, puerta, escalera, bloque, portal,
//    apto, interior, letra, izq/dcha, "3ºA", bajo, ático, ecc.)
// 3. canonicalizza abbreviazioni via (c/→calle, av./avda→avenida, pza→plaza, ecc.)
// 4. punteggiatura → spazi, comprimi spazi
function direccionToCacheKey(s) {
  let r = String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");

  // Step 1bis: rimuovi suffissi località/CAP/provincia/paese.
  // "Calle X 5, 04740 Roquetas de Mar, Almería, España" → "Calle X 5"
  // IMPORTANTE: richiede una virgola davanti (formato postale standard). Senza virgola
  // non strippa, per evitare di tagliare parole legittime nei nomi di via — es.
  // "Avenida Reino de España 250" non deve perdere "españa".
  // Eseguito prima del filtro appartamento per evitare che il match con "roquetas" interferisca.
  r = r.replace(/,\s*\d{5}\b/g, ",");                              // CAP es. ", 04740"
  r = r.replace(/,\s*roquetas\s+de\s+mar\b/gi, ",");
  r = r.replace(/,\s*roquetas\b/gi, ",");
  r = r.replace(/,\s*aguadulce\b/gi, ",");
  r = r.replace(/,\s*almer[ií]a\b/gi, ",");
  r = r.replace(/,\s*(?:espa[ñn]a|spain)\b/gi, ",");
  // Compatta virgole vuote lasciate dalle sostituzioni: ",,," → ","
  r = r.replace(/,(?:\s*,)+/g, ",").replace(/,\s*$/g, "");

  // Step 2: rimuovi tutto da indicatore appartamento in poi
  // Cattura: piso/planta/puerta/pta/escalera/esc/bloque/blq/portal/apto/apartamento/
  //          interior/int/letra/izq(uierda)?/dcha?/derecha/bajo/atico/sotano + tutto dopo
  r = r.replace(/[\s,]+(?:piso|planta|puerta|pta\b\.?|escalera?|esc\b\.?|bloque?|blq\b\.?|portal|apto\b\.?|apartamento|interior|int\b\.?|letra|izq(?:uierda)?|dcha?|derecha|bajo|atico|sotano).*$/gi, "");
  // Cattura pattern "3ºA" / "1ª izq" / "2-B" alla fine (anche senza keyword)
  r = r.replace(/[\s,]+\d+\s*[ºª°o]\s*[a-z]*\s*$/gi, "");
  r = r.replace(/[\s,]+\d+\s*[\-/]\s*[a-z]\s*$/gi, "");

  // Step 3: canonicalizza abbreviazioni VIA (token-based, sicuro)
  // Sostituisce SOLO il primo token via, per evitare di toccare nomi di via
  r = r.replace(/^\s*c\s*[\/.,]\s*/i,  "calle ");        // "c/ cuba" → "calle cuba"
  r = r.replace(/^\s*calle\b\.?/i,     "calle");
  r = r.replace(/^\s*(?:av|avd|avda)\b\.?/i,           "avenida");
  r = r.replace(/^\s*avenida\b\.?/i,                   "avenida");
  r = r.replace(/^\s*(?:pza|pl)\b\.?/i,                "plaza");
  r = r.replace(/^\s*plaza\b\.?/i,                     "plaza");
  r = r.replace(/^\s*(?:ctra|crta)\b\.?/i,             "carretera");
  r = r.replace(/^\s*carretera\b\.?/i,                 "carretera");
  r = r.replace(/^\s*paseo\b\.?/i,                   "paseo");
  r = r.replace(/^\s*p\s*\.?\s*[ºª°]\s+/i,           "paseo ");
  r = r.replace(/^\s*(?:urb|urbanizacion|urbanización)\b\.?/i, "urbanizacion");

  // Step 4: punteggiatura → spazi + comprimi
  r = r.replace(/[.,;:]/g, " ").replace(/\s+/g, " ").trim();

  return r;
}

module.exports = {
  rand, calcolaTotale, deliveryFeeFor, calcolaTotaleOrdine, aplicarDescuento,
  isBevanda, isDesert, mergeItems, mergeItemsBevande,
  buildResumen, buildUpsell, buildMsgRicevuto, introChiediOra, ctaRisposta,
  appendChat, updateConvDati, createConv, getConversazione, upsertWaMsg,
  normalizzaDireccion, direccionToCacheKey
};
