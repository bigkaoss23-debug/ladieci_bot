// ===============================================================
// agentWhatsapp.js — interpreta e comunica
// ===============================================================

const { chiamaClaude } = require("../utils/claude");
const { sbSelect, sbUpdate, sbUpsert } = require("../utils/supabase");
const { isBevanda } = require("../utils/helpers");
const { MENU_LISTA, INFO_RISTORANTE, ABBINAMENTI_NOMI } = require("../config");

function contestoTempo() {
  const now = new Date();
  const dias = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const dia = dias[now.getDay()];
  const h = now.getHours(), m = now.getMinutes();
  const hStr = String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
  const abierto = (now.getDay() === 0 || now.getDay() >= 3);
  const enHorario = (h > 19 || (h === 19 && m >= 30)) && h < 23;
  return "CONTESTO TEMPORALE:\n" +
    `- Oggi: ${dia} ${now.getDate()}/${now.getMonth()+1}/${now.getFullYear()}\n` +
    `- Ora attuale: ${hStr}\n` +
    `- Apertura: mercoledì-domenica 19:30-23:00\n` +
    `- Stato oggi: ${abierto ? "APERTO" : "CHIUSO (lunes y martes no abrimos)"}` +
    (abierto ? (enHorario ? " — servicio en marcha ahora" : " — fuera de horario ahora") : "") + "\n";
}

function assicuraFirma(testo) {
  if (!testo) return testo;
  if (testo.includes("La Dieci") || testo.includes("El Bot La Dieci")) return testo;
  return testo + "\n*La Dieci* 🇮🇹🍕";
}

