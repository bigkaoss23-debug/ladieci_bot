const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  FUERA_HORARIO_INVALIDA,
  FUERA_HORARIO_REQUIERE_OVERRIDE,
  FUERA_HORARIO_OVERRIDE_MARKER,
  horaToMinStrict,
  isHoraDentroHorario,
  isAfterClosing,
  hasValidClosingOverride,
  validateClosingTime,
} = require("../src/utils/closingTime");

const supabasePath = require.resolve("../src/utils/supabase");
const writes = [];
const currentOrder = {
  id: "#TEST",
  estado: "POR_CONFIRMAR",
  items: [],
  hora: "22:30",
  tipo_consegna: "RITIRO",
  nota: "",
  nota_cucina: "",
  forzado: false,
};

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    sbSelect: async (table, query = "") => {
      if (table === "config") return [];
      if (table === "clientes") return [];
      if (table === "ordenes" && query.includes("select=estado")) return [{ estado: currentOrder.estado }];
      if (table === "ordenes" && query.includes("id=eq.%23TEST")) return [{ ...currentOrder }];
      if (table === "ordenes") return [];
      return [];
    },
    sbInsert: async (table, data) => {
      writes.push({ type: "insert", table, data });
      if (table === "ordenes") return [{ ...data }];
      if (table === "clientes") return [{ id: "cli-test" }];
      return [{ ...data }];
    },
    sbUpdate: async (table, query, data) => {
      writes.push({ type: "update", table, query, data });
      return [{ ...data }];
    },
    sbUpsert: async (table, data) => {
      writes.push({ type: "upsert", table, data });
      return [{ ...data }];
    },
    sbDelete: async (table, query) => {
      writes.push({ type: "delete", table, query });
      return [];
    },
    getConfig: async () => ({}),
  },
};

const { creaOrdine, modificaOrdine } = require("../src/agents/agentOrdini");
const lastOrdenesWrite = () => [...writes].reverse().find(w => w.table === "ordenes");

const validOverride = {
  forzado: true,
  nota: `[${FUERA_HORARIO_OVERRIDE_MARKER} 23:10]`,
};

assert.strictEqual(horaToMinStrict("22:30"), 22 * 60 + 30);
assert.strictEqual(horaToMinStrict("23:00"), 23 * 60);
assert.strictEqual(horaToMinStrict("23:01"), 23 * 60 + 1);
assert.strictEqual(horaToMinStrict("23:40"), 23 * 60 + 40);
assert.strictEqual(horaToMinStrict("xx:yy"), null);
assert.strictEqual(horaToMinStrict("24:00"), null);

assert.strictEqual(isHoraDentroHorario("22:30"), true);
assert.strictEqual(isHoraDentroHorario("23:00"), true);
assert.strictEqual(isHoraDentroHorario("23:01"), false);
assert.strictEqual(isAfterClosing("23:01"), true);

assert.strictEqual(validateClosingTime({ hora: "22:30" }).success, true);
assert.strictEqual(validateClosingTime({ hora: "23:00" }).success, true);
assert.strictEqual(validateClosingTime({ hora: "23:01" }).error, FUERA_HORARIO_REQUIERE_OVERRIDE);
assert.strictEqual(validateClosingTime({ hora: "23:40" }).error, FUERA_HORARIO_REQUIERE_OVERRIDE);
assert.strictEqual(validateClosingTime({ hora: "23:10", ...validOverride }).success, true);
assert.strictEqual(validateClosingTime({ hora: "23:10", forzado: true }).error, FUERA_HORARIO_REQUIERE_OVERRIDE);
assert.strictEqual(validateClosingTime({
  hora: "23:10",
  forzado: false,
  nota: `[${FUERA_HORARIO_OVERRIDE_MARKER} 23:10]`,
}).error, FUERA_HORARIO_REQUIERE_OVERRIDE);
assert.strictEqual(validateClosingTime({ hora: "xx:yy", ...validOverride }).error, FUERA_HORARIO_INVALIDA);
assert.strictEqual(hasValidClosingOverride(validOverride), true);

(async () => {
  let res = await creaOrdine({ nombre: "Test", items: [], hora: "22:30" });
  assert.strictEqual(res.success, true);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:00" });
  assert.strictEqual(res.success, true);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:01" });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_REQUIERE_OVERRIDE);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:40" });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_REQUIERE_OVERRIDE);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:10", ...validOverride });
  assert.strictEqual(res.success, true);
  assert.strictEqual(lastOrdenesWrite().data.forzado, true);
  assert.ok(lastOrdenesWrite().data.nota.includes(FUERA_HORARIO_OVERRIDE_MARKER));

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:10", forzado: true });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_REQUIERE_OVERRIDE);

  res = await creaOrdine({
    nombre: "Test",
    items: [],
    hora: "23:10",
    forzado: false,
    nota: `[${FUERA_HORARIO_OVERRIDE_MARKER} 23:10]`,
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_REQUIERE_OVERRIDE);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "xx:yy", ...validOverride });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_INVALIDA);

  res = await modificaOrdine("#TEST", { hora: "23:10" });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_REQUIERE_OVERRIDE);

  res = await modificaOrdine("#TEST", { hora: "23:10", ...validOverride });
  assert.strictEqual(res.success, true);
  assert.strictEqual(lastOrdenesWrite().type, "update");
  assert.strictEqual(lastOrdenesWrite().data.forzado, true);
  assert.ok(lastOrdenesWrite().data.nota.includes(FUERA_HORARIO_OVERRIDE_MARKER));

  const orchestratorSrc = fs.readFileSync(path.join(__dirname, "../src/agents/orchestrator.js"), "utf8");
  assert.ok(orchestratorSrc.includes("No podemos aceptar pedidos después de las 23:00"));
  assert.ok((orchestratorSrc.match(/fuera_horario_cierre/g) || []).length >= 2);
  assert.ok(!orchestratorSrc.includes("FUERA_HORARIO_FORZADO"));

  console.log("closingTimeGuard.test.js OK");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
