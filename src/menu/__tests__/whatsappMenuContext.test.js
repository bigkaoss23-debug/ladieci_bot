// Phase C — WhatsApp prompt-context renderers (pure). Offline, no DB/LLM.
// Run: `node src/menu/__tests__/whatsappMenuContext.test.js`
const assert = require("assert");
const { renderNumeriMenu, renderExtrasCatalog } = require("../whatsappMenuContext");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("FAIL  " + name + " -> " + e.message); } };

const CAT = {
  productos: [
    { categoria: "pizzas", numOficial: 2, nombreCanonico: "Zizou" },
    { categoria: "pizzas", numOficial: 1, nombreCanonico: "El Pelusa" },
    { categoria: "pizzas", numOficial: 4, nombreCanonico: "El Maestro" },
    { categoria: "pizzas", numOficial: null, nombreCanonico: "Sin Numero" },
    { categoria: "dessert_pizzas", numOficial: null, nombreCanonico: "Pizza Nutella" },
  ],
  extras: [
    { nombre: "Coppa", grupo: "savory" },
    { nombre: "Salami Napoli", grupo: "savory" },
    { nombre: "Kinder", grupo: "sweet" },
    { nombre: "Nutella", grupo: "sweet" },
  ],
};

console.log("\n══ WHATSAPP MENU CONTEXT RENDERERS ══");

t("numeriMenu: pizzas by number, sorted, canonical name, skips null num", () => {
  assert.equal(renderNumeriMenu(CAT), "1=El Pelusa, 2=Zizou, 4=El Maestro");
});
t("numeriMenu reflects DYNAMIC data (4=El Maestro, not a hardcoded map)", () => {
  assert.ok(renderNumeriMenu(CAT).includes("4=El Maestro"));
});
t("extrasCatalog: grouped SALADOS / DULCES from catalogue", () => {
  assert.equal(renderExtrasCatalog(CAT), "SALADOS: Coppa, Salami Napoli · DULCES: Kinder, Nutella");
});
t("renaming a product propagates in the rendered number map", () => {
  const c2 = JSON.parse(JSON.stringify(CAT));
  c2.productos.find((p) => p.numOficial === 4).nombreCanonico = "El Maestro RENAMED";
  assert.ok(renderNumeriMenu(c2).includes("4=El Maestro RENAMED"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
