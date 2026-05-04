// ===============================================================
// orchestrator.js — cervello centrale
// ===============================================================

const { sbSelect, sbUpdate, getConfig } = require("../utils/supabase");
const { appendChat, updateConvDati, createConv, upsertWaMsg, getConversazione,
        mergeItemsBevande, calcolaTotale, buildResumen, buildUpsell, buildMsgRicevuto } = require("../utils/helpers");
const { getStatoCliente, getCaricoForno, getCaricoDelivery } = require("./agentCucina");
const { interpreta, generaRisposta, generaConfermaOrdine, generaChiediOra, invia, getCliente, upsertCliente, preDetectaDireccion } = require("./agentWhatsapp");
const { creaOrdine, modificaOrdine, aggiungiItems } = require("./agentOrdini");
const { NUMEROS_WHITELIST, COSTO_CONSEGNA } = require("../config");
const { geocodificaEAssegnaZona, ZONE_DELIVERY } = require("../utils/zones");

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

function isOraValida(hora, tipoConsegna) {
  if (!hora) return true;
  const [h, m] = String(hora).split(":").map(Number);
  const min = h * 60 + (m || 0);
  const minMin = tipoConsegna === "DOMICILIO" ? (20 * 60) : (19 * 60 + 30);
  return min >= minMin && min <= 23 * 60;
}

function updateConvStato(waId, nuovoStato) {
  return sbUpdate("conv", `wa_id=eq.${waId}&stato_ordine=not.in.(ritirata,chiusa)`, { stato_ordine: nuovoStato, ts: Date.now() });
}

function getDeliveryFromChat(chat) {
  const msgs = (chat || []).filter(m => m.da === "cliente" && m.ia?.tipo_consegna === "DOMICILIO");
  if (msgs.length > 0) {
    return { tipo_consegna: "DOMICILIO", direccion: msgs[0].ia?.direccion || "" };
  }
  return { tipo_consegna: "RITIRO", direccion: "" };
}

function upsertWaMsgOrdenRef(waId, ordenId) {
  return sbSelect("wa_msgs", `wa_id=eq.${waId}&stato=not.in.(COMPLETATO,COCINA)&order=ts.desc&limit=1`)
    .then(rows => { if (rows?.[0]) return sbUpdate("wa_msgs", `id=eq.${rows[0].id}`, { ordine_ref: ordenId }); });
}

function msgFueraHorario(primo, items, tipoConsegna) {
  const horaMin = tipoConsegna === "DOMICILIO" ? "20:00" : "19:30";
  const modo = tipoConsegna === "DOMICILIO" ? "Los repartos a domicilio" : "El horno";
  const verbo = tipoConsegna === "DOMICILIO" ? "arrancan" : "arranca";
  return `Ey ${primo}!\n\n${buildResumen(items)}\n\n¡Casi! ${modo} ${verbo} a las *${horaMin}* (miércoles a domingo). ¿Para qué hora lo apunto? (entre *${horaMin}* y *23:00*)\n*El Bot La Dieci* 🇮🇹🍕`;
}