async function interpreta(testo, cfg, clienteInfo, chatHistory) {
  const cTempo = contestoTempo();
  let contestoCliente = "";
  if (clienteInfo?.total_pedidos > 0) {
    const testoLow = (testo || "").toLowerCase();
    const isLoSiempre = testoLow.includes("siempre") || testoLow.includes("habitual");
    contestoCliente = `\nCLIENTE ABITUALE: ${clienteInfo.nombre} - ${clienteInfo.total_pedidos} ordini.\n`;
    if (isLoSiempre && clienteInfo.pizza_pref) {
      contestoCliente += `pizza_pref: ${clienteInfo.pizza_pref}${clienteInfo.bevanda_pref ? ", bevanda_pref: " + clienteInfo.bevanda_pref : ""}\n`;
    }
  }
  let contestoChat = "";
  if (chatHistory?.length > 0) {
    contestoChat = "\nCONVERSAZIONE PRECEDENTE:\n" +
      chatHistory.map(m => (m.da === "cliente" ? "Cliente" : "Bot") + ": " + m.txt).join("\n") + "\n";
  }
  contestoChat +=
    "\nREGOLE CONTESTO:\n" +
    "- Restituisci SOLO gli items ESPLICITAMENTE richiesti nel MESSAGGIO ATTUALE.\n" +
    "- NON estrarre items da opzioni offerte dal bot.\n" +
    "- Saluti/conferme/ringraziamenti senza ordine -> tipo=domanda, items=[], conf=0.\n" +
    "- Messaggio con SOLO un orario -> tipo=solo_ora, items=[].\n" +
    "- OGNI modifica (mas/sin/con/extra/doble) nel messaggio DEVE finire nel campo sub.\n";

  const systemPrompt =
    "Sei un assistente per una pizzeria italiana. Analizza il messaggio WhatsApp.\n" +
    "Rispondi SOLO con JSON valido, niente testo extra.\n\n" +
    "MENU: " + MENU_LISTA.join(", ") + "\n" +
    cTempo + contestoCliente + contestoChat +
    "\nSALUTI — REGOLA FONDAMENTALE:\n" +
    "Ignora completamente saluti iniziali e finali: hola, buenas, hey, buenos dias, buenas noches,\n" +
    "que tal, gracias, adios, hasta luego, nos vemos, de nada, vale, ok, perfecto.\n" +
    "I saluti NON abbassano mai la confidenza.\n\n" +
    "TIPI DI RISPOSTA:\n" +
    "1. domanda (conf=0, items=[]): info, prezzi, orari, allergeni.\n" +
    "2. ordine (conf 70-99): ordina esplicitamente. INCLUDE frasi come 'Puedo pedir X?', 'Me pones X?'.\n" +
    "3. misto (conf max 40): domanda REALE + intento vago.\n" +
    "4. solo_ora (conf 90, items=[]): messaggio contiene SOLO un orario.\n" +
    "5. correccion (conf 90): cliente CORREGGE quantita. items = quantita TOTALE desiderata.\n" +
    "6. modifica_complessa (conf 90, items=[]): cambio/eliminazione item. Segnali: 'en vez de', 'cambiar', 'quitar', 'elimina'.\n" +
    "7. custom_pizza (conf=50, items=[]): pizza completamente inventata fuori menu.\n\n" +
    "ABBINAMENTI NOMI:\n" + ABBINAMENTI_NOMI + "\n\n" +
    "BEBIDAS — REGLA sub: Cuando el cliente pide un refresco con nombre específico\n" +
    "(Coca Cola, Fanta, Sprite, Nestea, Aquarius, Seven Up, etc.) → n='Refresco', p=2.50,\n" +
    "y guarda el nombre exacto en sub. Ejemplo: 'una Fanta' → {n:'Refresco',p:2.50,sub:'Fanta'}.\n" +
    "Si dice solo 'refresco' sin especificar → sub=''.\n\n" +
    "NUMEROS MENU: 1=El Pelusa, 2=Zizou, 3=O Rei, 4=Il Gladiatore, 5=El Gaucho,\n" +
    "6=El Divino Codino, 7=La Pulga, 8=Il Tulipano Nero, 9=El Ultimo 10, 10=El Mago de Zadar, 11=El Maestro.\n\n" +
    (cfg["REGOLE_APPRESE"] ? "REGOLE APPRESE — APPLICA SEMPRE:\n" + cfg["REGOLE_APPRESE"] + "\n\n" : "") +
    "CONSEGNA A DOMICILIO — REGOLE ESTRAZIONE:\n" +
    "Se il messaggio contiene parole come: 'a casa', 'a domicilio', 'llevar', 'traer', 'enviar',\n" +
    "'entrega', 'delivery', 'me lo traéis', 'me lo llevais', oppure un indirizzo esplicito\n" +
    "(calle, avenida, urb, plaza, paseo, carretera + numero civico) → tipo_consegna='DOMICILIO'\n" +
    "Estrai l'indirizzo nel campo 'direccion' esattamente come scritto dal cliente.\n" +
    "Se NON menziona consegna a domicilio → tipo_consegna='RITIRO', direccion=''\n" +
    "CRITICO: NON inventare indirizzi. Se scrive 'domicilio' senza indirizzo → tipo_consegna='DOMICILIO', direccion=''\n\n" +
    "FORMATO OUTPUT (solo JSON):\n" +
    "{\"tipo\":\"ordine|domanda|misto|solo_ora|correccion|modifica_complessa|custom_pizza\"," +
    "\"items\":[{\"n\":\"nome\",\"q\":1,\"p\":9.50,\"e\":\"emoji\",\"sub\":\"\"}]," +
    "\"nota\":\"\",\"hora\":\"\",\"conf\":95," +
    "\"tipo_consegna\":\"RITIRO\",\"direccion\":\"\"}\n\n" +
    "CAMPO sub CRITICO: SEMPRE presente. Se nessuna variazione: sub=''. Con variazione: riempilo.\n" +
    "Esempi: 'marinara sin ajo' -> sub='sin ajo' | 'diavola extra picante' -> sub='extra picante'\n\n" +
    "REGOLA ANTI-INVENZIONE — CRITICA:\n" +
    "Se il cliente chiede una pizza che NON esiste nel menu e NON ha un abbinamento esplicito sopra\n" +
    "(es: carbonara, quattro stagioni, fungi, napoli, calzone, hawaiana, bbq, etc.),\n" +
    "NON mapparla a un'altra pizza. Imposta tipo=domanda, conf=0, items=[].\n" +
    "Il bot risponderà che non abbiamo quel prodotto e mostrerà il menu.";

  try {
    const testoNorm = testo.replace(/\s+/g, " ").trim();
    const raw = await chiamaClaude(systemPrompt, `MESSAGGIO: "${testoNorm}"`, cfg, 600);
    if (!raw) return { items: [], nota: "", hora: "", conf: 0, tipo: "errore" };
    const clean = raw.trim().replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    const normalizedItems = (parsed.items || []).map(it => ({
      n: it.n || "", q: Number(it.q) || 1, p: Number(it.p) || 0,
      e: it.e || "", sub: (it.sub != null) ? String(it.sub) : ""
    }));
    return {
      items: normalizedItems,
      nota: parsed.nota || "",
      hora: parsed.hora || "",
      conf: parsed.conf || 0,
      tipo: parsed.tipo || "ordine",
      correccion: parsed.tipo === "correccion",
      customPizza: parsed.tipo === "custom_pizza",
      // ═══ Delivery fields ═══
      tipo_consegna: parsed.tipo_consegna === "DOMICILIO" ? "DOMICILIO" : "RITIRO",
      direccion: parsed.direccion || ""
    };
  } catch (err) {
    console.error("interpreta error:", err.message);
    return { items: [], nota: "", hora: "", conf: 0, tipo: "errore" };
  }
}

