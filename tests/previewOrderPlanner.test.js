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
  const snapshot = {
    now: "20:00",
    orders: [{ id: "#A", tipo_consegna: "DOMICILIO", estado: "NUEVO", zona: "Q2", hora: "20:00", andata_min: 8, n_pizze: 1 }],
    manual_giros: [],
    driver: null,
    driver_events: [],
    driver_status: null,
  };
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
    loadPlannerSnapshot: async () => snapshot,
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

  console.log("\n══ Snapshot loader integration ══");
  {
    let loaderArgs = null;
    let plannerSnapshot = null;
    let plannerNewOrder = null;
    const deps = baseDeps({
      now: () => "20:15",
      loadPlannerSnapshot: async (args) => {
        loaderArgs = args;
        return {
          now: "20:15",
          orders: [{ id: "#S1", tipo_consegna: "DOMICILIO", estado: "NUEVO", zona: "Q2", hora: "20:00", andata_min: 8, n_pizze: 1 }],
          manual_giros: [],
          driver: null,
          driver_events: [],
          driver_status: null,
        };
      },
      evaluateNewOrder: (snapshot, newOrder) => {
        plannerSnapshot = snapshot;
        plannerNewOrder = newOrder;
        return {
          selected: { type: "separate", hora: "20:30", forno_out: "20:22", salida: "20:22", status: "valid" },
          recommended: null,
          options: [],
          proximo_slot: null,
          warnings: [],
          snapshot_now: snapshot.now,
        };
      },
    });
    const r = await previewOrderPlanner({
      tipo_consegna: "DOMICILIO",
      direccion: "C. Delfin, 45-47",
      hora: "20:30",
      date: "2026-06-07",
      items: [{ id: "pizza-zizou", nombre: "Zizou", cantidad: 1, categoria: "pizza" }],
      pizzas_count: 1,
      now: "20:10",
    }, deps);
    check("snapshot loader called with db/date/now/includePii=false",
      loaderArgs &&
        loaderArgs.db === deps.db &&
        loaderArgs.date === "2026-06-07" &&
        loaderArgs.now === "20:15" &&
        loaderArgs.includePii === false,
      JSON.stringify(loaderArgs));
    check("evaluateNewOrder receives loaded snapshot", plannerSnapshot && plannerSnapshot.now === "20:15", JSON.stringify(plannerSnapshot));
    check("newOrder is clean planner input",
      plannerNewOrder &&
        plannerNewOrder.id === "__preview_new_order__" &&
        plannerNewOrder.tipo_consegna === "DOMICILIO" &&
        plannerNewOrder.zona === "Q2" &&
        plannerNewOrder.hora === "20:30" &&
        plannerNewOrder.andata_min === 8 &&
        plannerNewOrder.n_pizze === 1 &&
        !("direccion" in plannerNewOrder) &&
        !("telefono" in plannerNewOrder),
      JSON.stringify(plannerNewOrder));
    check("contract still ok after snapshot integration", r.ok === true && r.recommendation.recommended_hora === "20:30", JSON.stringify(r));
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

  console.log("\n══ Real evaluateNewOrder / realistic fake snapshot ══");
  {
    const db = writeGuardDb();
    const r = await previewOrderPlanner({
      tipo_consegna: "DOMICILIO",
      direccion: "C. Delfin, 45-47",
      hora: "17:53",
      items: [{ id: "pizza-zizou", nombre: "Zizou", cantidad: 1, categoria: "pizza" }],
      pizzas_count: 1,
      now: "17:30",
    }, {
      now: () => "17:30",
      db,
      resolveDeliveryFields: async () => ({
        zona: "Q2",
        zona_lat: 36.7,
        zona_lon: -2.6,
        durata_andata_min: 6,
        durata_google_min: 6,
        durata_haversine_min: 7,
        geo_source: "google",
        warnings: [],
      }),
      loadPlannerSnapshot: async () => ({
        now: "17:30",
        orders: [
          {
            id: "#G1",
            tipo_consegna: "DOMICILIO",
            estado: "EN_COCINA",
            zona: "Q2",
            hora: "17:55",
            andata_min: 6,
            n_pizze: 1,
          },
        ],
        manual_giros: [],
        driver: null,
        driver_events: [],
        driver_status: null,
      }),
    });
    check("real planner contract ok", hasTopLevelContractShape(r), JSON.stringify(r));
    check("real planner returns requested/recommended time",
      r.recommendation.requested_hora === "17:53" &&
        r.recommendation.recommended_hora === "17:53",
      JSON.stringify(r.recommendation));
    check("real planner exposes compatible giro alternative",
      r.giro.recommended === true &&
        r.giro.can_attach === true &&
        r.alternatives.some((item) => item.can_attach === true),
      JSON.stringify({ giro: r.giro, alternatives: r.alternatives }));
    check("real planner does not write DB", db.calls.length === 0, JSON.stringify(db.calls));
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

  console.log("\n══ Missing snapshot deps safe error ══");
  {
    const r = await previewOrderPlanner({
      tipo_consegna: "DOMICILIO",
      direccion: "C. Delfin, 45-47",
      hora: "20:30",
      items: [],
      pizzas_count: 0,
    }, {
      resolveDeliveryFields: baseDeps().resolveDeliveryFields,
      evaluateNewOrder: baseDeps().evaluateNewOrder,
    });
    check("missing db/snapshot returns safe error", r && r.ok === false && r.error && r.error.code === "snapshot_unavailable", JSON.stringify(r));
    check("snapshot error is safe", hasNoStacktraceOrPii(r), JSON.stringify(r));
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
