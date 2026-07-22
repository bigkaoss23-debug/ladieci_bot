const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { runWhatsappMenuShadow } = require("../whatsappMenuShadow");

const MENU = {
  cacheMeta: { source: "dynamic" },
  categorias: [{ id: "c1", slug: "pizzas", label: "Pizze" }],
  productos: [{ id: "p1", clave: "pelusa", nombreCanonico: "El Pelusa", nombreFantasia: "El Pelusa", ingredientesBase: ["Cebolla"] }],
  extras: [{ id: "e1", legacyKey: "ing_coppa", nombre: "Coppa" }],
  aliases: [],
};
const LEGACY = [{ n: "El Pelusa", q: 2, p: 12, e: "🍕", sub: "extra Coppa, sin cebolla" }];
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("flag off executes no loader, resolver or diagnostic", async () => {
  let loads = 0, emits = 0;
  const out = await runWhatsappMenuShadow({ enabled: false, legacyItems: LEGACY, loadCanonicalMenu: async () => { loads++; return MENU; }, emitDiagnostic: () => emits++ });
  assert.equal(out.executed, false);
  assert.equal(loads, 0);
  assert.equal(emits, 0);
  assert.strictEqual(out.legacyItems, LEGACY);
});

test("flag on loads canonical menu once and legacy remains authoritative", async () => {
  let loads = 0;
  const diagnostics = [];
  const ticks = [100, 107, 107, 107];
  const out = await runWhatsappMenuShadow({ enabled: true, legacyItems: LEGACY, loadCanonicalMenu: async () => { loads++; return MENU; }, emitDiagnostic: (value) => diagnostics.push(value), now: () => ticks.shift() ?? 107 });
  assert.equal(loads, 1);
  assert.strictEqual(out.legacyItems, LEGACY);
  assert.deepStrictEqual(out.legacyItems, [{ n: "El Pelusa", q: 2, p: 12, e: "🍕", sub: "extra Coppa, sin cebolla" }]);
  assert.deepStrictEqual(diagnostics.map((item) => item.classification), ["MATCH", "MATCH", "MATCH"]);
  assert.ok(diagnostics.every((item) => item.event === "dynamic_menu_shadow" && item.durationMs === 7 && item.errorCode === null));
});

test("menu error never blocks or mutates legacy output", async () => {
  const emitted = [];
  const out = await runWhatsappMenuShadow({ enabled: true, legacyItems: LEGACY, loadCanonicalMenu: async () => { throw new Error("offline"); }, emitDiagnostic: (value) => emitted.push(value) });
  assert.equal(out.error, true);
  assert.strictEqual(out.legacyItems, LEGACY);
  assert.equal(emitted[0].classification, "ERROR");
  assert.equal(emitted[0].errorCode, "MENU_LOAD_FAILED");
});

test("diagnostic sink failure never blocks legacy", async () => {
  const out = await runWhatsappMenuShadow({ enabled: true, legacyItems: LEGACY, loadCanonicalMenu: async () => MENU, emitDiagnostic: () => { throw new Error("sink"); } });
  assert.strictEqual(out.legacyItems, LEGACY);
  assert.equal(out.diagnostics.length, 3);
});

test("shadow module has no DB writes, persistence, planner or order creation", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "whatsappMenuShadow.js"), "utf8");
  for (const forbidden of ["sbInsert", "sbUpdate", "sbUpsert", "sbDelete", "fetch(", "planner", "agentOrdini", "createOrden", "creaOrdine"]) assert.ok(!source.includes(forbidden), forbidden);
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
