const assert = require("assert");
const { MENU_TABLES, MENU_ORDER, MenuRepositoryError, readMenuTables } = require("../menuRepository");
const { assembleCatalogue } = require("../menuAdapter");
const { createMenuReadService } = require("../menuService");

const RAW = {
  menu_categorias: [
    { id: "c2", slug: "desserts", label: "Dessert", orden: 2, activo: true },
    { id: "c1", slug: "pizzas", label: "Pizze", orden: 1, activo: true },
  ],
  menu_productos: [
    { id: "p2", legacy_id: 2, clave: "dolce", categoria_id: "c2", nombre_canonico: "Dolce", nombre_clasico: "Dolce", precio: "6", orden: 2, activo: true },
    { id: "p1", legacy_id: 1, clave: "margherita", categoria_id: "c1", num_oficial: 1, nombre_fantasia: "El Pelusa", nombre_clasico: "Margherita", nombre_canonico: "Margherita", prezzo: null, precio: "12", emoji: "🍕", orden: 1, activo: true },
  ],
  menu_extras: [
    { id: "e2", legacy_key: "olive", nombre: "Olive", grupo: "salato", precio_delta: "2", emoji: "🫒", orden: 2, activo: true },
    { id: "e1", legacy_key: "basilico", nombre: "Basilico", grupo: "salato", precio_delta: "1", orden: 1, activo: true },
  ],
  menu_producto_extras: [
    { producto_id: "p1", extra_id: "e2", activo: true },
    { producto_id: "p1", extra_id: "e1", activo: true },
  ],
  menu_aliases: [
    { alias: "margarita", alias_normalizado: "margarita", producto_id: "p1", fuente: "legacy", activo: true },
  ],
};

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("reads exactly the five menu tables with deterministic queries", async () => {
  const calls = [];
  const result = await readMenuTables(async (table, query) => {
    calls.push([table, query]);
    return RAW[table];
  });
  assert.deepStrictEqual(calls.map(([table]) => table), MENU_TABLES);
  assert.deepStrictEqual(calls.map(([table, query]) => query), MENU_TABLES.map((table) => MENU_ORDER[table]));
  assert.equal(Object.keys(result).length, 5);
});

test("normalizes and orders categories and products", () => {
  const menu = assembleCatalogue(RAW, { now: "fixed" });
  assert.deepStrictEqual(menu.categorias.map((row) => row.slug), ["pizzas", "desserts"]);
  assert.deepStrictEqual(menu.productos.map((row) => row.clave), ["margherita", "dolce"]);
  assert.equal(menu.productos[0].precio, 12);
});

test("associates ordered extras and exposes emoji", () => {
  const product = assembleCatalogue(RAW).productos[0];
  assert.deepStrictEqual(product.extras.map((row) => row.legacyKey), ["basilico", "olive"]);
  assert.equal(product.extras[1].emoji, "🫒");
});

test("normalizes aliases", () => {
  const alias = assembleCatalogue(RAW).aliases[0];
  assert.deepStrictEqual(alias, { alias: "margarita", aliasNormalizado: "margarita", productoId: "p1", fuente: "legacy", activo: true });
});

test("product without extras has an empty collection", () => {
  assert.deepStrictEqual(assembleCatalogue(RAW).productos.find((row) => row.id === "p2").extras, []);
});

test("empty dynamic menu falls back to legacy", async () => {
  const empty = Object.fromEntries(MENU_TABLES.map((table) => [table, []]));
  const result = await createMenuReadService({ readTables: async () => empty }).getMenu();
  assert.equal(result.source, "legacy");
  assert.equal(result.reason, "MENU_EMPTY");
  assert.ok(result.legacy.menuLista.length > 0);
});

test("Supabase error is typed and service falls back to legacy", async () => {
  await assert.rejects(() => readMenuTables(async () => { throw new Error("offline"); }), (error) => error instanceof MenuRepositoryError && error.code === "MENU_READ_FAILED");
  const result = await createMenuReadService({ readTables: async () => { throw new MenuRepositoryError("offline", "MENU_READ_FAILED"); } }).getMenu();
  assert.equal(result.source, "legacy");
  assert.equal(result.reason, "MENU_READ_FAILED");
});

test("valid catalogue is authoritative and cached", async () => {
  let reads = 0;
  const service = createMenuReadService({ readTables: async () => { reads++; return RAW; }, ttlMs: 1000, now: () => 10 });
  assert.equal((await service.getMenu()).source, "dynamic");
  assert.equal((await service.getMenu()).source, "dynamic");
  assert.equal(reads, 1);
});

test("repository interface has no write operation", () => {
  const repository = require("../menuRepository");
  assert.deepStrictEqual(Object.keys(repository).sort(), ["MENU_ORDER", "MENU_TABLES", "MenuRepositoryError", "readMenuTables"].sort());
  assert.ok(!Object.keys(repository).some((key) => /insert|update|upsert|delete|write/i.test(key)));
});

test("adapter import does not alter Auth, financial or rider modules", () => {
  for (const path of ["../../auth/legacyAuthGuard", "../../auth/financialHttpIntegration", "../../agents/riderTrip"]) {
    assert.doesNotThrow(() => require(path));
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}: ${error.stack || error}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
