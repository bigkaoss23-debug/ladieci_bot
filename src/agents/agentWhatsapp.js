// ===============================================================
// agentWhatsapp.js — interpreta e comunica
// ===============================================================

const { chiamaClaude } = require("../utils/claude");
const { sbSelect, sbUpdate, sbUpsert } = require("../utils/supabase");
const { isBevanda } = require("../utils/helpers");
const { MENU_LISTA, INFO_RISTORANTE, ABBINAMENTI_NOMI, COSTO_CONSEGNA } = require("../config");
const { KEYWORDS_ZONA } = require("../utils/zones");

// Tipi di via spagnoli non ambigui come marcatori di indirizzo postale
const RE_TIPOS_VIA = /\b(calle|c\/|avenida|avda?\.?|paseo|carretera|ctra\.?|bulevar|boulevard|urbanizaci[oó]n|urb\.?|ronda|traves[íi]a|autov[íi]a|plaza)[\s.]+\w/i;

// Parole chiave di zona non ambigue come marcatori di indirizzo
// Escluse: "camino" (es. "voy de camino"), "centro", "marinas", "ies", "instituto", "poeta", "residencial"
const KEYWORDS_ZONA_ADDRESS = [
  "buenavista", "italica", "itálica",
  "las marinas", "playa serena", "minarete",
  "cortijo", "cortijos", "salinas",
  "cervantes", "colón", "colon"
];

// Sanitize defensiva al punto di iniezione: anche se cfg["REGOLE_APPRESE"]
// contiene regole non filtrate (es. scritte direttamente in DB, eredità
// pre-`f4e4226`, drift schema), le rimuoviamo prima di entrare nel
// systemPrompt. Coerente con il filtro applicato in promozione in
// agenteMiglioramento.approvaSuggerimento.
//   - input null/undefined/"" → ""
//   - una regola per riga; trim, skip righe vuote
//   - cap per riga 200 char, cap totale 20 righe
//   - denylist case-insensitive su frasi tipiche di prompt injection
const REGOLE_DENYLIST = /ignora\s+reglas|ignore\s+previous|olvida\s+(las\s+)?reglas|confirma\s+todo|conf\s*=|tipo\s*=|tipo_consegna|EN_COCINA|sin\s+operador|bypass|no\s+pedir\s+confirma|\bsystem\b|\bJSON\b/i;
const REGOLE_MAX_LINE = 200;
const REGOLE_MAX_LINES = 20;
function sanitizeRegoleAppreseForPrompt(input) {
  if (input == null) return "";
  const raw = String(input);
  if (!raw.trim()) return "";
  const clean = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (REGOLE_DENYLIST.test(t)) continue;
    clean.push(t.length > REGOLE_MAX_LINE ? t.slice(0, REGOLE_MAX_LINE) : t);
    if (clean.length >= REGOLE_MAX_LINES) break;
  }
  return clean.join("\n");
}

function preDetectaDireccion(testo) {
  if (RE_TIPOS_VIA.test(testo)) return true;
  const lower = testo.toLowerCase();
  return KEYWORDS_ZONA_ADDRESS.some(k => lower.includes(k));
}

function contestoTempo() {
  const now = new Date();
  const dias = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const dia = dias[now.getDay()];
  const h = now.getHours(), m = now.getMinutes();
  const hStr = String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
  const abierto = (now.getDay() === 0 || now.getDay() >= 3);
  const enHorario = (h > 19 || (h === 19 && m >= 30)) && h < 23;
  return "CONTEXTO TEMPORAL:\n" +
    `- Hoy: ${dia} ${now.getDate()}/${now.getMonth()+1}/${now.getFullYear()}\n` +
    `- Hora actual: ${hStr}\n` +
    `- Recogida en local: miércoles-domingo 19:30-23:00\n` +
    `- Reparto a domicilio: miércoles-domingo 20:00-23:00\n` +
    `- Estado hoy: ${abierto ? "ABIERTO" : "CERRADO (lunes y martes no abrimos)"}` +
    (abierto ? (enHorario ? " — servicio en marcha ahora" : " — fuera de horario ahora") : "") + "\n";
}

