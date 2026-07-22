const assert = require("assert");

const claudePath = require.resolve("../../utils/claude");
const realClaude = require(claudePath);
require.cache[claudePath].exports = {
  ...realClaude,
  chiamaClaude: async () => JSON.stringify({
    tipo: "ordine", items: [{ n: "El Pelusa", q: 1, p: 12, e: "🍕", sub: "" }],
    nota: "", hora: "21:00", conf: 95, tipo_consegna: "RITIRO", direccion: "",
  }),
};

delete process.env.DYNAMIC_MENU_SHADOW_ENABLED;
const { interpreta } = require("../../agents/agentWhatsapp");
const MENU = {
  cacheMeta: { source: "dynamic" },
  categorias: [{ id: "c1", slug: "pizzas", label: "Pizze" }],
  productos: [{ id: "p1", clave: "pelusa", nombreCanonico: "El Pelusa", nombreFantasia: "El Pelusa", ingredientesBase: [] }],
  extras: [], aliases: [],
};

(async () => {
  let loads = 0, emits = 0;
  const off = await interpreta("una el pelusa", {}, null, [], {
    loadCanonicalMenu: async () => { loads++; return MENU; },
    emitDiagnostic: () => emits++,
  });
  assert.equal(loads, 0, "default-off must not load menu");
  assert.equal(emits, 0, "default-off must not emit diagnostic");

  process.env.DYNAMIC_MENU_SHADOW_ENABLED = "true";
  const diagnostics = [];
  const on = await interpreta("una el pelusa", {}, null, [], {
    loadCanonicalMenu: async () => { loads++; return MENU; },
    emitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  delete process.env.DYNAMIC_MENU_SHADOW_ENABLED;

  assert.deepStrictEqual(on, off, "shadow must not alter authoritative legacy result");
  assert.equal(loads, 1, "one cached-menu load per parser result, not per token");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].classification, "MATCH");
  assert.ok(!JSON.stringify(diagnostics[0]).includes("una el pelusa"));
  console.log("agentWhatsappShadowIntegration: 7 passed, 0 failed");
})().catch((error) => { delete process.env.DYNAMIC_MENU_SHADOW_ENABLED; console.error(error.stack || error); process.exit(1); });
