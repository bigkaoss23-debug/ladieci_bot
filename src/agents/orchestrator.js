// ===============================================================
// orchestrator.js — cervello centrale
// ===============================================================

const { sbSelect, sbUpdate, getConfig } = require("../utils/supabase");
const { appendChat, updateConvDati, createConv, upsertWaMsg, getConversazione,
        mergeItemsBevande, calcolaTotale, buildResumen, buildUpsell, buildMsgRicevuto } = require("../utils/helpers");
const { getStatoCliente, getCaricoForno } = require("./agentCucina");
const { interpreta, generaConfermaOrdine, generaChiediOra, invia, getCliente, upsertCliente } = require("./agentWhatsapp");
const { creaOrdine, modificaOrdine, aggiungiItems } = require("./agentOrdini");
const { NUMEROS_WHITELIST } = require("../config");
const { geocodificaEAssegnaZona } = require("../utils/zones");

// Wrapper difensivo: geocode non deve mai bloccare la creazione ordine
async function resolveZona(direccion, tipoConsegna) {
  if (tipoConsegna !== "DOMICILIO" || !direccion) return { zona: null, lat: null, lon: null };
  try {
    const r = await geocodificaEAssegnaZona(direccion);
    return { zona: r.zona?.id || null, lat: r.lat ?? null, lon: r.lon ?? null };
  } catch (e) {
    console.error("geocode error:", e?.message || e);
    return { zona: null, lat: null, lon: null };
  }
}

const SOGLIA_CONF = 85;

function isOraValida(hora) {
  if (!hora) return true;
  const [h, m] = String(hora).split(":").map(Number);
  const min = h * 60 + (m || 0);
  return min >= (19 * 60 + 30) && min <= 23 * 60;
}

function updateConvStato(waId, nuovoStato) {
  return sbUpdate("conv", `wa_id=eq.${waId}&stato_ordine=not.in.(ritirata,chiusa)`, { stato_ordine: nuovoStato, ts: Date.now() });
}

// Recupera tipo_consegna e direccion dalla cronologia chat (primo messaggio cliente con DOMICILIO)
function getDeliveryFromChat(chat) {
  const msgs = (chat || []).filter(m => m.da === "cliente" && m.ia?.tipo_consegna === "DOMICILIO");
  if (msgs.length > 0) {
    return { tipo_consegna: "DOMICILIO", direccion: msgs[0].ia?.direccion || "" };
  }
  return { tipo_consegna: "RITIRO", direccion: "" };
}

function upsertWaMsgOrdenRef(waId, ordenId) {
  return sbSelect("wa_msgs", `wa_id=eq.${waId}&stato=not.in.(COMPLETATO,COCINA)&order=ts.desc&limit=1`)
    .then(rows => { if (rows?.[0]) sbUpdate("wa_msgs", `id=eq.${rows[0].id}`, { ordine_ref: ordenId }); });
}