function assicuraFirma(testo) {
  if (!testo) return testo;
  if (testo.includes("La Dieci") || testo.includes("El Bot La Dieci")) return testo;
  return testo + "\n*La Dieci* 🇮🇹🍕";
}

async function interpreta(testo, cfg, clienteInfo, chatHistory) {
  const cTempo = contestoTempo();
  const direccionPreDetectada = preDetectaDireccion(testo);
  let contestoCliente = "";
  if (clienteInfo?.total_pedidos > 0) {
    const testoLow = (testo || "").toLowerCase();
    const isLoSiempre = testoLow.includes("siempre") || testoLow.includes("habitual");
    contestoCliente = `\nCLIENTE HABITUAL: ${clienteInfo.nombre} - ${clienteInfo.total_pedidos} pedidos.\n`;
    if (isLoSiempre && clienteInfo.pizza_pref) {
      contestoCliente += `pizza_pref: ${clienteInfo.pizza_pref}${clienteInfo.bevanda_pref ? ", bebida_pref: " + clienteInfo.bevanda_pref : ""}\n`;
    }
  }
  let contestoChat = "";
  if (chatHistory?.length > 0) {
    contestoChat = "\nCONVERSACIÓN PREVIA:\n" +
      chatHistory.map(m => (m.da === "cliente" ? "Cliente" : "Bot") + ": " + m.txt).join("\n") + "\n";
  }
  contestoChat +=
    "\nREGLAS CONTEXTO:\n" +
    "- Devuelve SOLO los items EXPLÍCITAMENTE pedidos en el MENSAJE ACTUAL.\n" +
    "- NO extraer items de opciones ofrecidas por el bot.\n" +
    "- Saludos/confirmaciones/agradecimientos sin pedido -> tipo=domanda, items=[], conf=0.\n" +
    "- Mensaje con SOLO un horario -> tipo=solo_ora, items=[].\n" +
    "- CADA modificación (mas/sin/con/extra/doble) en el mensaje DEBE ir en el campo sub.\n";

  const systemPrompt =
    "Eres un asistente para una pizzería italiana. Analiza el mensaje de WhatsApp.\n" +
    "Responde SOLO con JSON válido, sin texto extra.\n\n" +
    "MENÚ: " + MENU_LISTA.join(", ") + "\n" +
    cTempo + contestoCliente + contestoChat +
    "\nSALUDOS — REGLA FUNDAMENTAL:\n" +
    "Ignora completamente saludos iniciales y finales: hola, buenas, hey, buenos días, buenas noches,\n" +
    "qué tal, gracias, adiós, hasta luego, nos vemos, de nada, vale, ok, perfecto.\n" +
    "Los saludos NUNCA reducen la confianza.\n\n" +
    "TIPOS DE RESPUESTA:\n" +
    "1. domanda (conf=0, items=[]): info, precios, horarios, alérgenos.\n" +
    "2. ordine (conf 70-99): pide explícitamente. INCLUYE frases como 'Puedo pedir X?', 'Me pones X?'.\n" +
    "3. misto (conf max 40): pregunta REAL + intención vaga.\n" +
    "4. solo_ora (conf 90, items=[]): mensaje contiene SOLO un horario.\n" +
    "5. correccion (conf 90): cliente CORRIGE cantidad. items = cantidad TOTAL deseada.\n" +
    "6. modifica_complessa (conf 90, items=[]): cambio/eliminación de item. Señales: 'en vez de', 'cambiar', 'quitar', 'elimina'.\n" +
    "7. custom_pizza (conf=50, items=[]): pizza completamente inventada fuera del menú.\n\n" +
    "EQUIVALENCIAS DE NOMBRES:\n" + ABBINAMENTI_NOMI + "\n\n" +
    "BEBIDAS — REGLA sub: Cuando el cliente pide un refresco con nombre específico\n" +
    "(Coca Cola, Fanta, Sprite, Nestea, Aquarius, Seven Up, etc.) → n='Refresco', p=2.50,\n" +
    "y guarda el nombre exacto en sub. Ejemplo: 'una Fanta' → {n:'Refresco',p:2.50,sub:'Fanta'}.\n" +
    "Si dice solo 'refresco' sin especificar → sub=''.\n\n" +
    "NÚMEROS MENÚ: 1=El Pelusa, 2=Zizou, 3=O Rei, 4=Il Gladiatore, 5=El Gaucho,\n" +
    "6=El Divino Codino, 7=La Pulga, 8=Il Tulipano Nero, 9=El Ultimo 10, 10=El Mago de Zadar, 11=El Maestro.\n\n" +
    ((() => { const r = sanitizeRegoleAppreseForPrompt(cfg["REGOLE_APPRESE"]); return r ? "REGLAS APRENDIDAS — APLICAR SIEMPRE:\n" + r + "\n\n" : ""; })()) +
    (direccionPreDetectada
      ? "⚠️ DIRECCIÓN DETECTADA AUTOMÁTICAMENTE: el sistema ha identificado un tipo de vía\n" +
        "(calle, avenida, plaza, paseo, urb, etc.) o nombre de zona en el mensaje.\n" +
        "OBLIGATORIO — no negociable:\n" +
        "  1. tipo_consegna='DOMICILIO'\n" +
        "  2. Extrae la dirección completa en 'direccion' exactamente como la escribe el cliente.\n" +
        "     Incluye tipo de vía + nombre + número + piso/letra si los hay.\n" +
        "     Si no puedes extraerla con precisión → direccion='' pero tipo_consegna='DOMICILIO' igual.\n" +
        "  3. El campo 'nota' debe estar vacío o en ESPAÑOL. Nunca en italiano.\n\n"
      : "DETECCIÓN DOMICILIO — REGLAS:\n" +
        "tipo_consegna='DOMICILIO' si el mensaje contiene CUALQUIERA de estas señales:\n" +
        "VERBOS ENTREGA: llevar, lleváis, llevais, llevas, llevad, traer, traéis, traeis, traes,\n" +
        "  enviar, repartir, mandar — en cualquier forma: 'me lo llevas', 'me lo traes',\n" +
        "  'podéis traerlo', 'lo lleváis', 'nos lo lleváis', 'que me lo traigáis', etc.\n" +
        "PALABRAS CLAVE: 'a domicilio', 'a mi casa', 'en casa', 'mi dirección', 'a mi piso',\n" +
        "  'entrega', 'delivery', 'reparto', 'repartidor', 'para llevar a casa'.\n" +
        "Si NO menciona entrega → tipo_consegna='RITIRO', direccion=''\n" +
        "CRÍTICO: NO inventar direcciones. Si escribe 'domicilio' sin dirección → direccion=''\n\n") +
    "FORMATO OUTPUT (solo JSON):\n" +
    "{\"tipo\":\"ordine|domanda|misto|solo_ora|correccion|modifica_complessa|custom_pizza\"," +
    "\"items\":[{\"n\":\"nombre\",\"q\":1,\"p\":9.50,\"e\":\"emoji\",\"sub\":\"\"}]," +
    "\"nota\":\"\",\"hora\":\"\",\"conf\":95," +
    "\"tipo_consegna\":\"RITIRO\",\"direccion\":\"\"}\n\n" +
    "CAMPO sub CRÍTICO: SIEMPRE presente. Sin variación: sub=''. Con variación: rellenarlo.\n" +
    "Ejemplos: 'marinara sin ajo' -> sub='sin ajo' | 'diavola extra picante' -> sub='extra picante'\n\n" +
    "REGLA ANTI-INVENCIÓN — CRÍTICA:\n" +
    "Si el cliente pide una pizza que NO existe en el menú y NO tiene equivalencia explícita arriba\n" +
    "(ej: carbonara, quattro stagioni, fungi, napoli, calzone, hawaiana, bbq, etc.),\n" +
    "NO mapearla a otra pizza. Pon tipo=domanda, conf=0, items=[].\n" +
    "El bot responderá que no tenemos ese producto y mostrará el menú.";

  try {
    const testoNorm = testo.replace(/\s+/g, " ").trim();
    const raw = await chiamaClaude(systemPrompt, `MENSAJE: "${testoNorm}"`, cfg, 600);
    if (!raw) return { items: [], nota: "", hora: "", conf: 0, tipo: "errore" };
    const clean = raw.trim().replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    console.log(`[interpreta] regex=${direccionPreDetectada} claude_tc=${parsed.tipo_consegna} dir="${parsed.direccion}"`);
    const normalizedItems = (parsed.items || []).map(it => ({
      n: it.n || "", q: Number(it.q) || 1, p: Number(it.p) || 0,
      e: it.e || "", sub: (it.sub != null) ? String(it.sub) : ""
    }));
    const esDomicilio = direccionPreDetectada || parsed.tipo_consegna === "DOMICILIO";
    return {
      items: normalizedItems,
      nota: parsed.nota || "",
      hora: parsed.hora || "",
      conf: parsed.conf || 0,
      tipo: parsed.tipo || "ordine",
      correccion: parsed.tipo === "correccion",
      customPizza: parsed.tipo === "custom_pizza",
      tipo_consegna: esDomicilio ? "DOMICILIO" : "RITIRO",
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
    (threadCtx ? `\nCONVERSACIÓN:\n${threadCtx}\n` : "");
  return assicuraFirma(await chiamaClaude(systemPrompt, testo, cfg, 400));
}

async function generaConfermaOrdine(primo, items, totale, hora, cfg, clienteInfo, chatHistory, horaRichiesta, tipoConsegna, tempoGiro) {
  const costoConsegna = tipoConsegna === "DOMICILIO" ? COSTO_CONSEGNA : 0;
  const totaleFinale = totale + costoConsegna;

  const resumen = items.map(it => {
    let r = `${it.e || ""} ${it.q || 1}x ${it.n} — ${((Number(it.p) || 0) * (Number(it.q) || 1)).toFixed(2)}€`;
    if (it.sub) r += ` (${it.sub})`;
    return r;
  }).join("\n");

  const tieneBebida = items.some(i => isBevanda(i.n));
  const tieneDolce  = items.some(i => { const n = (i.n || "").toLowerCase(); return n.includes("tiramisu") || n.includes("tartufo") || n.includes("nutella"); });

  let upsellCtx = "";
  if (!tieneBebida && !tieneDolce) upsellCtx = "UPSELL OBLIGATORIO: sin bebida ni postre. Añade UNA pregunta sobre cerveza (Heineken, Estrella, Peroni) y postre (Tiramisú, Tartufo). Termina con: '👇 _Escríbenos aquí y lo añadimos al momento._'\n";
  else if (!tieneBebida) upsellCtx = "UPSELL OBLIGATORIO: sin bebida. Añade UNA pregunta sobre cerveza. Termina con CTA 👇.\n";
  else if (!tieneDolce) upsellCtx = "UPSELL OBLIGATORIO: sin postre. Añade UNA pregunta sobre Tiramisú o Tartufo. Termina con CTA 👇.\n";

  const oraCambioCtx = (horaRichiesta && horaRichiesta !== hora)
    ? `CAMBIO HORARIO: cliente pidió las ${horaRichiesta} pero el slot disponible es ${hora}. Menciónalo de forma cálida.\n` : "";
  const giaInConv = chatHistory?.length > 0;
  const convCtx = giaInConv ? "YA estáis en conversación. PROHIBIDO saludar — ve directo a confirmar.\n" : "";
  const clienteCtx = (clienteInfo?.total_pedidos > 0) ? `Cliente habitual: ${primo} (${clienteInfo.total_pedidos} visitas).\n` : "";

  const systemPrompt =
    "Eres el asistente WhatsApp de La Dieci, pizzería italiana en Roquetas de Mar.\n" +
    "IDIOMA: SIEMPRE español.\nTONO: Cálido, profesional, referencias reales (horno, pizzaiolo, masa).\n" +
    "❌ NUNCA: tío, hermano, ey, venga, chaval, argot de bar.\n\n" +
    oraCambioCtx + clienteCtx + convCtx + upsellCtx +
    (tipoConsegna === "DOMICILIO"
      ? `TAREA: Confirma el pedido a DOMICILIO de ${primo}.\nPEDIDO:\n${resumen}\n` +
        `*Subtotal: ${totale.toFixed(2)}€*\n*Envío: ${costoConsegna.toFixed(2)}€*\n*Total: ${totaleFinale.toFixed(2)}€*\n` +
        `*Entrega: ${hora}*` +
        (tempoGiro ? `\n*Tiempo estimado: ~${tempoGiro} min*` : "") + `\n\n` +
        "IMPORTANTE: es entrega a domicilio. Pago en efectivo al repartidor. Usa 'entrega', 'llevamos', NUNCA 'recogida' ni 'recoger'.\n"
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
  const horaMin = esEntrega ? "20:00" : "19:30";
  const systemPrompt =
    "Eres el asistente WhatsApp de La Dieci Pizzeria.\n" +
    "TONO: Simpático, cálido. IDIOMA: SIEMPRE ESPAÑOL.\n" +
    (clienteInfo?.total_pedidos > 0 ? `Cliente habitual con ${clienteInfo.total_pedidos} visitas.\n` : "") +
    (giaInConv ? "YA estáis en conversación. PROHIBIDO saludar. Sigue directamente.\n" : "") +
    `TAREA: El cliente '${primo}' ha pedido [${resumen}] pero falta la hora. Confirma los items y pide la hora. Máx 3-4 líneas.\n` +
    (esEntrega ? "Es un pedido a DOMICILIO — usa palabras como 'entrega', 'llevar', NO 'recoger' ni 'recogida'.\n" : "") +
    `HORARIO: ${esEntrega ? "entregas a domicilio" : "recogidas"} ${horaMin}-23:00 (miércoles a domingo).\nFIRMA: *El Bot La Dieci* 🇮🇹🍕`;
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

// geoSnapshot: { direccion?, direccion_note?, zona?, zona_lat?, zona_lon?, durata_andata_min?, geo_source? }
// Passato dal chiamante quando l'ordine è DOMICILIO. Fix 2026-05-14: prima i campi
// direccion/zona/lat/lon dei clienti restavano sempre null perché upsertCliente li ignorava
// — la cascata "cliente abituale → suo indirizzo" non poteva mai matchare.
async function upsertCliente(nombre, tel, items, geoSnapshot = null) {
  if (!nombre || !tel) return;
  const telNorm = String(tel).replace("+", "");
  const pizze = [], bevande = [];
  (items || []).forEach(it => { if (isBevanda(it.n)) bevande.push(it.n); else pizze.push(it.n); });

  const geoFields = {};
  if (geoSnapshot?.direccion) {
    geoFields.direccion = geoSnapshot.direccion;
    if (geoSnapshot.direccion_note != null) geoFields.direccion_note = geoSnapshot.direccion_note;
    if (geoSnapshot.zona) geoFields.zona = geoSnapshot.zona;
    if (geoSnapshot.zona_lat != null) geoFields.zona_lat = geoSnapshot.zona_lat;
    if (geoSnapshot.zona_lon != null) geoFields.zona_lon = geoSnapshot.zona_lon;
    if (geoSnapshot.durata_andata_min != null) geoFields.durata_andata_min = geoSnapshot.durata_andata_min;
    if (geoSnapshot.geo_source) geoFields.geo_source = geoSnapshot.geo_source;
    geoFields.geo_aggiornato_il = new Date().toISOString();
  }

  const existing = await getCliente(telNorm);
  if (existing) {
    await sbUpdate("clientes", `tel=eq.${telNorm}`, {
      nombre,
      total_pedidos: (existing.total_pedidos || 0) + 1,
      ultimo_pedido: new Date().toISOString(),
      ultimo_items: items || [],
      pizza_pref: pizze[0] || existing.pizza_pref || "",
      bevanda_pref: bevande[0] || existing.bevanda_pref || "",
      ...geoFields
    });
  } else {
    await sbUpsert("clientes", {
      tel: telNorm, nombre, total_pedidos: 1,
      ultimo_pedido: new Date().toISOString(),
      ultimo_items: items || [],
      pizza_pref: pizze[0] || "", bevanda_pref: bevande[0] || "",
      nota_fissa: "", orario_solito: "",
      ...geoFields
    }, "tel");
  }
}

function rilevaTonoCliente(testo) {
  if (!testo) return "informale";
  const t = testo.toLowerCase();
  return ["usted","podria","quisiera","por favor","disculpe"].some(k => t.includes(k)) ? "formale" : "informale";
}

module.exports = { interpreta, generaRisposta, generaConfermaOrdine, generaChiediOra, invia, getCliente, upsertCliente, preDetectaDireccion, sanitizeRegoleAppreseForPrompt };
