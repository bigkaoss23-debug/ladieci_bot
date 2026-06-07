// tests/plannerSnapshot.test.js
// ===============================================================
// PLANNER SNAPSHOT LOADER — test-first skeleton
// Run: node tests/plannerSnapshot.test.js
//
// Boundary:
//   - loadPlannerSnapshot is read-only.
//   - It returns planner-compatible raw facts without PII by default.
//   - This test intentionally imports the expected module path:
//       ../src/core/delivery/plannerSnapshot
//     Until that module exists, this test must fail with MODULE_NOT_FOUND.
// ===============================================================
"use strict";

let loadPlannerSnapshot;
try {
  ({ loadPlannerSnapshot } = require("../src/core/delivery/plannerSnapshot"));
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND" && /plannerSnapshot/.test(String(e.message))) {
    console.log("EXPECTED FAIL: src/core/delivery/plannerSnapshot.js is not implemented yet.");
    console.log("Next step: implement loadPlannerSnapshot({ db, date, now, includePii }) read-only.");
    process.exit(1);
  }
  throw e;
}

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

function pizza(name, q) {
  return { n: name, q };
}

const ORDER_ROWS = [
  {
    id: "#D1",
    tipo_consegna: "DOMICILIO",
    estado: "NUEVO",
    zona: "Q2",
    hora: "20:30",
    durata_andata_min: 8,
    items: [pizza("Zizou", 1), pizza("Margherita", 2)],
    manual_giro_id: "mg_1",
    forzado: false,
    created_at: "2026-06-07T18:00:00.000Z",
    forno_out: "20:22",
    salida_driver_estimada: "20:22",
    entrega_estimada: "20:30",
    retraso_estimado_min: 0,
    conflicto_driver: false,
    nombre: "Persona Inventada",
    telefono: "+34000000000",
    direccion: "Calle Falsa 123",
    wa_id: "34000000000",
    nota_cliente: "No incluir PII",
  },
  {
    id: "#R1",
    tipo_consegna: "RITIRO",
    estado: "NUEVO",
    zona: null,
    hora: "21:00",
    items: [pizza("Napoli", 1)],
  },
  {
    id: "#TERM",
    tipo_consegna: "DOMICILIO",
    estado: "RETIRADO",
    zona: "Q1",
    hora: "19:00",
    durata_andata_min: 5,
    items: [pizza("Diavola", 1)],
  },
  {
    id: "#CANCEL",
    tipo_consegna: "DOMICILIO",
    estado: "CANCELADO",
    zona: "Q1",
    hora: "19:30",
    durata_andata_min: 5,
    items: [pizza("Marinara", 1)],
  },
];

const GIRO_ROWS = [
  {
    id: "mg_1",
    type: "manual_route",
    order_ids: ["#D1"],
    route_order: ["#D1"],
    block_start: "20:20",
    manual_duration_min: 18,
    created_by_operator: true,
    force: true,
    hora_ref: "20:30",
    internal_note: "No incluir note non necessarie",
  },
];

function writeGuardDb({ orders = ORDER_ROWS, manualGiros = GIRO_ROWS } = {}) {
  const calls = [];
  const write = async (op) => {
    throw new Error(`unexpected_db_write_${op}`);
  };
  return {
    calls,
    select: async (table, query) => {
      calls.push({ op: "select", table, query });
      if (table === "ordenes") return orders;
      if (table === "manual_giros") return manualGiros;
      return [];
    },
    insert: () => write("insert"),
    update: () => write("update"),
    delete: () => write("delete"),
    upsert: () => write("upsert"),
    sbInsert: () => write("sbInsert"),
    sbUpdate: () => write("sbUpdate"),
    sbDelete: () => write("sbDelete"),
  };
}

function hasBaseShape(snapshot) {
  return snapshot &&
    typeof snapshot.now === "string" &&
    Array.isArray(snapshot.orders) &&
    Array.isArray(snapshot.manual_giros) &&
    Object.prototype.hasOwnProperty.call(snapshot, "driver") &&
    Array.isArray(snapshot.driver_events) &&
    Object.prototype.hasOwnProperty.call(snapshot, "driver_status");
}

function hasNoPii(value) {
  return !/Persona Inventada|\+34000000000|Calle Falsa|wa_id|telefono|direccion|nombre|nota_cliente/i
    .test(JSON.stringify(value));
}

