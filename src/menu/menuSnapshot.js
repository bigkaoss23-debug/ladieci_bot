// ===============================================================
// menuSnapshot.js — Phase 2A snapshot mapper (PREPARED, NOT ACTIVATED)
// Converts a catalogue product + selected extras into an IMMUTABLE
// order-item snapshot. Existing order-creation paths are unchanged;
// this is not wired into runtime in Phase 2A.
//
// Contract: once built, the snapshot must never change if the catalogue
// later changes price / name / number / extra. It is a deep copy + freeze.
// ===============================================================

// product = a structured catalogue product (from menuAdapter)
// opts = { q, extras: [{legacyKey,...}] | [legacyKey], nota, catalogueExtras }
function buildOrderItemSnapshot(product, opts = {}) {
  if (!product) throw new Error("buildOrderItemSnapshot: product required");
  const q = Number(opts.q) > 0 ? Number(opts.q) : 1;

  // resolve selected extras against the catalogue extras list, snapshotting
  // name + price delta at THIS moment (immune to later edits).
  const catExtras = new Map((opts.catalogueExtras || []).map((e) => [e.legacyKey, e]));
  const selected = (opts.extras || []).map((sel) => {
    const key = typeof sel === "string" ? sel : sel.legacyKey;
    const e = catExtras.get(key) || (typeof sel === "object" ? sel : null);
    if (!e) throw new Error(`snapshot: unknown extra '${key}'`);
    return {
      legacyKey: e.legacyKey,
      nombre: e.nombre,
      precioDelta: Number(e.precioDelta),
    };
  });

  const snap = {
    // stable identity
    id: product.legacyId,
    legacy_id: product.legacyId,
    clave: product.clave,
    // display snapshots (immutable at order time)
    n: product.nombreFantasia || product.nombreClasico,
    nombre_fantasia: product.nombreFantasia,
    sub: product.nombreClasico,
    nombre_clasico: product.nombreClasico,
    num: product.numOficial,
    num_oficial: product.numOficial,
    p: Number(product.precio),
    q,
    cat: product.categoria,
    e: product.emoji,
    ing: (product.ingredientesBase || []).slice(),
    alg: (product.alergenos || []).slice(),
    extras: selected,
    nota: opts.nota || "",
  };

  // deep-freeze so nothing can mutate a captured snapshot in memory
  return deepFreeze(snap);
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

module.exports = { buildOrderItemSnapshot };