async function gestisci(ctx) {
  const { waId, nombre, testo, ia, config, statoOrd, caricoForno, isWhitelist, waMsgId } = ctx;
  let conv = ctx.conv;
  const primo = (nombre || "amigo").split(" ")[0];
  const tipo = ia.tipo || "ordine";
  const conf = ia.conf || 0;
  const hasItems = ia.items && ia.items.length > 0;
  const hasHora = ia.hora && ia.hora.length > 0;
  const autoOn = config["AUTO_RISPOSTA"] === "TRUE";

  await appendChat(waId, "cliente", testo, ia);
  if (!conv) conv = await getConversazione(waId);

  // --- MODIFICA COMPLESSA ---
  if (tipo === "modifica_complessa") {
    await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, conv ? (conv.items || []) : [], conv ? (conv.hora || "") : "", null, false, waMsgId);
    return { flusso: "modifica_complessa", stato: "IN_TRATTAMENTO" };
  }

  // --- FLUSSO 2B: aggiunta a ordine confermato ---
  if (!statoOrd.haOrdine && !isWhitelist && conv && conv.stato_ordine === "confermata" && hasItems && (tipo === "ordine" || tipo === "correccion")) {
    // Controlla messaggio duplicato — se identico all'ultimo del cliente → Preguntas
    const chatHistory = conv.chat || [];
    const ultimoCliente = chatHistory.filter(m => m.da === "cliente").slice(-2, -1)[0];
    if (ultimoCliente && ultimoCliente.txt.trim().toLowerCase() === testo.trim().toLowerCase()) {
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, conv.items || [], conv.hora || "", null, false, waMsgId);
      return { flusso: "2B", stato: "IN_TRATTAMENTO", motivo: "messaggio_duplicato" };
    }
    const convItems2B = conv.items || [];
    const hora2B = ia.hora || conv.hora || "";
    let merged2B;
    if (tipo === "correccion") {
      merged2B = convItems2B.map(i => ({ ...i }));
      ia.items.forEach(ni => {
        const idx = merged2B.findIndex(r => r.n === ni.n);
        if (idx >= 0) merged2B[idx].q = Number(ni.q) || 1;
        else merged2B.push(ni);
      });
    } else {
      merged2B = mergeItemsBevande(convItems2B, ia.items);
    }
    await updateConvDati(waId, merged2B, hora2B);
    const ordenRows2B = await sbSelect("ordenes", `wa_id=eq.${waId}&estado=eq.DA_CONFIRMARE&order=ts.desc&limit=1`);
    if (ordenRows2B?.length > 0) await modificaOrdine(ordenRows2B[0].id, { items: merged2B, hora: hora2B });
    const totaleMerged2B = calcolaTotale(merged2B);
    const forza2B = isWhitelist ? "STRONG" : (config["AI_FORZA"] || "BASIC");
    const limiti2B = forza2B === "STRONG" ? { maxQta: 20, maxEuro: 50 } : { maxQta: 3, maxEuro: 30 };
    const totQta2B = merged2B.reduce((s, it) => s + (Number(it.q) || 1), 0);
    if (totQta2B > limiti2B.maxQta || totaleMerged2B > limiti2B.maxEuro) {
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, merged2B, hora2B, null, false, waMsgId);
      return { flusso: "2B", stato: "IN_TRATTAMENTO", motivo: "limite_ai" };
    }
    const clienteInfo2B = await getCliente(waId);
    const msg2B = (await generaConfermaOrdine(primo, merged2B, totaleMerged2B, hora2B, config, clienteInfo2B, conv.chat || []))
               || buildMsgRicevuto(primo, merged2B, totaleMerged2B, hora2B);
    await appendChat(waId, "bot", msg2B);
    await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, merged2B, hora2B, msg2B, false, waMsgId);
    if (autoOn) await invia(waId, msg2B, config);
    return { flusso: "2B", stato: "NUEVO" };
  }

  // --- FLUSSO 2C: cambio orario ---
  if (!statoOrd.haOrdine && !isWhitelist && conv && conv.stato_ordine === "confermata" && !hasItems && hasHora && conf >= 80) {
    const hora2C = ia.hora;
    if (!isOraValida(hora2C)) {
      const msgOraInvalida = `Ey ${primo}! El horno arranca a las *19:30* y cierra a las *23:00*. ¿A qué hora te apunto?\n*La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgOraInvalida);
      if (autoOn) await invia(waId, msgOraInvalida, config);
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, conv.items || [], hora2C, msgOraInvalida, false, waMsgId);
      return { flusso: "2C", stato: "IN_TRATTAMENTO", motivo: "orario_invalido" };
    }
    const items2C = conv.items || [];
    const totale2C = calcolaTotale(items2C);
    const ordenRows2C = await sbSelect("ordenes", `wa_id=eq.${waId}&estado=eq.DA_CONFERMARE&order=ts.desc&limit=1`);
    if (!ordenRows2C?.length) {
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, items2C, hora2C, null, false, waMsgId);
      return { flusso: "2C", stato: "IN_TRATTAMENTO", motivo: "ordine_non_trovato" };
    }
    await modificaOrdine(ordenRows2C[0].id, { hora: hora2C });
    await updateConvDati(waId, items2C, hora2C);
    const msg2C = `${primo}, ¡cambiado sin problema! 🙌\n\n${buildResumen(items2C)}\n\n*Total: ${totale2C.toFixed(2)}€*\n*Recogida: ${hora2C}* ✅\n\nTe esperamos a las ${hora2C}. *La Dieci* 🇮🇹🍕`;
    await appendChat(waId, "bot", msg2C);
    if (autoOn) await invia(waId, msg2C, config);
    await upsertWaMsg(waId, nombre, testo, "COMPLETATO", conf, items2C, hora2C, msg2C, false, waMsgId);
    return { flusso: "2C", stato: "COMPLETATO" };
  }

  // --- FLUSSO 2: modifica ordine in cucina ---
  if (statoOrd.haOrdine) {
    const itemsConv = conv ? (conv.items || []) : statoOrd.items;
    const horaF2 = ia.hora || (conv ? conv.hora : statoOrd.hora) || "";
    const mergedItems = hasItems ? mergeItemsBevande(itemsConv, ia.items) : itemsConv;
    await updateConvDati(waId, mergedItems, horaF2);
    if (hasItems) await aggiungiItems(statoOrd.ordenId, ia.items);
    let msgF2 = null;
    if (autoOn) {
      const totF2 = calcolaTotale(mergedItems);
      msgF2 = `Anotado, ${primo}! Aquí el pedido actualizado:\n\n${buildResumen(mergedItems)}\n\n*Total: ${totF2.toFixed(2)}€*\n${horaF2 ? "*Recogida: " + horaF2 + "*\n" : ""}\nYa lo añadimos a tu pedido en cocina 👌\n*La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgF2);
      await invia(waId, msgF2, config);
    }
    await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, ia.items || [], horaF2, msgF2, false, waMsgId);
    return { flusso: 2, stato: "NUEVO", ordenId: statoOrd.ordenId };
  }

  // --- CUSTOM PIZZA ---
  if (tipo === "custom_pizza") {
    if (!conv) await createConv(waId, nombre, [], ia.hora || "", "aperta");
    await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, [], ia.hora || "", null, false, waMsgId);
    return { flusso: "custom", stato: "IN_TRATTAMENTO" };
  }

  // --- FLUSSO 1: ordine nuovo chiaro ---
  if (tipo === "ordine" && hasItems && conf >= SOGLIA_CONF) {
    const convItems = (conv && conv.stato_ordine === "aperta" && !conv.hora) ? (conv.items || []) : [];
    const allItems = convItems.length > 0 ? mergeItemsBevande(convItems, ia.items) : ia.items;
    const totale = calcolaTotale(allItems);
    const hora = ia.hora || "";

    if (!hora) {
      if (!conv) await createConv(waId, nombre, allItems, "", "aperta");
      else await updateConvDati(waId, allItems, "");
      const clienteInfoOra = await getCliente(waId);
      const msgOra = (await generaChiediOra(primo, allItems, config, clienteInfoOra, conv?.chat || [], ia.tipo_consegna))
                  || `${primo}, ya lo tenemos todo. ¿A qué hora te esperamos?\n*El Bot La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgOra);
      await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, allItems, "", msgOra, false, waMsgId);
      if (autoOn) await invia(waId, msgOra, config);
      return { flusso: 1, stato: "NUEVO", attesa: "ora" };
    }

    if (!isOraValida(hora)) {
      if (!conv) await createConv(waId, nombre, allItems, hora, "aperta");
      else await updateConvDati(waId, allItems, hora);
      const msgFuori = `Ey ${primo}!\n\n${buildResumen(allItems)}\n\nEl horno arranca a las *19:30* (miercoles a domingo).\n¿Para qué hora te apunto? (entre *19:30* y *23:00*)\n*El Bot La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgFuori);
      await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, allItems, hora, msgFuori, false, waMsgId);
      if (autoOn) await invia(waId, msgFuori, config);
      return { flusso: 1, stato: "NUEVO", attesa: "ora", motivo: "fuori_orario" };
    }

    let horaFinale = hora;
    let slotSpostato = false, oraCambiata = false;
    if (caricoForno?.slotAssegnato) {
      horaFinale = caricoForno.slotAssegnato;
      slotSpostato = horaFinale !== caricoForno.slotRichiesto;
      oraCambiata = horaFinale !== hora;
    }

    const forza = isWhitelist ? "STRONG" : (config["AI_FORZA"] || "BASIC");
    const limiti = forza === "STRONG" ? { maxQta: 20, maxEuro: 50 } : { maxQta: 3, maxEuro: 30 };
    const totQta = allItems.reduce((s, it) => s + (Number(it.q) || 1), 0);

    if (totQta > limiti.maxQta || totale > limiti.maxEuro) {
      if (!conv) await createConv(waId, nombre, allItems, horaFinale, "in_attesa");
      else { await updateConvDati(waId, allItems, horaFinale); await updateConvStato(waId, "in_attesa"); }
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, allItems, horaFinale, null, false, waMsgId);
      return { flusso: 3, stato: "IN_TRATTAMENTO", motivo: "limite_ai" };
    }

    // ═══ Delivery: estrai tipo_consegna e direccion dal risultato IA ═══
    const tipoConsegna = ia.tipo_consegna || "RITIRO";
    const direccion    = ia.direccion    || "";

    const clienteInfo1 = await getCliente(waId);
    let msgRicevuto;
    if (slotSpostato) {
      const slotMsgs = [
        `${primo}, el horno está a tope a las *${hora}* — te reservamos las *${horaFinale}*. 🔥\n\n${buildResumen(allItems)}\n\n*Total: ${totale.toFixed(2)}€* · *Recogida: ${horaFinale}*`,
        `Para las *${hora}* el horno ya vuela, ${primo}. Te apuntamos a las *${horaFinale}*, ¿perfecto? 🍕\n\n${buildResumen(allItems)}\n\n*Total: ${totale.toFixed(2)}€* · *Recogida: ${horaFinale}*`
      ];
      msgRicevuto = slotMsgs[Math.floor(Math.random() * slotMsgs.length)] + "\n\n" + buildUpsell(allItems) + "\n*La Dieci* 🇮🇹🍕";
    } else {
      msgRicevuto = (await generaConfermaOrdine(primo, allItems, totale, horaFinale, config, clienteInfo1, conv?.chat || [], oraCambiata ? hora : undefined, tipoConsegna))
                 || buildMsgRicevuto(primo, allItems, totale, horaFinale);
    }

    const zonaRes1 = await resolveZona(direccion, tipoConsegna);
    const ordResult1 = await creaOrdine({
      nombre, tel: waId, waId, canal: "WA",
      items: allItems, hora: horaFinale, estado: "DA_CONFERMARE",
      tipo_consegna: tipoConsegna,
      direccion: direccion || null,
      zona: zonaRes1.zona,
      zona_lat: zonaRes1.lat,
      zona_lon: zonaRes1.lon,
      zona_manuale: false
    });
    const numPedido1 = ordResult1?.id || "";

    if (numPedido1) {
      if (tipoConsegna === "DOMICILIO") {
        if (direccion) {
          // Ha dato indirizzo — conferma con info consegna
          msgRicevuto += `\n\nTu número de pedido: *${numPedido1}* 🛵\n📍 Entrega en: *${direccion}*`;
        } else {
          // Vuole domicilio ma non ha dato indirizzo — chiediamo
          msgRicevuto += `\n\nTu número de pedido: *${numPedido1}* 🛵\n\n¿Cuál es tu dirección de entrega? 📍`;
        }
      } else {
        msgRicevuto += `\n\nTu número de recogida: *${numPedido1}* 🎫\nCuando llegues, dínoslo y listo!`;
      }
    }

    if (!conv) await createConv(waId, nombre, allItems, horaFinale, "confermata");
    else { await updateConvDati(waId, allItems, horaFinale); await updateConvStato(waId, "confermata"); }

    await appendChat(waId, "bot", msgRicevuto);
    await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, allItems, horaFinale, msgRicevuto, false, waMsgId);
    if (numPedido1) {
      if (waMsgId) await sbUpdate("wa_msgs", `id=eq.${waMsgId}`, { ordine_ref: numPedido1 });
      else await upsertWaMsgOrdenRef(waId, numPedido1);
    }
    if (autoOn) await invia(waId, msgRicevuto, config);
    await upsertCliente(nombre, waId, allItems);
    return { flusso: 1, stato: "NUEVO", ordenId: numPedido1 };
  }

  // --- Conv aperta + solo ora: completa ordine ---
  if (conv && conv.items?.length > 0 && conv.stato_ordine !== "confermata" && conv.stato_ordine !== "in_attesa" && (tipo === "solo_ora" || (!hasItems && hasHora))) {
    const oraItems = conv.items;
    const oraTotale = calcolaTotale(oraItems);
    const oraHora = ia.hora;

    if (!isOraValida(oraHora)) {
      const msgFuori2 = `Ey ${primo}!\n\n${buildResumen(oraItems)}\n\nEl horno arranca a las *19:30* (miercoles a domingo).\n¿Para qué hora te apunto? (entre *19:30* y *23:00*)\n*El Bot La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgFuori2);
      await upsertWaMsg(waId, nombre, testo, "NUEVO", 95, oraItems, oraHora, msgFuori2, false, waMsgId);
      if (autoOn) await invia(waId, msgFuori2, config);
      return { flusso: 1, stato: "NUEVO", attesa: "ora", motivo: "fuori_orario" };
    }

    let oraHoraFinale = oraHora;
    let slotSpostatoOra = false, oraCambiataOra = false;
    if (caricoForno?.slotAssegnato) {
      oraHoraFinale = caricoForno.slotAssegnato;
      slotSpostatoOra = oraHoraFinale !== caricoForno.slotRichiesto;
      oraCambiataOra = oraHoraFinale !== oraHora;
    }

    const clienteInfoOra2 = await getCliente(waId);
    // ═══ Delivery: leggi tipo_consegna/direccion dalla cronologia conv ═══
    const { tipo_consegna: tipoConsegnaOra, direccion: direccionOra } = getDeliveryFromChat(conv.chat);

    let msgOraConf;
    if (slotSpostatoOra) {
      msgOraConf = `Ey ${primo}! 🙏\n\nEsta noche el horno vuela 🔥 Las *${oraHora}* ya están completas.\n¿Te va bien a las *${oraHoraFinale}*? ¡Te lo reservamos ahora mismo! ✅\n\n${buildResumen(oraItems)}\n\nTotal: *${oraTotale.toFixed(2)}eur*\n*El Bot La Dieci* 🇮🇹🍕`;
    } else {
      msgOraConf = (await generaConfermaOrdine(primo, oraItems, oraTotale, oraHoraFinale, config, clienteInfoOra2, conv?.chat || [], oraCambiataOra ? oraHora : undefined, tipoConsegnaOra))
                || buildMsgRicevuto(primo, oraItems, oraTotale, oraHoraFinale);
    }

    const zonaResOra = await resolveZona(direccionOra, tipoConsegnaOra);
    const ordResultOra = await creaOrdine({
      nombre, tel: waId, waId, canal: "WA",
      items: oraItems, hora: oraHoraFinale, estado: "DA_CONFERMARE",
      tipo_consegna: tipoConsegnaOra,
      direccion: direccionOra || null,
      zona: zonaResOra.zona,
      zona_lat: zonaResOra.lat,
      zona_lon: zonaResOra.lon,
      zona_manuale: false
    });
    const numPedidoOra = ordResultOra?.id || "";
    if (numPedidoOra) {
      if (tipoConsegnaOra === "DOMICILIO") {
        if (direccionOra) {
          msgOraConf += `\n\nTu número de pedido: *${numPedidoOra}* 🛵\n📍 Entrega en: *${direccionOra}*`;
        } else {
          msgOraConf += `\n\nTu número de pedido: *${numPedidoOra}* 🛵\n\n¿Cuál es tu dirección de entrega? 📍`;
        }
      } else {
        msgOraConf += `\n\nTu número de recogida: *${numPedidoOra}* 🎫\nCuando llegues, dínoslo y listo!`;
      }
    }

    await updateConvDati(waId, oraItems, oraHoraFinale);
    await updateConvStato(waId, "confermata");
    await appendChat(waId, "bot", msgOraConf);
    await upsertWaMsg(waId, nombre, testo, "NUEVO", 95, oraItems, oraHoraFinale, msgOraConf, false, waMsgId);
    if (numPedidoOra) {
      if (waMsgId) await sbUpdate("wa_msgs", `id=eq.${waMsgId}`, { ordine_ref: numPedidoOra });
      else await upsertWaMsgOrdenRef(waId, numPedidoOra);
    }
    if (autoOn) await invia(waId, msgOraConf, config);
    await upsertCliente(nombre, waId, oraItems);
    return { flusso: 1, stato: "NUEVO", ordenId: numPedidoOra };
  }

  // --- Conv aperta + nuovi items senza ora ---
  if (conv && hasItems && !hasHora && tipo === "ordine" && conv.stato_ordine === "aperta") {
    const mergedUpd = mergeItemsBevande(conv.items || [], ia.items);
    await updateConvDati(waId, mergedUpd, "");
    const clienteInfoUpd = await getCliente(waId);
    const msgUpd = (await generaChiediOra(primo, mergedUpd, config, clienteInfoUpd, conv?.chat || []))
                || `${primo}, ya lo tenemos todo. ¿A qué hora te esperamos?\n*El Bot La Dieci* 🇮🇹🍕`;
    await appendChat(waId, "bot", msgUpd);
    await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, mergedUpd, "", msgUpd, false, waMsgId);
    if (autoOn) await invia(waId, msgUpd, config);
    return { flusso: 1, stato: "NUEVO", attesa: "ora" };
  }

  // --- FLUSSO 3: domanda / ambiguo ---
  if (!conv) await createConv(waId, nombre, ia.items || [], ia.hora || "", "aperta");
  else if (hasItems) await updateConvDati(waId, mergeItemsBevande(conv.items || [], ia.items), ia.hora || conv.hora || "");
  await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, ia.items || [], ia.hora || "", null, false, waMsgId);
  return { flusso: 3, stato: "IN_TRATTAMENTO" };
}

async function processWebhook(body) {
  try {
    const config = await getConfig();
    const entries = body.entry;
    if (!entries?.length) return { status: "no_entry" };

    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value;
        if (!value.messages?.length) continue;

        for (const msg of value.messages) {
          if (msg.type !== "text") continue;
          const text = msg.text.body;
          const contactObj = value.contacts?.[0];
          const waId = contactObj?.wa_id || msg.from;
          const nombre = contactObj?.profile?.name || "Cliente";

          const isWhitelist = NUMEROS_WHITELIST.includes(waId);

          // Dedup (skip per whitelist)
          if (!isWhitelist) {
            const dedupRows = await sbSelect("wa_msgs", `wa_id=eq.${waId}&stato=not.in.(COMPLETATO,COCINA)&order=ts.desc&limit=1`);
            if (dedupRows?.[0] && dedupRows[0].txt === text && (Date.now() - Number(dedupRows[0].ts || 0)) < 30000) continue;
          }

          let statoOrd = isWhitelist ? { haOrdine: false } : await getStatoCliente(waId);
          let conv = await getConversazione(waId);

          const prelimResult = await upsertWaMsg(waId, nombre, text,
            statoOrd.haOrdine ? "IN_TRATTAMENTO" : "NUEVO",
            0, conv?.items || [], conv?.hora || "", "", isWhitelist);
          const waMsgId = (isWhitelist && prelimResult?.id) ? prelimResult.id : null;

          const clienteInfo = isWhitelist ? null : await getCliente(waId);
          const ia = await interpreta(text, config, clienteInfo, conv?.chat || []);

          // Whitelist: reset conv
          if (isWhitelist) {
            const convEsistente = await getConversazione(waId);
            const chatRecente = (convEsistente?.chat?.length > 0) ? convEsistente.chat.slice(-2) : [];
            await sbUpdate("conv", `wa_id=eq.${waId}`, { stato_ordine: "aperta", chat: chatRecente, items: [], hora: "", ts: Date.now() });
            conv = null;
          }

          let caricoForno = null;
          if (!statoOrd.haOrdine && ia.hora) {
            caricoForno = await getCaricoForno(ia.hora);
          }

          const risultato = await gestisci({ waId, nombre, testo: text, ia, config, conv, statoOrd, caricoForno, isWhitelist, waMsgId });
          console.log("ORCH:", JSON.stringify(risultato));
        }
      }
    }
    return { status: "ok" };
  } catch (err) {
    console.error("webhook error:", err);
    return { error: err.message };
  }
}

module.exports = { processWebhook, gestisci };
