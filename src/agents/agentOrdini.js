// ===============================================================
// agentOrdini.js — CRUD ordini. Solo questo. Mai in cucina.
// ===============================================================

const { sbSelect, sbUpsert, sbUpdate, sbDelete } = require("../utils/supabase");
const { mergeItemsBevande } = require("../utils/helpers");

async function creaOrdine(params) {
  // Usa il timestamp dell'ultimo chiudiServizio come punto di reset del contatore.
  // Se non esiste, fallback a mezzanotte di oggi.
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const resetCfg = await sbSelect("config", "chiave=eq.ORDER_RESET_TS");
  const resetTs  = resetCfg?.[0]?.valore ? parseInt(resetCfg[0].valore) : 0;
  const fromTs   = Math.max(startOfDay.getTime(), resetTs);
  const last = await sbSelect("ordenes", `ts=gte.${fromTs}&order=ts.desc&limit=50`);
  const lastNum = (last && Array.isArray(last))
    ? Math.max(0, ...last.map(o => parseInt((o.id || "").replace(/[^0-9]/g, "")) || 0))
    : 0;

  // ═══ Sovrprezzo consegna 2.50€ — aggiunto automaticamente per DOMICILIO ═══
  const COSTO_CONSEGNA = { n: "Entrega a domicilio", p: 2.50, q: 1, e: "🛵", sub: "" };
  let itemsFinali = params.items || [];
  if ((params.tipo_consegna || "RITIRO") === "DOMICILIO") {
    const giàPresente = itemsFinali.some(i => i.n === COSTO_CONSEGNA.n);
    if (!giàPresente) itemsFinali = [...itemsFinali, COSTO_CONSEGNA];
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const newId = "#" + String(lastNum + 1 + attempt).padStart(3, "0");
    const result = await sbUpsert("ordenes", {
      id: newId,
      nombre: params.nombre || "",
      tel: params.tel || "",
      wa_id: params.waId || params.tel || "",
      canal: params.canal || "WA",
      items: itemsFinali,
      nota: params.nota || "",
      nota_cucina: params.nota_cucina || "",
      hora: params.hora || "",
      estado: params.estado || "DA_CONFERMARE",
      cucina_check: params.cucina_check || null,
      ts: Date.now(),
      llegado: false,
      // ═══ Delivery fields ═══
      tipo_consegna:  params.tipo_consegna  || "RITIRO",
      direccion:      params.direccion      || null,
      direccion_note: params.direccion_note || null,
      // ═══ Zone delivery ═══
      zona:           params.zona           || null,
      zona_lat:       params.zona_lat       || null,
      zona_lon:       params.zona_lon       || null,
      zona_manuale:   params.zona_manuale   || false
    });
    if (Array.isArray(result) && result.length > 0) return { success: true, id: newId };
    if (result && result.code === "23505") continue;
    return { success: false, error: "errore DB", detail: JSON.stringify(result) };
  }
  return { success: false, error: "troppi tentativi ID collision" };
}

async function modificaOrdine(ordenId, updates) {
  const upd = {};
  if (updates.items) upd.items = updates.items;
  if (updates.nota !== undefined) upd.nota = updates.nota;
  if (updates.hora) upd.hora = updates.hora;
  if (updates.nota_cucina !== undefined) upd.nota_cucina = updates.nota_cucina;
  // ═══ Delivery/Zone fields ═══
  if (updates.tipo_consegna  !== undefined) upd.tipo_consegna  = updates.tipo_consegna;
  if (updates.direccion      !== undefined) upd.direccion      = updates.direccion;
  if (updates.direccion_note !== undefined) upd.direccion_note = updates.direccion_note;
  if (updates.zona           !== undefined) upd.zona           = updates.zona;
  if (updates.zona_lat       !== undefined) upd.zona_lat       = updates.zona_lat;
  if (updates.zona_lon       !== undefined) upd.zona_lon       = updates.zona_lon;
  if (updates.zona_manuale   !== undefined) upd.zona_manuale   = updates.zona_manuale;
  await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, upd);
  return { success: true };
}

async function cambiaStato(ordenId, nuovoStato) {
  await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, { estado: nuovoStato });
  if (nuovoStato === "EN_COCINA") {
    const ord1 = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
    if (ord1?.[0]?.wa_id) {
      await sbUpdate("wa_msgs", `ordine_ref=eq.${encodeURIComponent(ordenId)}&stato=not.in.(COMPLETATO,COCINA)`, { stato: "COCINA" });
      await sbUpdate("conv", `wa_id=eq.${ord1[0].wa_id}&stato_ordine=not.in.(ritirata,chiusa)`, { stato_ordine: "aperta", items: [], hora: "", ts: Date.now() });
    }
  }
  if (nuovoStato === "RETIRADO") {
    const ord2 = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
    if (ord2?.[0]?.wa_id) {
      const waId = ord2[0].wa_id;
      await sbUpdate("conv", `wa_id=eq.${waId}&stato_ordine=not.in.(ritirata,chiusa)`, { stato_ordine: "ritirata" });
      await sbUpdate("wa_msgs", `wa_id=eq.${waId}&stato=not.eq.COMPLETATO`, { stato: "COMPLETATO" });
    }
  }
  return { success: true, id: ordenId, estado: nuovoStato };
}

async function aggiungiItems(ordenId, newItems) {
  const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
  if (!rows || rows.length === 0) return { error: "not found" };
  const merged = mergeItemsBevande(rows[0].items || [], newItems);
  await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, { items: merged });
  return { success: true, items: merged };
}

async function getById(id) {
  const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(id)}`);
  return (rows && rows.length > 0) ? rows[0] : null;
}

module.exports = { creaOrdine, modificaOrdine, cambiaStato, aggiungiItems, getById };