async function generaRisposta(testo, waId, cfg, threadCtx) {
  const cliente = await getCliente(waId);
  const tono = rilevaTonoCliente(testo);
  const systemPrompt =
    "Eres el asistente WhatsApp de La Dieci, pizzería italiana en Roquetas de Mar.\n" +
    "IDIOMA: responde SIEMPRE en español.\n" +
    "TONO:\n✅ Cálido y profesional — como un buen camarero italiano\n" +
    "✅ Usa referencias reales: el horno, el pizzaiolo, la masa, esta noche\n" +
    "❌ NUNCA: tío, hermano, ey, venga, chaval — sin argot de bar\n" +
    (tono === "formale" ? "Usa USTED.\n" : "Usa TÚ.\n") +
    "FORMATO: respuesta directa y cálida, máximo 4 líneas. Firma: *La Dieci* 🇮🇹🍕\n" +
    contestoTempo() + INFO_RISTORANTE + "\n" +
    (cliente ? `CLIENTE CONOCIDO: ${cliente.nombre} - ${cliente.total_pedidos} visitas\n` : "") +
    (threadCtx ? `\nCONVERSACION:\n${threadCtx}\n` : "");
  return assicuraFirma(await chiamaClaude(systemPrompt, testo, cfg, 400));
}

async function generaConfermaOrdine(primo, items, totale, hora, cfg, clienteInfo, chatHistory, horaRichiesta, tipoConsegna) {
  const resumen = items.map(it => {
    let r = `${it.e || ""} ${it.q || 1}x ${it.n} — ${((Number(it.p) || 0) * (Number(it.q) || 1)).toFixed(2)}€`;
    if (it.sub) r += ` (${it.sub})`;
    return r;
  }).join("\n");

  const tieneBebida = items.some(i => isBevanda(i.n));
  const tieneDolce  = items.some(i => { const n = (i.n || "").toLowerCase(); return n.includes("tiramisu") || n.includes("tartufo") || n.includes("nutella"); });

  let upsellCtx = "";
  if (!tieneBebida && !tieneDolce) upsellCtx = "UPSELL OBBLIGATORIO: nessuna bevanda né dolce. Aggiungi UNA domanda su birra (Heineken, Estrella, Peroni) e dolce (Tiramisù, Tartufo). Termina con: '👇 _Escríbenos aquí y lo añadimos al momento._'\n";
  else if (!tieneBebida) upsellCtx = "UPSELL OBBLIGATORIO: nessuna bevanda. Aggiungi UNA domanda su birra. Termina con CTA 👇.\n";
  else if (!tieneDolce) upsellCtx = "UPSELL OBBLIGATORIO: nessun dolce. Aggiungi UNA domanda su Tiramisù o Tartufo. Termina con CTA 👇.\n";

  const oraCambioCtx = (horaRichiesta && horaRichiesta !== hora)
    ? `CAMBIO ORARIO: cliente ha chiesto le ${horaRichiesta} ma slot disponibile è ${hora}. Menzionalo in modo caldo.\n` : "";
  const giaInConv = chatHistory?.length > 0;
  const convCtx = giaInConv ? "YA estáis en conversación. PROHIBIDO saludar — ve directo a confirmar.\n" : "";
  const clienteCtx = (clienteInfo?.total_pedidos > 0) ? `Cliente habitual: ${primo} (${clienteInfo.total_pedidos} visitas).\n` : "";

  const systemPrompt =
    "Eres el asistente WhatsApp de La Dieci, pizzería italiana en Roquetas de Mar.\n" +
    "IDIOMA: SIEMPRE español.\nTONO: Cálido, profesional, referencias reales (horno, pizzaiolo, masa).\n" +
    "❌ NUNCA: tío, hermano, ey, venga, chaval, argot de bar.\n\n" +
    oraCambioCtx + clienteCtx + convCtx + upsellCtx +
    (tipoConsegna === "DOMICILIO"
      ? `TAREA: Confirma el pedido a DOMICILIO de ${primo}.\nPEDIDO:\n${resumen}\n*Total: ${totale.toFixed(2)}€*\n*Entrega: ${hora}*\n\n` +
        "IMPORTANTE: es entrega a domicilio — usa 'entrega', 'llevamos', NUNCA 'recogida' ni 'recoger'.\n"
      : `TAREA: Confirma el pedido de ${primo}.\nPEDIDO:\n${resumen}\n*Total: ${totale.toFixed(2)}€*\n*Recogida: ${hora}*\n\n`) +
    "ESTRUCTURA: frase cálida → lista pedido → total/hora → upsell (si aplica) → *La Dieci* 🇮🇹🍕\n" +
    "PROHIBIDO: inventar URLs, links, webs o botones de confirmación. NO existe ninguna web de pedidos.\n" +
    "Máximo 10 líneas. NO inventar precios.";

  return assicuraFirma(await chiamaClaude(systemPrompt, "Confirma el pedido.", cfg, 400));
}

