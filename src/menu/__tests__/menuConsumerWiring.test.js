const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { assembleCatalogue } = require("../menuAdapter");
const { createMenuReadService } = require("../menuService");
const { getCanonicalMenu } = require("../menuFacade");
const roles = require("../../auth/legacyActionRoles");

const RAW = {
  menu_categorias: [{ id: "c", slug: "pizzas", label: "Pizze", orden: 1, activo: true }],
  menu_productos: [
    { id: "p2", legacy_id: 2, clave: "seconda", categoria_id: "c", nombre_canonico: "Seconda", nombre_clasico: "Seconda", precio: "13", orden: 2, activo: true },
    { id: "p1", legacy_id: 1, clave: "prima", categoria_id: "c", nombre_canonico: "Prima", nombre_clasico: "Prima", precio: "12", orden: 1, activo: true },
  ],
  menu_extras: [], menu_producto_extras: [], menu_aliases: [],
};

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("read-only consumer receives canonical dynamic shape", async () => {
  const service = createMenuReadService({ readTables: async () => RAW });
  const menu = await getCanonicalMenu(service);
  assert.deepStrictEqual(Object.keys(menu).sort(), ["aliases", "cacheMeta", "categorias", "extras", "generatedAt", "legacy", "productos", "version"].sort());
  assert.equal(menu.cacheMeta.source, "dynamic");
  assert.deepStrictEqual(menu.productos.map((row) => row.clave), ["prima", "seconda"]);
});

test("fallback keeps the same outer response shape on read error", async () => {
  const dynamic = await getCanonicalMenu(createMenuReadService({ readTables: async () => RAW }));
  const fallback = await getCanonicalMenu(createMenuReadService({ readTables: async () => { throw Object.assign(new Error("offline"), { code: "MENU_READ_FAILED" }); } }));
  assert.deepStrictEqual(Object.keys(fallback).sort(), Object.keys(dynamic).sort());
  assert.equal(fallback.cacheMeta.source, "legacy");
  assert.equal(fallback.cacheMeta.fallbackReason, "MENU_READ_FAILED");
  assert.ok(fallback.legacy.menuLista.length > 0);
});

test("empty catalogue uses legacy fallback", async () => {
  const empty = Object.fromEntries(Object.keys(RAW).map((key) => [key, []]));
  const menu = await getCanonicalMenu(createMenuReadService({ readTables: async () => empty }));
  assert.equal(menu.cacheMeta.source, "legacy");
  assert.equal(menu.cacheMeta.fallbackReason, "MENU_EMPTY");
});

test("last-good cache survives a later source error", async () => {
  let clock = 0, reads = 0;
  const service = createMenuReadService({
    ttlMs: 10,
    now: () => clock,
    readTables: async () => { if (++reads > 1) throw new Error("offline"); return RAW; },
  });
  assert.equal((await getCanonicalMenu(service)).cacheMeta.state, "fresh");
  clock = 20;
  const stale = await getCanonicalMenu(service);
  assert.equal(stale.cacheMeta.source, "dynamic");
  assert.equal(stale.cacheMeta.state, "stale");
  assert.equal(reads, 2);
});

test("concurrent consumers share one source read", async () => {
  let release, reads = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const service = createMenuReadService({ readTables: async () => { reads++; await wait; return RAW; } });
  const a = getCanonicalMenu(service), b = getCanonicalMenu(service);
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(reads, 1);
  assert.deepStrictEqual(first.productos, second.productos);
});

test("assembly order is stable regardless of input order", () => {
  const reversed = { ...RAW, menu_productos: RAW.menu_productos.slice().reverse() };
  assert.deepStrictEqual(
    assembleCatalogue(RAW, { now: "fixed" }),
    assembleCatalogue(reversed, { now: "fixed" })
  );
});

test("getMenu role contract is admin/operator only", () => {
  assert.equal(roles.isAllowed("admin", "getMenu"), true);
  assert.equal(roles.isAllowed("operator", "getMenu"), true);
  assert.equal(roles.isAllowed("rider", "getMenu"), false);
});

test("wiring is GET-only and repository exposes no writes", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "../../..", "index.js"), "utf8");
  const getBlock = indexSource.split('app.get("/api"')[1].split('app.post("/api"')[0];
  const postBlock = indexSource.split('app.post("/api"')[1];
  assert.ok(getBlock.includes('action === "getMenu"'));
  assert.ok(!postBlock.includes('action === "getMenu"'));
  const repository = require("../menuRepository");
  assert.ok(!Object.keys(repository).some((key) => /write|insert|update|upsert|delete/i.test(key)));
});

test("no authoritative parser, order creation or planner consumer is wired", () => {
  const changedConsumers = [
    "src/agents/agentOrdini.js",
    "src/agents/previewTiming.js", "src/core/delivery/planner.js",
  ];
  for (const file of changedConsumers) {
    const source = fs.readFileSync(path.join(__dirname, "../../..", file), "utf8");
    assert.ok(!source.includes("getCanonicalMenu"), file);
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