function queryHasNoPii(db) {
  return db.calls.every((call) => !/nombre|telefono|direccion|wa_id|nota_cliente|cliente/i.test(String(call.query || "")));
}

async function expectSafeMissingDbError() {
  try {
    await loadPlannerSnapshot({ now: "20:15" });
    return false;
  } catch (e) {
    const out = JSON.stringify({ message: e && e.message, code: e && e.code });
    return /db_client_missing|db_client_invalid|db.*missing|db.*invalid/i.test(out) &&
      !/\bat\s+\w+\s*\(|Error:|\.js:\d+/.test(out);
  }
}

async function main() {
  console.log("\n══ Module boundary ══");
  {
    check("loadPlannerSnapshot export exists", typeof loadPlannerSnapshot === "function");
  }

  console.log("\n══ Contract shape / deterministic now ══");
  {
    const db = writeGuardDb();
    const snapshot = await loadPlannerSnapshot({ db, date: "2026-06-07", now: "20:15" });
    check("base snapshot shape", hasBaseShape(snapshot), JSON.stringify(snapshot));
    check("deterministic now preserved", snapshot.now === "20:15", JSON.stringify(snapshot));
    check("orders array present", Array.isArray(snapshot.orders), JSON.stringify(snapshot));
    check("manual_giros array present", Array.isArray(snapshot.manual_giros), JSON.stringify(snapshot));
  }

  console.log("\n══ Read-only / no PII query guard ══");
  {
    const db = writeGuardDb();
    const snapshot = await loadPlannerSnapshot({ db, date: "2026-06-07", now: "20:15" });
    check("only select calls", db.calls.every((call) => call.op === "select"), JSON.stringify(db.calls));
    check("select fields do not request PII", queryHasNoPii(db), JSON.stringify(db.calls));
    check("snapshot output has no PII by default", hasNoPii(snapshot), JSON.stringify(snapshot));
  }

  console.log("\n══ Normalize orders / active filtering ══");
  {
    const snapshot = await loadPlannerSnapshot({
      db: writeGuardDb(),
      date: "2026-06-07",
      now: "20:15",
    });
    const d1 = snapshot.orders.find((order) => order.id === "#D1");
    check("durata_andata_min normalized to andata_min", d1 && d1.andata_min === 8, JSON.stringify(d1));
    check("items counted into n_pizze when missing", d1 && d1.n_pizze === 3, JSON.stringify(d1));
    check("manual_giro_id preserved", d1 && d1.manual_giro_id === "mg_1", JSON.stringify(d1));
    check("committed derived fields preserved for frozen/hard states",
      d1 &&
        d1.forno_out === "20:22" &&
        d1.salida_driver_estimada === "20:22" &&
        d1.entrega_estimada === "20:30" &&
        d1.retraso_estimado_min === 0 &&
        d1.conflicto_driver === false,
      JSON.stringify(d1));
    check("terminal states excluded",
      !snapshot.orders.some((order) => ["#TERM", "#CANCEL"].includes(order.id)),
      JSON.stringify(snapshot.orders));
  }

  console.log("\n══ Manual giros normalization ══");
  {
    const snapshot = await loadPlannerSnapshot({
      db: writeGuardDb(),
      date: "2026-06-07",
      now: "20:15",
    });
    const giro = snapshot.manual_giros.find((item) => item.id === "mg_1");
    check("manual giro id/type/order_ids preserved",
      giro && giro.type === "manual_route" && JSON.stringify(giro.order_ids) === JSON.stringify(["#D1"]),
      JSON.stringify(giro));
    check("manual route fields preserved",
      giro &&
        JSON.stringify(giro.route_order) === JSON.stringify(["#D1"]) &&
        giro.block_start === "20:20" &&
        giro.manual_duration_min === 18 &&
        giro.created_by_operator === true &&
        giro.force === true &&
        giro.hora_ref === "20:30",
      JSON.stringify(giro));
  }

  console.log("\n══ Planner-compatible shape / missing DB safe error ══");
  {
    const snapshot = await loadPlannerSnapshot({
      db: writeGuardDb(),
      date: "2026-06-07",
      now: "20:15",
    });
    check("planner can consume arrays", Array.isArray(snapshot.orders) && Array.isArray(snapshot.manual_giros));
    check("missing db throws safe controlled error", await expectSafeMissingDbError());
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