async function generaChiediOra(primo, items, cfg, clienteInfo, chatHistory, tipoConsegna) {
  const resumen = items.map(it => { let b = `${it.e || ""} ${it.q || 1}x ${it.n}`; if (it.sub) b += ` (${it.sub})`; return b; }).join(", ");
  const giaInConv = chatHistory?.length > 0;
  const esEntrega = tipoConsegna === "DOMICILIO";
  const systemPrompt =
    "Eres el asistente WhatsApp de La Dieci Pizzeria.\n" +
    "TONO: Simpatico, calido. IDIOMA: SIEMPRE ESPANOL.\n" +
    (clienteInfo?.total_pedidos > 0 ? `Cliente habitual con ${clienteInfo.total_pedidos} visitas.\n` : "") +
    (giaInConv ? "YA estais en conversacion. PROHIBIDO saludar. Sigue directamente.\n" : "") +
    `TAREA: El cliente '${primo}' ha pedido [${resumen}] pero falta la hora. Confirma items y pide la hora. Max 3-4 lineas.\n` +
    (esEntrega ? "Es un pedido a DOMICILIO — usa palabras como 'entrega', 'llevar', NO 'recoger' ni 'recogida'.\n" : "") +
    "HORARIO: entregas/recogidas 19:30-23:00 (miercoles a domingo).\nFIRMA: *El Bot La Dieci* 🇮🇹🍕";
  return assicuraFirma(await chiamaClaude(systemPrompt, "Pide la hora.", cfg, 200));
}

async function invia(to, text, cfg) {
  if (!text) return;
  const token = cfg["WA_ACCESS_TOKEN"] || process.env.WA_ACCESS_TOKEN;
  const phoneId = cfg["WA_PHONE_ID"] || process.env.WA_PHONE_ID;
  if (!token || token.includes("INSERISCI")) return;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: String(to).replace("+", ""), type: "text", text: { body: text } })
    });
  } catch (err) { console.error("invia WA error:", err.message); }
}

async function getCliente(tel) {
  if (!tel) return null;
  const rows = await sbSelect("clientes", `tel=eq.${String(tel).replace("+", "")}`);
  return (rows?.length > 0) ? rows[0] : null;
}

async function upsertCliente(nombre, tel, items) {
  if (!nombre || !tel) return;
  const telNorm = String(tel).replace("+", "");
  const pizze = [], bevande = [];
  (items || []).forEach(it => { if (isBevanda(it.n)) bevande.push(it.n); else pizze.push(it.n); });
  const existing = await getCliente(telNorm);
  if (existing) {
    await sbUpdate("clientes", `tel=eq.${telNorm}`, { nombre, total_pedidos: (existing.total_pedidos || 0) + 1, ultimo_pedido: new Date().toISOString(), ultimo_items: items || [], pizza_pref: pizze[0] || existing.pizza_pref || "", bevanda_pref: bevande[0] || existing.bevanda_pref || "" });
  } else {
    await sbUpsert("clientes", { tel: telNorm, nombre, total_pedidos: 1, ultimo_pedido: new Date().toISOString(), ultimo_items: items || [], pizza_pref: pizze[0] || "", bevanda_pref: bevande[0] || "", nota_fissa: "", orario_solito: "" });
  }
}

function rilevaTonoCliente(testo) {
  if (!testo) return "informale";
  const t = testo.toLowerCase();
  return ["usted","podria","quisiera","por favor","disculpe"].some(k => t.includes(k)) ? "formale" : "informale";
}

module.exports = { interpreta, generaRisposta, generaConfermaOrdine, generaChiediOra, invia, getCliente, upsertCliente };
