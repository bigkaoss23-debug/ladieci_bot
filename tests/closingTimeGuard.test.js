// S2-7D6B3 — closingTime.js used to ALSO enforce a hardcoded 23:00 ceiling on
// the requested hora (bot-only in creaOrdine via a "hardClosingGuard" flag,
// unconditionally — no operator exemption at all — in modificaOrdine), backed
// by a tracked-override escape hatch (FUERA_HORARIO_REQUIERE_OVERRIDE /
// FUERA_HORARIO_FORZADO). That ceiling silently contradicted the approved
// service-window policy (SERA_WINDOW intake genuinely runs to 00:00, so a
// 23:40 order is normal) and is retired, not layered over. This file used to
// assert the RETIRED behavior exhaustively; it now asserts its absence and the
// one thing that remains: format validation, unconditionally, everywhere.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  FUERA_HORARIO_INVALIDA,
  HORA_INVALIDA_MSG,
  horaToMinStrict,
  horaInvalidaError,
  validateHoraFormat,
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

// S2-7D6B2 — this test is about the hora-format guard, not the midnight
// order-intake cutoff. Stub the whole intake gate open so it never interferes.
const intakePath = require.resolve("../src/serviceSessions/orderIntakePolicy");
require(intakePath);
require.cache[intakePath].exports.gateNewOrderIntake = async () => ({
  allowed: true, code: "ALLOWED", detail: null, scheduleState: null, serviceKind: null, businessDate: null, sourceChannel: null,
});

const { creaOrdine, modificaOrdine } = require("../src/agents/agentOrdini");
const lastOrdenesWrite = () => [...writes].reverse().find(w => w.table === "ordenes");

// ── Format parsing is unchanged ─────────────────────────────────────────────
assert.strictEqual(horaToMinStrict("22:30"), 22 * 60 + 30);
assert.strictEqual(horaToMinStrict("23:00"), 23 * 60);
assert.strictEqual(horaToMinStrict("23:01"), 23 * 60 + 1);
assert.strictEqual(horaToMinStrict("23:40"), 23 * 60 + 40);
assert.strictEqual(horaToMinStrict("xx:yy"), null);
assert.strictEqual(horaToMinStrict("24:00"), null);

// ── validateHoraFormat: format-only, no ceiling, no override machinery ──────
assert.strictEqual(validateHoraFormat("22:30").success, true);
assert.strictEqual(validateHoraFormat("23:00").success, true);
assert.strictEqual(validateHoraFormat("23:01").success, true, "23:01 must be ACCEPTED — the ceiling is retired");
assert.strictEqual(validateHoraFormat("23:40").success, true, "23:40 must be ACCEPTED — the ceiling is retired");
assert.strictEqual(validateHoraFormat("23:59").success, true);
assert.strictEqual(validateHoraFormat("00:15").success, true, "a cross-midnight fulfillment hora must be representable");
assert.strictEqual(validateHoraFormat("xx:yy").error, FUERA_HORARIO_INVALIDA);
assert.deepStrictEqual(horaInvalidaError("xx:yy"), { success: false, error: FUERA_HORARIO_INVALIDA, code: FUERA_HORARIO_INVALIDA, hora: "xx:yy", message: HORA_INVALIDA_MSG });

(async () => {
  // ── creaOrdine (WhatsApp path, operatorManual falsy — the channel that used
  // to be ceiling-gated) now accepts every well-formed hora ─────────────────
  let res = await creaOrdine({ nombre: "Test", items: [], hora: "22:30" });
  assert.strictEqual(res.success, true);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:00" });
  assert.strictEqual(res.success, true);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:01" });
  assert.strictEqual(res.success, true, "23:01 with no override must now succeed — no ceiling left to require one");

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:40" });
  assert.strictEqual(res.success, true, "23:40 with no override must now succeed");
  assert.strictEqual(lastOrdenesWrite().data.hora, "23:40");

  res = await creaOrdine({ nombre: "Test", items: [], hora: "23:59" });
  assert.strictEqual(res.success, true);

  res = await creaOrdine({ nombre: "Test", items: [], hora: "xx:yy" });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_INVALIDA, "malformed hora is still rejected — that check never depended on the ceiling");

  // ── modificaOrdine: the asymmetry (no operator exemption at all) is retired
  // along with the ceiling — a plain update to 23:10 now succeeds outright,
  // with no forzado/override marker required ──────────────────────────────
  res = await modificaOrdine("#TEST", { hora: "23:10" });
  assert.strictEqual(res.success, true, "modificaOrdine must accept 23:10 with no override — the asymmetric ceiling is gone");
  assert.strictEqual(lastOrdenesWrite().type, "update");
  assert.strictEqual(lastOrdenesWrite().data.hora, "23:10");

  res = await modificaOrdine("#TEST", { hora: "xx:yy" });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, FUERA_HORARIO_INVALIDA);

  // ── The obsolete copy/behavior must be gone from orchestrator.js, not just
  // dormant — this proves root-cause removal rather than a symptom patch ───
  const orchestratorSrc = fs.readFileSync(path.join(__dirname, "../src/agents/orchestrator.js"), "utf8");
  assert.ok(!orchestratorSrc.includes("No podemos aceptar pedidos después de las 23:00"), "the stale 23:00 claim must be gone from WhatsApp copy");
  assert.ok(!orchestratorSrc.includes("isHoraDentroHorario("), "the retired ceiling check must no longer be CALLED from orchestrator.js (a historical mention in a comment is fine)");
  assert.ok(!orchestratorSrc.includes("motivo: \"fuera_horario_cierre\""), "the retired ceiling motivo must no longer be RETURNED");

  console.log("closingTimeGuard.test.js OK");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
