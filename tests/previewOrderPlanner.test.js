// tests/previewOrderPlanner.test.js
// ===============================================================
// PREVIEW ORDER PLANNER CONTRACT v1 — test-first skeleton
// Run: node tests/previewOrderPlanner.test.js
//
// Boundary:
//   - previewOrderPlanner is read-only.
//   - The planner backend is the source of truth.
//   - This test intentionally imports the expected module path:
//       ../src/agents/previewOrderPlanner
//     Until that module exists, this test must fail with MODULE_NOT_FOUND.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

let previewOrderPlanner;
try {
  ({ previewOrderPlanner } = require("../src/agents/previewOrderPlanner"));
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND" && /previewOrderPlanner/.test(String(e.message))) {
    console.log("EXPECTED FAIL: src/agents/previewOrderPlanner.js is not implemented yet.");
    console.log("Next step: implement previewOrderPlanner(params, deps) read-only contract v1.");
    process.exit(1);
  }
  throw e;
}

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

function writeGuardDb() {
  const calls = [];
  const write = async (op) => {
    throw new Error(`unexpected_db_write_${op}`);
  };
  return {
    calls,
    select: async (table, query) => {
      calls.push({ op: "select", table, query });
      if (table === "ordenes") return [];
      if (table === "manual_giros") return [];
      return [];
    },
    insert: () => write("insert"),
    update: () => write("update"),
    delete: () => write("delete"),
    upsert: () => write("upsert"),
  };
}

function baseDeps(overrides = {}) {
  return {
    now: () => "20:00",
    db: writeGuardDb(),
    resolveDeliveryFields: async () => ({
      zona: "Q2",
      zona_lat: 36.7,
      zona_lon: -2.6,
      durata_andata_min: 8,
      durata_google_min: 8,
      durata_haversine_min: 9,
      geo_source: "google",
      warnings: [],
    }),
    loadPlannerSnapshot: async () => ({
      now: "20:00",
      orders: [],
      manual_giros: [],
      driver: null,
      driver_events: [],
      driver_status: null,
    }),
    evaluateNewOrder: () => ({
      selected: {
        type: "separate",
        hora: "20:30",
        forno_out: "20:22",
        salida: "20:22",
        status: "valid",
      },
      recommended: null,
      options: [
        {
          type: "separate",
          hora: "20:30",
          required_forno_out: "20:22",
          salida: "20:22",
          status: "valid",
          reason: "prima separata libera",
        },
      ],
      proximo_slot: null,
      warnings: [],
      snapshot_now: "20:00",
    }),
    // Guardrail: the new endpoint must not depend on the old zones.js planner.
    proposeForNewOrder: () => {
      throw new Error("proposeForNewOrder_must_not_be_used");
    },
    ...overrides,
  };
}

function hasTopLevelContractShape(r) {
  return r &&
    r.ok === true &&
    r.contract === "nuevo-pedido-planner-preview-v1" &&
    r.source === "planner" &&
    r.mode === "read_only" &&
    r.input && typeof r.input === "object" &&
    r.geo && typeof r.geo === "object" &&
    r.recommendation && typeof r.recommendation === "object" &&
    r.driver && typeof r.driver === "object" &&
    r.giro && typeof r.giro === "object" &&
    Array.isArray(r.alternatives) &&
    Array.isArray(r.availability_rows) &&
    Array.isArray(r.warnings) &&
    Array.isArray(r.blockers) &&
    Array.isArray(r.explanation);
}

function hasNoStacktraceOrPii(r) {
  const out = JSON.stringify(r);
  return !/\bat\s+\w+\s*\(|Error:|\.js:\d+|Persona Inventada|\+34000000000|Calle Falsa/.test(out);
}

async function main() {
  console.log("\n══ Module boundary ══");
  {
    check("previewOrderPlanner export exists", typeof previewOrderPlanner === "function");
    const modulePath = path.join(__dirname, "../src/agents/previewOrderPlanner.js");
    const src = fs.readFileSync(modulePath, "utf8");
    check("does not import/use old proposeForNewOrder",
      !/proposeForNewOrder/.test(src),
      "new Premium preview must use evaluateNewOrder, not zones.js proposeForNewOrder");
  }

  console.log("\n══ Contract shape / DOMICILIO minimal ══");
  {
    const deps = baseDeps();
    const r = await previewOrderPlanner({
      tipo_consegna: "DOMICILIO",
      direccion: "C. Delfin, 45-47",
      hora: "20:30",
      items: [{ id: "pizza-zizou", nombre: "Zizou", cantidad: 1, categoria: "pizza" }],
      pizzas_count: 1,
      now: "20:00",
    }, deps);
    check("contract v1 top-level shape", hasTopLevelContractShape(r), JSON.stringify(r));
    check("geo resolved zone exposed", r.geo.zona === "Q2", JSON.stringify(r.geo));
    check("geo duration exposed", r.geo.duracion_andata_min === 8 || r.geo.durata_andata_min === 8, JSON.stringify(r.geo));
    check("planner recommendation exposed", r.recommendation.recommended_hora === "20:30", JSON.stringify(r.recommendation));
    check("write guard: only read calls allowed",
      deps.db.calls.every((c) => c.op === "select"),
      JSON.stringify(deps.db.calls));
  }

  console.log("\n══ No-write guard ══");
  {
    const deps = baseDeps();
    await previewOrderPlanner({
      tipo_consegna: "DOMICILIO",
      direccion: "C. Delfin, 45-47",
      hora: "20:30",
      items: [],
      pizzas_count: 0,
    }, deps);
    check("no insert/update/delete/upsert called",
      deps.db.calls.every((c) => c.op === "select"),
      JSON.stringify(deps.db.calls));
  }

  console.log("\n══ Invalid params safe error ══");
  {
    const r = await previewOrderPlanner({
      tipo_consegna: "DOMICILIO",
      direccion: "Persona Inventada, Calle Falsa 123",
      telefono: "+34000000000",
      hora: "bad-hour",
    }, baseDeps());
    check("invalid hora returns ok:false", r && r.ok === false, JSON.stringify(r));
    check("error keeps contract", r && r.contract === "nuevo-pedido-planner-preview-v1", JSON.stringify(r));
    check("error is safe: no stacktrace / no PII", hasNoStacktraceOrPii(r), JSON.stringify(r));
  }

  console.log("\n══ RITIRO minimal ══");
  {
    const r = await previewOrderPlanner({
      tipo_consegna: "RITIRO",
      hora: "21:00",
      items: [{ id: "pizza-napoli", nombre: "Napoli", cantidad: 1, categoria: "pizza" }],
      pizzas_count: 1,
    }, baseDeps());
    check("RITIRO contract shape", hasTopLevelContractShape(r), JSON.stringify(r));
    check("RITIRO keeps requested/recommended hora",
      r.recommendation.requested_hora === "21:00" &&
        r.recommendation.recommended_hora === "21:00",
      JSON.stringify(r.recommendation));
    check("RITIRO has no driver required", r.driver.required === false, JSON.stringify(r.driver));
    check("RITIRO has no recommended giro", r.giro.recommended === false, JSON.stringify(r.giro));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
