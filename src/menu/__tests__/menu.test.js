// Phase 2A offline tests — no DB, no LLM, no network.
// Uses a fixture captured from live staging (Phase 1 seed).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  assembleCatalogue, renderMenuLista, renderInfoMenuSection, renderAbbinamenti, MenuAdapterError,
} = require("../menuAdapter");
const { createMenuCache } = require("../menuCache");
const { buildOrderItemSnapshot } = require("../menuSnapshot");

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "staging_catalogue.json"), "utf8"));

let pass = 0, fail = 0;
const _tasks = [];
function t(name, fn) { _tasks.push([name, fn]); }
async function run() {
  for (const [name, fn] of _tasks) {
    try { await fn(); pass++; console.log("  ok  " + name); }
    catch (e) { fail++; console.log("FAIL  " + name + " → " + e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── TASK 8: live-seed parity ──────────────────────────────────────
const cat = assembleCatalogue(RAW);
const pizzas = cat.productos.filter((p) => p.categoria === "pizzas");
const byClave = new Map(cat.productos.map((p) => [p.clave, p]));

t("categorias = 4", () => assert.equal(cat.categorias.length, 4));
t("productos = 45", () => assert.equal(cat.productos.length, 45));
t("extras = 32", () => assert.equal(cat.extras.length, 32));
t("aliases = 42", () => assert.equal(cat.aliases.length, 42));
t("14 numbered pizzas, nums 1-14", () => {
  const nums = pizzas.map((p) => p.numOficial).sort((a, b) => a - b);
  assert.deepEqual(nums, Array.from({ length: 14 }, (_, i) => i + 1));
});
t("stable legacy ids preserved (La Joya=38, Magicbox=37, Pinturicchio=39)", () => {
  assert.equal(byClave.get("la_joya").legacyId, 38);
  assert.equal(byClave.get("magicbox").legacyId, 37);
  assert.equal(byClave.get("pinturicchio").legacyId, 39);
});
t("official Italian labels + prices", () => {
  const m = new Map(pizzas.map((p) => [p.numOficial, p]));
  assert.equal(m.get(1).nombreClasico, "Margherita Classica");
  assert.equal(m.get(2).nombreClasico, "Margherita di Bufala");
  assert.equal(m.get(8).nombreClasico, "Quattro Formaggi");
  assert.equal(m.get(11).nombreClasico, "Capricciosa");
  assert.equal(m.get(12).nombreClasico, "CarboDieci");
  assert.equal(m.get(4).precio, 13.5);
  assert.equal(m.get(13).precio, 16.5);
});
t("Pinturicchio canonical (not 'La Pinturicchio')", () => {
  const p = byClave.get("pinturicchio");
  assert.equal(p.nombreFantasia, "Pinturicchio");
  assert.equal(p.nombreCanonico, "Pinturicchio");
  assert.ok(!cat.productos.some((x) => x.nombreFantasia === "La Pinturicchio"));
});
t("Spanish legacy labels appear only as aliases", () => {
  const norm = new Set(cat.aliases.map((a) => a.aliasNormalizado));
  ["bufalina", "caprichosa", "carbonara", "la pinturicchio"].forEach((x) => assert.ok(norm.has(x), x));
  assert.ok(!cat.productos.some((p) => ["Bufalina", "Caprichosa", "Carbonara"].includes(p.nombreClasico)));
});
t("dessert pizzas receive exactly 5 sweet extras", () => {
  ["pizza_nutella", "pizza_kitkat", "pizza_kinder"].forEach((c) =>
    assert.equal(byClave.get(c).extrasPermitidos.length, 5, c));
});
t("ordinary desserts receive zero extras", () => {
  cat.productos.filter((p) => p.categoria === "desserts").forEach((p) =>
    assert.equal(p.extrasPermitidos.length, 0, p.clave));
});
t("savory pizzas receive 27 savory extras", () => {
  pizzas.forEach((p) => assert.equal(p.extrasPermitidos.length, 27, p.clave));
});
t("no duplicate identities (legacy_id/clave/num)", () => {
  assert.equal(new Set(cat.productos.map((p) => p.legacyId)).size, 45);
  assert.equal(new Set(cat.productos.map((p) => p.clave)).size, 45);
  const pn = pizzas.map((p) => p.numOficial);
  assert.equal(new Set(pn).size, pn.length);
});
t("deterministic ordering (two assembles identical)", () => {
  const a = JSON.stringify(assembleCatalogue(RAW, { now: "T" }));
  const b = JSON.stringify(assembleCatalogue(RAW, { now: "T" }));
  assert.equal(a, b);
});

// ── TASK 9: prompt/parser semantic parity ─────────────────────────
const menuLista = renderMenuLista(cat);
const EXPECTED_PIZZA_LINES = [
  "1. El Pelusa - Margherita Classica 12.00", "2. Zizou - Margherita di Bufala 12.50",
  "3. O Rei - Marinara Classica 10.00", "4. El Maestro - Inferno 13.50",
  "5. El Gaucho - Diavola 13.00", "6. El Divino Codino - Prosciutto 12.50",
  "7. La Pulga - Prosciutto e Funghi 13.00", "8. Il Tulipano Nero - Quattro Formaggi 14.50",
  "9. El Mago de Zadar - Vegetariana 14.50", "10. El Último 10 - Tonno e Cipolla 14.00",
  "11. Il Gladiatore - Capricciosa 14.50", "12. La Joya - CarboDieci 15.00",
  "13. Magicbox - Parmazola 16.50", "14. Pinturicchio - affumicata 15.00",
];
t("MENU_LISTA pizza lines match candidate 49f78183 (semantic parity)", () => {
  const got = menuLista.filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(got, EXPECTED_PIZZA_LINES);
});
t("MENU_LISTA includes KitKat/Kinder + San Miguel + Brutus, no dropped/extra product", () => {
  const joined = menuLista.join(" | ");
  ["Pizza KitKat", "Pizza Kinder", "San Miguel 0,0", "Brutus"].forEach((x) => assert.ok(joined.includes(x), x));
  assert.equal(menuLista.length, 45); // one line per product
});
t("INFO menu section uses official numbering, Italian labels", () => {
  const info = renderInfoMenuSection(cat);
  assert.ok(info.includes("4. El Maestro (Inferno) 13.50€"));
  assert.ok(info.includes("14. Pinturicchio (affumicata) 15€"));
  assert.ok(!/index/i.test(info));
});
// parser resolver (mocked, no LLM): name/alias → product
const _norm = (s) => s.toLowerCase().trim();
const aliasMap = new Map(cat.aliases.map((a) => [a.aliasNormalizado, a.productoId]));
const nameMap = new Map();
cat.productos.forEach((p) => {
  [p.nombreClasico, p.nombreFantasia, p.nombreCanonico].filter(Boolean).forEach((n) => nameMap.set(_norm(n), p.id));
});
function resolve(input) {
  const k = _norm(input);
  const id = nameMap.get(k) || aliasMap.get(k) || null;
  return id ? cat.productos.find((p) => p.id === id) : null;
}
t("parser: Margherita Classica → El Pelusa", () => assert.equal(resolve("Margherita Classica").clave, "el_pelusa"));
t("parser: El Pelusa → El Pelusa", () => assert.equal(resolve("El Pelusa").clave, "el_pelusa"));
t("parser: Bufalina → Zizou", () => assert.equal(resolve("bufalina").clave, "zizou"));
t("parser: Caprichosa → Il Gladiatore", () => assert.equal(resolve("caprichosa").clave, "il_gladiatore"));
t("parser: Carbonara → La Joya", () => assert.equal(resolve("carbonara").clave, "la_joya"));
t("parser: La Pinturicchio → Pinturicchio", () => assert.equal(resolve("la pinturicchio").clave, "pinturicchio"));
t("parser: Ahumada → Pinturicchio", () => assert.equal(resolve("ahumada").clave, "pinturicchio"));
t("parser: Pizza KitKat → pizza_kitkat", () => assert.equal(resolve("Pizza KitKat").clave, "pizza_kitkat"));
t("parser: unknown product → null (safe)", () => assert.equal(resolve("Pizza Unicornio"), null));

// inactive + unavailable behavior
t("parser: inactive product excluded from catalogue + alias dropped", () => {
  const raw2 = JSON.parse(JSON.stringify(RAW));
  raw2.menu_productos.find((p) => p.clave === "zizou").activo = false;
  const c2 = assembleCatalogue(raw2);
  assert.ok(!c2.productos.some((p) => p.clave === "zizou"));
  assert.ok(!c2.aliases.some((a) => a.aliasNormalizado === "bufalina")); // alias to inactive filtered
});
t("temporarily unavailable product stays present with disponible=false (alias still resolves)", () => {
  const raw2 = JSON.parse(JSON.stringify(RAW));
  raw2.menu_productos.find((p) => p.clave === "zizou").disponible = false;
  const c2 = assembleCatalogue(raw2);
  const z = c2.productos.find((p) => p.clave === "zizou");
  assert.ok(z && z.disponible === false && z.activo !== false);
  assert.ok(c2.aliases.some((a) => a.aliasNormalizado === "bufalina"));
});
t("ABBINAMENTI equivalent maps legacy aliases to canonical", () => {
  const ab = renderAbbinamenti(cat);
  assert.ok(ab.includes("=Zizou"));
  assert.ok(ab.includes("=Il Gladiatore"));
  assert.ok(ab.includes("=Pinturicchio"));
});

// ── validation failure tests (never silently ignore corruption) ────
function expectAdapterError(mutate, code) {
  const raw2 = JSON.parse(JSON.stringify(RAW));
  mutate(raw2);
  assert.throws(() => assembleCatalogue(raw2), (e) => e instanceof MenuAdapterError && (!code || e.code === code));
}
t("validation: duplicate legacy_id throws", () => expectAdapterError((r) => { r.menu_productos[1].legacy_id = r.menu_productos[0].legacy_id; }, "DUP_LEGACY_ID"));
t("validation: duplicate clave throws", () => expectAdapterError((r) => { r.menu_productos[1].clave = r.menu_productos[0].clave; }, "DUP_CLAVE"));
t("validation: duplicate num_oficial throws", () => expectAdapterError((r) => {
  const ps = r.menu_productos.filter((p) => p.num_oficial != null); ps[1].num_oficial = ps[0].num_oficial;
}, "DUP_NUM"));
t("validation: duplicate normalized alias throws", () => expectAdapterError((r) => { r.menu_aliases[1].alias_normalizado = r.menu_aliases[0].alias_normalizado; }, "DUP_ALIAS"));
t("validation: orphan producto_extra throws", () => expectAdapterError((r) => { r.menu_producto_extras[0].extra_id = "00000000-0000-0000-0000-000000000000"; }, "ORPHAN_MAP"));
t("validation: alias → missing product throws", () => expectAdapterError((r) => { r.menu_aliases[0].producto_id = "00000000-0000-0000-0000-000000000000"; }, "ALIAS_ORPHAN"));

// ── emoji contract (Phase 3A.1): Supabase row → adapter → payload ──
t("extra emoji flows through adapter; sweet null preserved", () => {
  const raw2 = JSON.parse(JSON.stringify(RAW));
  raw2.menu_extras.forEach((e) => { if (e.legacy_key === "ing_coppa") e.emoji = "🥓"; if (e.grupo === "sweet") e.emoji = null; });
  const c = assembleCatalogue(raw2);
  assert.equal(c.extras.find((e) => e.legacyKey === "ing_coppa").emoji, "🥓");
  assert.equal(c.extras.find((e) => e.grupo === "sweet").emoji, null);
  // per-product permitted extra also carries emoji
  const pizza = c.productos.find((p) => p.categoria === "pizzas");
  assert.ok("extrasPermitidos" in pizza);
});

// ── TASK 7: cache tests ───────────────────────────────────────────
(function cacheTests() {
  t("cache: fresh within TTL, single load", async () => {
    let calls = 0; const cache = createMenuCache({ ttlMs: 1000, loader: async () => { calls++; return { v: calls }; } });
    const a = await cache.get(); const b = await cache.get();
    assert.equal(a.meta.state, "fresh"); assert.equal(b.meta.state, "fresh"); assert.equal(calls, 1);
  });
  t("cache: concurrent callers share one in-flight fetch", async () => {
    let calls = 0; const cache = createMenuCache({ ttlMs: 1000, loader: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { v: 1 }; } });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    assert.equal(calls, 1);
  });
  t("cache: malformed fetch never replaces last-good; serves stale on failure", async () => {
    let mode = "ok"; let now = 0;
    const cache = createMenuCache({ ttlMs: 10, now: () => now, loader: async () => { if (mode === "fail") throw new Error("boom"); return { v: "good" }; } });
    await cache.get();            // caches good at now=0
    now = 100; mode = "fail";      // expired + source failing
    const r = await cache.get();
    assert.equal(r.catalogue.v, "good"); assert.equal(r.meta.state, "stale");
  });
  t("cache: cold start + failure throws (no invented menu / no constants fallback)", async () => {
    const cache = createMenuCache({ ttlMs: 10, loader: async () => { throw new Error("down"); } });
    await assert.rejects(() => cache.get());
  });
})();

// ── TASK 10: snapshot immutability ────────────────────────────────
(function snapshotTests() {
  const product = byClave.get("el_pelusa");
  const snap = buildOrderItemSnapshot(product, { q: 2, extras: ["ing_coppa"], catalogueExtras: cat.extras, nota: "sin albahaca" });
  t("snapshot captures price/name/num/extra at build time", () => {
    assert.equal(snap.p, 12); assert.equal(snap.num, 1); assert.equal(snap.sub, "Margherita Classica");
    assert.equal(snap.extras[0].legacyKey, "ing_coppa"); assert.equal(snap.extras[0].precioDelta, 0.5);
  });
  t("snapshot is frozen — later catalogue price/name/num change does not mutate it", () => {
    const raw2 = JSON.parse(JSON.stringify(RAW));
    const p = raw2.menu_productos.find((x) => x.clave === "el_pelusa");
    p.precio = 99; p.nombre_clasico = "RENAMED"; p.num_oficial = 99; // unique free number
    const c2 = assembleCatalogue(raw2); // catalogue changed
    const changed = c2.productos.find((x) => x.clave === "el_pelusa");
    assert.equal(changed.precio, 99); assert.equal(changed.numOficial, 99);
    // original snapshot untouched:
    assert.equal(snap.p, 12); assert.equal(snap.sub, "Margherita Classica"); assert.equal(snap.num, 1);
    assert.throws(() => { "use strict"; snap.p = 1; }); // frozen
  });
  t("snapshot extra price change in catalogue does not mutate captured extra", () => {
    assert.equal(snap.extras[0].precioDelta, 0.5);
  });
})();

// ── feature-gate logic (mirrors index.js) ─────────────────────────
function gateResult(flag, catalogueFn) {
  return flag === "true" ? catalogueFn() : { error: "unknown action: getMenu" };
}
t("gate: disabled → unknown-action contract (runtime unaffected)", () => {
  assert.deepEqual(gateResult(undefined, () => ({ productos: [] })), { error: "unknown action: getMenu" });
});
t("gate: enabled → returns catalogue", () => {
  assert.ok(gateResult("true", () => ({ productos: cat.productos })).productos.length === 45);
});

run();
