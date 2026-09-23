// tests/helpers/postgrestPatch.js — [PAYMENT-IDEMPOTENCY 2026-09-23]
// Modello minimo del PATCH PostgREST per gli stub in-memory dei test:
//   - applica il patch SOLO alle righe che soddisfano TUTTI i filtri della query
//     (col=eq.v | col=neq.v | col=is.null), come fa il WHERE reale;
//   - con Prefer "return=representation" restituisce l'array delle righe
//     aggiornate (vuoto se il filtro non colpisce nulla), altrimenti "" (204).
// Serve perché la finalizzazione e la correzione del metodo sono ora UPDATE
// condizionati (compare-and-swap): uno stub che ignora i filtri e risponde ""
// non può distinguere "scritto" da "perso la corsa".
// La concorrenza VERA (lock di riga, READ COMMITTED) è coperta dalla suite su
// Postgres + PostgREST reali, non da qui.

function parseFilter(query) {
  const conds = [];
  for (const part of String(query || "").split("&")) {
    const m = part.match(/^([a-z_]+)=(eq|neq|is)\.(.*)$/);
    if (!m) continue;
    conds.push({ col: m[1], op: m[2], val: decodeURIComponent(m[3]) });
  }
  return conds;
}

function rowMatches(row, conds) {
  return conds.every(({ col, op, val }) => {
    const v = row[col];
    if (op === "is") return val === "null" ? v == null : String(v) === val;
    if (op === "eq") return v != null && String(v) === val;
    if (op === "neq") return v != null && String(v) !== val;
    return false;
  });
}

// store: { [id]: row }. Ritorna ciò che PostgREST risponderebbe.
function applyPatch(store, query, patch, prefer) {
  const conds = parseFilter(query);
  const hit = Object.values(store).filter((r) => rowMatches(r, conds));
  for (const r of hit) Object.assign(r, patch);
  if (prefer && /return=representation/.test(prefer)) return hit.map((r) => ({ ...r }));
  return "";
}

module.exports = { applyPatch, parseFilter, rowMatches };