// Genera messaggio slot-spostato per il caso delivery (zona piena o driver in giro)
function msgSlotDelivery(primo, allItems, totaleConConsegna, horaOriginal, horaFinale, driverInGiro) {
  const motivo = driverInGiro
    ? `nuestro repartidor está ahora mismo en tu zona. Te apuntamos para las *${horaFinale}* cuando pueda recogerte el pedido`
    : `ese horario está completo en tu zona — te reservamos las *${horaFinale}*`;
  return `${primo}, ${motivo}. 🛵\n\n${buildResumen(allItems)}\n\n*Total: ${totaleConConsegna.toFixed(2)}€* · *Entrega: ${horaFinale}*\n\n${buildUpsell(allItems)}\n*La Dieci* 🇮🇹🍕`;
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
    const { tipo_consegna: tc2B } = getDeliveryFromChat(conv.chat || []);
    const msg2B = (await generaConfermaOrdine(primo, merged2B, totaleMerged2B, hora2B, config, clienteInfo2B, conv.chat || [], undefined, tc2B))
               || buildMsgRicevuto(primo, merged2B, totaleMerged2B, hora2B, tc2B, tc2B === "DOMICILIO" ? COSTO_CONSEGNA : 0);
    await appendChat(waId, "bot", msg2B);
    await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, merged2B, hora2B, msg2B, false, waMsgId);
    if (autoOn) await invia(waId, msg2B, config);
    return { flusso: "2B", stato: "NUEVO" };
  }

  // --- FLUSSO 2C: cambio orario ---
  if (!statoOrd.haOrdine && !isWhitelist && conv && conv.stato_ordine === "confermata" && !hasItems && hasHora && conf >= 80) {
    const hora2C = ia.hora;
    const { tipo_consegna: tc2C } = getDeliveryFromChat(conv.chat || []);
    if (!isOraValida(hora2C, tc2C)) {
      const horaMin2C = tc2C === "DOMICILIO" ? "20:00" : "19:30";
      const msgOraInvalida = `Ey ${primo}! ${tc2C === "DOMICILIO" ? "Los repartos a domicilio empiezan" : "El horno arranca"} a las *${horaMin2C}* y cierra a las *23:00*. ¿A qué hora lo apunto?\n*La Dieci* 🇮🇹🍕`;
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
    const costoC2C = tc2C === "DOMICILIO" ? COSTO_CONSEGNA : 0;
    const totaleFinale2C = totale2C + costoC2C;
    const label2C = tc2C === "DOMICILIO" ? "Entrega" : "Recogida";
    const msg2C = `${primo}, ¡cambiado sin problema! 🙌\n\n${buildResumen(items2C)}\n\n*Total: ${totaleFinale2C.toFixed(2)}€*\n*${label2C}: ${hora2C}* ✅\n\nTe esperamos a las ${hora2C}. *La Dieci* 🇮🇹🍕`;
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
      const labelF2 = getDeliveryFromChat(conv?.chat || []).tipo_consegna === "DOMICILIO" ? "Entrega" : "Recogida";
      msgF2 = `Anotado, ${primo}! Aquí el pedido actualizado:\n\n${buildResumen(mergedItems)}\n\n*Total: ${totF2.toFixed(2)}€*\n${horaF2 ? `*${labelF2}: ${horaF2}*\n` : ""}Ya lo añadimos a tu pedido en cocina 👌\n*La Dieci* 🇮🇹🍕`;
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

  // ═══════════════════════════════════════════════════════════
  // FLUSSO 1: ordine nuovo chiaro
  // ═══════════════════════════════════════════════════════════
  if (tipo === "ordine" && hasItems && conf >= SOGLIA_CONF) {
    const convItems = (conv && conv.stato_ordine === "aperta" && !conv.hora) ? (conv.items || []) : [];
    const allItems = convItems.length > 0 ? mergeItemsBevande(convItems, ia.items) : ia.items;
    const totale = calcolaTotale(allItems);
    const hora = ia.hora || "";
    const tipoConsegna = (ia.tipo_consegna === "DOMICILIO" || preDetectaDireccion(testo)) ? "DOMICILIO" : "RITIRO";
    const direccion    = ia.direccion    || "";

    // Manca l'orario — chiedi
    if (!hora) {
      if (!conv) await createConv(waId, nombre, allItems, "", "aperta");
      else await updateConvDati(waId, allItems, "");
      const clienteInfoOra = await getCliente(waId);
      const msgOra = (await generaChiediOra(primo, allItems, config, clienteInfoOra, conv?.chat || [], tipoConsegna))
                  || `${primo}, ya lo tenemos todo. ¿A qué hora te esperamos?\n*El Bot La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgOra);
      await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, allItems, "", msgOra, false, waMsgId);
      if (autoOn) await invia(waId, msgOra, config);
      return { flusso: 1, stato: "NUEVO", attesa: "ora" };
    }

    // Orario fuori fascia
    if (!isOraValida(hora, tipoConsegna)) {
      if (!conv) await createConv(waId, nombre, allItems, hora, "aperta");
      else await updateConvDati(waId, allItems, hora);
      const msgFuori = msgFueraHorario(primo, allItems, tipoConsegna);
      await appendChat(waId, "bot", msgFuori);
      await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, allItems, hora, msgFuori, false, waMsgId);
      if (autoOn) await invia(waId, msgFuori, config);
      return { flusso: 1, stato: "NUEVO", attesa: "ora", motivo: "fuori_orario" };
    }

    // Forno al completo
    if (caricoForno?.fornoCompleto) {
      if (!conv) await createConv(waId, nombre, allItems, hora, "aperta");
      else await updateConvDati(waId, allItems, hora);
      const msgCompleto = `¡Ey ${primo}! Esta noche el horno está lleno 🔥🍕\n\nNo nos quedan huecos para esta noche. ¡Escríbenos mañana!\n*La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgCompleto);
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, allItems, hora, msgCompleto, false, waMsgId);
      if (autoOn) await invia(waId, msgCompleto, config);
      return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "forno_completo" };
    }

    // Slot forno
    let horaFinale = hora;
    let slotSpostato = false, oraCambiata = false;
    if (caricoForno?.slotAssegnato) {
      horaFinale = caricoForno.slotAssegnato;
      slotSpostato = horaFinale !== caricoForno.slotRichiesto;
      oraCambiata = horaFinale !== hora;
    }

    // Limite AI
    const forza = isWhitelist ? "STRONG" : (config["AI_FORZA"] || "BASIC");
    const limiti = forza === "STRONG" ? { maxQta: 20, maxEuro: 50 } : { maxQta: 3, maxEuro: 30 };
    const totQta = allItems.reduce((s, it) => s + (Number(it.q) || 1), 0);
    if (totQta > limiti.maxQta || totale > limiti.maxEuro) {
      if (!conv) await createConv(waId, nombre, allItems, horaFinale, "in_attesa");
      else { await updateConvDati(waId, allItems, horaFinale); await updateConvStato(waId, "in_attesa"); }
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, allItems, horaFinale, null, false, waMsgId);
      return { flusso: 3, stato: "IN_TRATTAMENTO", motivo: "limite_ai" };
    }

    // ── Domicilio senza indirizzo → Preguntas (operatore chiede dove) ─
    if (tipoConsegna === "DOMICILIO" && !direccion) {
      if (!conv) await createConv(waId, nombre, allItems, horaFinale, "aperta");
      else await updateConvDati(waId, allItems, horaFinale);
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, allItems, horaFinale, null, false, waMsgId);
      return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "sin_direccion" };
    }

    // ── Geocoding zona (sempre prima del messaggio) ──────────────
    const zonaRes1 = await resolveZona(direccion, tipoConsegna);
    const zonaObj1 = tipoConsegna === "DOMICILIO" ? ZONE_DELIVERY.find(z => z.id === zonaRes1.zona) : null;
    const fueraDeZona = tipoConsegna === "DOMICILIO" && direccion && !zonaRes1.zona;

    // Fuori zona → operatore silente (appare in giallo "Sin zona" in TabEntregas)
    if (fueraDeZona) {
      await creaOrdine({
        nombre, tel: waId, waId, canal: "WA",
        items: allItems, hora: horaFinale, estado: "DA_CONFIRMARE",
        tipo_consegna: tipoConsegna, direccion: direccion || null,
        zona: null, zona_lat: null, zona_lon: null, zona_manuale: false
      });
      if (!conv) await createConv(waId, nombre, allItems, horaFinale, "in_attesa");
      else { await updateConvDati(waId, allItems, horaFinale); await updateConvStato(waId, "in_attesa"); }
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, allItems, horaFinale, null, false, waMsgId);
      return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "fuera_de_zona" };
    }

    // ── Check capacità giri delivery ─────────────────────────────
    let caricoDelivery1 = null;
    if (tipoConsegna === "DOMICILIO" && zonaRes1.zona) {
      caricoDelivery1 = await getCaricoDelivery(zonaRes1.zona, horaFinale);

      if (caricoDelivery1.zonaCompleta) {
        if (!conv) await createConv(waId, nombre, allItems, horaFinale, "aperta");
        else await updateConvDati(waId, allItems, horaFinale);
        const msgZonaFull = `¡Ey ${primo}! Esta noche los repartos para tu zona están completos 🛵🍕\n\nNo nos quedan huecos de entrega. ¡Escríbenos mañana!\n*La Dieci* 🇮🇹🍕`;
        await appendChat(waId, "bot", msgZonaFull);
        await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", conf, allItems, horaFinale, msgZonaFull, false, waMsgId);
        if (autoOn) await invia(waId, msgZonaFull, config);
        return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "delivery_completo" };
      }

      // Slot delivery diverso da slot forno → aggiusta horaFinale
      if (caricoDelivery1.slotAssegnato && caricoDelivery1.slotAssegnato !== horaFinale) {
        slotSpostato = true;
        oraCambiata  = true;
        horaFinale   = caricoDelivery1.slotAssegnato;
      }
    }

    // ── Generazione messaggio ────────────────────────────────────
    const tempoGiro1  = zonaObj1?.tempoGiro ?? null;
    const costoConse1 = tipoConsegna === "DOMICILIO" ? COSTO_CONSEGNA : 0;
    const totaleConConsegna1 = totale + costoConse1;
    const labelOra1   = tipoConsegna === "DOMICILIO" ? "Entrega" : "Recogida";
    const clienteInfo1 = await getCliente(waId);

    let msgRicevuto;
    if (slotSpostato) {
      if (tipoConsegna === "DOMICILIO") {
        msgRicevuto = msgSlotDelivery(primo, allItems, totaleConConsegna1, hora, horaFinale, caricoDelivery1?.driverInGiro);
      } else {
        const slotMsgs = [
          `${primo}, el horno está a tope a las *${hora}* — te reservamos las *${horaFinale}*. 🔥\n\n${buildResumen(allItems)}\n\n*Total: ${totaleConConsegna1.toFixed(2)}€* · *${labelOra1}: ${horaFinale}*`,
          `Para las *${hora}* el horno ya vuela, ${primo}. Te apuntamos a las *${horaFinale}*, ¿perfecto? 🍕\n\n${buildResumen(allItems)}\n\n*Total: ${totaleConConsegna1.toFixed(2)}€* · *${labelOra1}: ${horaFinale}*`
        ];
        msgRicevuto = slotMsgs[Math.floor(Math.random() * slotMsgs.length)] + "\n\n" + buildUpsell(allItems) + "\n*La Dieci* 🇮🇹🍕";
      }
    } else {
      msgRicevuto = (await generaConfermaOrdine(primo, allItems, totale, horaFinale, config, clienteInfo1, conv?.chat || [], oraCambiata ? hora : undefined, tipoConsegna, tempoGiro1))
                 || buildMsgRicevuto(primo, allItems, totale, horaFinale, tipoConsegna, costoConse1);
    }

    // Crea ordine in Supabase
    const ordResult1 = await creaOrdine({
      nombre, tel: waId, waId, canal: "WA",
      items: allItems, hora: horaFinale, estado: "DA_CONFIRMARE",
      tipo_consegna: tipoConsegna, direccion: direccion || null,
      zona: zonaRes1.zona, zona_lat: zonaRes1.lat, zona_lon: zonaRes1.lon, zona_manuale: false
    });
    const numPedido1 = ordResult1?.id || "";

    if (numPedido1) {
      if (tipoConsegna === "DOMICILIO") {
        if (direccion) {
          const tiempoStr = tempoGiro1 ? ` (~${tempoGiro1} min)` : "";
          msgRicevuto += `\n\nTu número de pedido: *${numPedido1}* 🛵\n📍 Entrega en: *${direccion}*${tiempoStr}`;
        } else {
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

  // ═══════════════════════════════════════════════════════════
  // FLUSSO 1 — solo orario: conv aperta + arriva l'ora
  // ═══════════════════════════════════════════════════════════
  if (conv && conv.items?.length > 0 && conv.stato_ordine !== "confermata" && conv.stato_ordine !== "in_attesa" && (tipo === "solo_ora" || (!hasItems && hasHora))) {
    const oraItems = conv.items;
    const oraTotale = calcolaTotale(oraItems);
    const oraHora = ia.hora;
    const { tipo_consegna: tipoConsegnaOra, direccion: direccionOra } = getDeliveryFromChat(conv.chat);

    if (!isOraValida(oraHora, tipoConsegnaOra)) {
      const msgFuori2 = msgFueraHorario(primo, oraItems, tipoConsegnaOra);
      await appendChat(waId, "bot", msgFuori2);
      await upsertWaMsg(waId, nombre, testo, "NUEVO", 95, oraItems, oraHora, msgFuori2, false, waMsgId);
      if (autoOn) await invia(waId, msgFuori2, config);
      return { flusso: 1, stato: "NUEVO", attesa: "ora", motivo: "fuori_orario" };
    }

    if (caricoForno?.fornoCompleto) {
      await updateConvDati(waId, oraItems, oraHora);
      const msgCompletoOra = `¡Ey ${primo}! Esta noche el horno está lleno 🔥🍕\n\nNo nos quedan huecos para esta noche. ¡Escríbenos mañana!\n*La Dieci* 🇮🇹🍕`;
      await appendChat(waId, "bot", msgCompletoOra);
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", 95, oraItems, oraHora, msgCompletoOra, false, waMsgId);
      if (autoOn) await invia(waId, msgCompletoOra, config);
      return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "forno_completo" };
    }

    let oraHoraFinale = oraHora;
    let slotSpostatoOra = false, oraCambiataOra = false;
    if (caricoForno?.slotAssegnato) {
      oraHoraFinale = caricoForno.slotAssegnato;
      slotSpostatoOra = oraHoraFinale !== caricoForno.slotRichiesto;
      oraCambiataOra  = oraHoraFinale !== oraHora;
    }

    // ── Domicilio senza indirizzo → Preguntas ───────────────────
    if (tipoConsegnaOra === "DOMICILIO" && !direccionOra) {
      await updateConvDati(waId, oraItems, oraHoraFinale);
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", 95, oraItems, oraHoraFinale, null, false, waMsgId);
      return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "sin_direccion" };
    }

    // ── Geocoding zona ───────────────────────────────────────────
    const zonaResOra = await resolveZona(direccionOra, tipoConsegnaOra);
    const zonaObjOra = tipoConsegnaOra === "DOMICILIO" ? ZONE_DELIVERY.find(z => z.id === zonaResOra.zona) : null;
    const fueraDeZonaOra = tipoConsegnaOra === "DOMICILIO" && direccionOra && !zonaResOra.zona;

    if (fueraDeZonaOra) {
      await creaOrdine({
        nombre, tel: waId, waId, canal: "WA",
        items: oraItems, hora: oraHoraFinale, estado: "DA_CONFIRMARE",
        tipo_consegna: tipoConsegnaOra, direccion: direccionOra || null,
        zona: null, zona_lat: null, zona_lon: null, zona_manuale: false
      });
      await updateConvDati(waId, oraItems, oraHoraFinale);
      await updateConvStato(waId, "in_attesa");
      await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", 95, oraItems, oraHoraFinale, null, false, waMsgId);
      return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "fuera_de_zona" };
    }

    // ── Check capacità giri delivery ─────────────────────────────
    let caricoDeliveryOra = null;
    if (tipoConsegnaOra === "DOMICILIO" && zonaResOra.zona) {
      caricoDeliveryOra = await getCaricoDelivery(zonaResOra.zona, oraHoraFinale);

      if (caricoDeliveryOra.zonaCompleta) {
        await updateConvDati(waId, oraItems, oraHoraFinale);
        const msgZonaFullOra = `¡Ey ${primo}! Esta noche los repartos para tu zona están completos 🛵🍕\n\nNo nos quedan huecos de entrega. ¡Escríbenos mañana!\n*La Dieci* 🇮🇹🍕`;
        await appendChat(waId, "bot", msgZonaFullOra);
        await upsertWaMsg(waId, nombre, testo, "IN_TRATTAMENTO", 95, oraItems, oraHoraFinale, msgZonaFullOra, false, waMsgId);
        if (autoOn) await invia(waId, msgZonaFullOra, config);
        return { flusso: 1, stato: "IN_TRATTAMENTO", motivo: "delivery_completo" };
      }

      if (caricoDeliveryOra.slotAssegnato && caricoDeliveryOra.slotAssegnato !== oraHoraFinale) {
        slotSpostatoOra = true;
        oraCambiataOra  = true;
        oraHoraFinale   = caricoDeliveryOra.slotAssegnato;
      }
    }

    // ── Generazione messaggio ────────────────────────────────────
    const tempoGiroOra   = zonaObjOra?.tempoGiro ?? null;
    const costoConseOra  = tipoConsegnaOra === "DOMICILIO" ? COSTO_CONSEGNA : 0;
    const totaleConConsegnaOra = oraTotale + costoConseOra;
    const clienteInfoOra2 = await getCliente(waId);

    let msgOraConf;
    if (slotSpostatoOra) {
      if (tipoConsegnaOra === "DOMICILIO") {
        msgOraConf = msgSlotDelivery(primo, oraItems, totaleConConsegnaOra, oraHora, oraHoraFinale, caricoDeliveryOra?.driverInGiro);
      } else {
        msgOraConf = `Ey ${primo}! 🙏\n\nEsta noche el horno vuela 🔥 Las *${oraHora}* ya están completas.\n¿Te va bien a las *${oraHoraFinale}*? ¡Te lo reservamos ahora mismo! ✅\n\n${buildResumen(oraItems)}\n\nTotal: *${totaleConConsegnaOra.toFixed(2)}€*\n*El Bot La Dieci* 🇮🇹🍕`;
      }
    } else {
      msgOraConf = (await generaConfermaOrdine(primo, oraItems, oraTotale, oraHoraFinale, config, clienteInfoOra2, conv?.chat || [], oraCambiataOra ? oraHora : undefined, tipoConsegnaOra, tempoGiroOra))
                || buildMsgRicevuto(primo, oraItems, oraTotale, oraHoraFinale, tipoConsegnaOra, costoConseOra);
    }

    const ordResultOra = await creaOrdine({
      nombre, tel: waId, waId, canal: "WA",
      items: oraItems, hora: oraHoraFinale, estado: "DA_CONFIRMARE",
      tipo_consegna: tipoConsegnaOra, direccion: direccionOra || null,
      zona: zonaResOra.zona, zona_lat: zonaResOra.lat, zona_lon: zonaResOra.lon, zona_manuale: false
    });
    const numPedidoOra = ordResultOra?.id || "";

    if (numPedidoOra) {
      if (tipoConsegnaOra === "DOMICILIO") {
        if (direccionOra) {
          const tiempoStrOra = tempoGiroOra ? ` (~${tempoGiroOra} min)` : "";
          msgOraConf += `\n\nTu número de pedido: *${numPedidoOra}* 🛵\n📍 Entrega en: *${direccionOra}*${tiempoStrOra}`;
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
    const tcUpd = ia.tipo_consegna || "RITIRO";
    const msgUpd = (await generaChiediOra(primo, mergedUpd, config, clienteInfoUpd, conv?.chat || [], tcUpd))
                || `${primo}, ya lo tenemos todo. ¿A qué hora te esperamos?\n*El Bot La Dieci* 🇮🇹🍕`;
    await appendChat(waId, "bot", msgUpd);
    await upsertWaMsg(waId, nombre, testo, "NUEVO", conf, mergedUpd, "", msgUpd, false, waMsgId);
    if (autoOn) await invia(waId, msgUpd, config);
    return { flusso: 1, stato: "NUEVO", attesa: "ora" };
  }

  // --- FLUSSO 3: domanda / ambiguo ---
  if (!conv) await createConv(waId, nombre, ia.items || [], ia.hora || "", "aperta");
  else if (hasItems) await updateConvDati(waId, mergeItemsBevande(conv.items || [], ia.items), ia.hora || conv.hora || "");

  // Risposta automatica per domande (horarios, delivery, menú, allergie, ecc.)
  // generaRisposta usa INFO_RISTORANTE che include orari, delivery, costo envío, ecc.
  if (autoOn && (tipo === "domanda" || tipo === "misto")) {
    try {
      const chatRecente = conv ? (conv.chat || []).slice(-6) : [];
      const threadCtx = chatRecente.map(m => (m.da === "cliente" ? "C" : "B") + ": " + m.txt).join("\n");
      const msgRisposta = await generaRisposta(testo, waId, config, threadCtx);
      if (msgRisposta) {
        await appendChat(waId, "bot", msgRisposta);
        await invia(waId, msgRisposta, config);
        await upsertWaMsg(waId, nombre, testo, "COMPLETATO", conf, ia.items || [], ia.hora || "", msgRisposta, false, waMsgId);
        return { flusso: 3, stato: "COMPLETATO" };
      }
    } catch (e) {
      console.error("[flusso3] generaRisposta error:", e.message);
    }
  }

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
