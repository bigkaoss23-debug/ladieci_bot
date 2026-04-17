// ===============================================================
// agentOrdini.js — CRUD ordini. Solo questo. Mai in cucina.
// ===============================================================

const { sbSelect, sbUpsert, sbUpdate, sbDelete } = require("../utils/supabase");
const { mergeItemsBevande } = require("../utils/helpers");

async function creaOrdine(params) {
  // Considera solo gli ordini creati OGGI — così dopo chiudiServizio si riparte da #001
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const last = await sbSelect("ordenes", `ts=gte.${startOfDay.getTime()}&order=ts.desc&limit=50`);
  const lastNum = (last && Array.isArray(last))
    ? Math.max(0, ...last.map(o => parseInt((o.id || "").replace(/[^0-9]/g, "")) || 0))
    : 0;

  for (let attempt = 0; attempt < 5; attempt++) {
    const newId = "#" + String(lastNum + 1 + attempt).padStart(3, "0");
    const result = await sbUpsert("ordenes", {
      id: newId,
      nombre: params.nombre || "",
      tel: params.tel || "",
      wa_id: params.waId || params.tel || "",
      canal: params.canal || "WA",
      items: params.items || [],
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
      direccion_note: params.direccion_note || null
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
