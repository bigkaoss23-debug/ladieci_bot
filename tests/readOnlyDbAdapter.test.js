// tests/readOnlyDbAdapter.test.js
// ===============================================================
// READ-ONLY DB ADAPTER — offline tests
// Run: node tests/readOnlyDbAdapter.test.js
// ===============================================================
"use strict";

const { createReadOnlyDbAdapter } = require("../src/core/delivery/readOnlyDbAdapter");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

function fakeSupabase({ data = [], error = null } = {}) {
  const calls = [];
  function builder(table) {
    const state = { table, fields: null, filters: [], order: null, limit: null };
    calls.push(state);
    const chain = {
      select(fields) {
        state.fields = fields;
        return chain;
      },
      eq(field, value) {
        state.filters.push({ op: "eq", field, value });
        return chain;
      },
      neq(field, value) {
        state.filters.push({ op: "neq", field, value });
        return chain;
      },
      in(field, values) {
        state.filters.push({ op: "in", field, values });
        return chain;
      },
      order(field, opts) {
        state.order = { field, opts };
        return chain;
      },
      limit(value) {
        state.limit = value;
        return Promise.resolve(error ? { data: null, error } : { data, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve(error ? { data: null, error } : { data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  return {
    calls,
    from(table) {
      return builder(table);
    },
  };
}

function hasNoStacktraceOrSecret(value) {
  return !/\bat\s+\w+\s*\(|Error:|\.js:\d+|SUPABASE_KEY|secret value|apikey/i.test(JSON.stringify(value));
}

async function expectSafeError(fn, codePattern) {
  try {
    await fn();
    return false;
  } catch (e) {
    const out = JSON.stringify({ code: e && e.code, message: e && e.message });
    return codePattern.test(out) && hasNoStacktraceOrSecret(out);
  }
}

async function main() {
  console.log("\n══ Shape / write surface ══");
  {
    const adapter = createReadOnlyDbAdapter({ supabase: fakeSupabase() });
    check("adapter exposes select", typeof adapter.select === "function");
    check("adapter exposes only select", Object.keys(adapter).join(",") === "select", Object.keys(adapter).join(","));
    check("no write methods exposed",
      !["insert", "update", "delete", "upsert", "sbInsert", "sbUpdate", "sbDelete"].some((key) => key in adapter));
  }

  console.log("\n══ Ordenes safe select ══");
  {
    const supabase = fakeSupabase({ data: [{ id: "#1" }] });
    const adapter = createReadOnlyDbAdapter({ supabase });
    const rows = await adapter.select("ordenes", {
      fields: ["id", "tipo_consegna", "estado", "zona", "hora", "durata_andata_min"],
      eq: { tipo_consegna: "DOMICILIO" },
      neq: { estado: "RETIRADO" },
      limit: 50,
      order: { field: "created_at", ascending: true },
    });
    check("returns rows array", Array.isArray(rows) && rows[0].id === "#1", JSON.stringify(rows));
    check("from ordenes", supabase.calls[0].table === "ordenes", JSON.stringify(supabase.calls));
    check("safe fields selected",
      supabase.calls[0].fields === "id,tipo_consegna,estado,zona,hora,durata_andata_min",
      JSON.stringify(supabase.calls[0]));
    check("filters/order/limit applied",
      supabase.calls[0].filters.length === 2 &&
        supabase.calls[0].order.field === "created_at" &&
        supabase.calls[0].limit === 50,
      JSON.stringify(supabase.calls[0]));
  }

  console.log("\n══ Manual giros safe select ══");
  {
    const supabase = fakeSupabase({ data: [{ id: "mg_1" }] });
    const adapter = createReadOnlyDbAdapter({ supabase });
    const rows = await adapter.select("manual_giros", {
      fields: ["id", "type", "order_ids", "route_order", "block_start", "manual_duration_min", "created_by_operator", "force", "hora_ref"],
      in: { id: ["mg_1"] },
      limit: 10,
    });
    check("manual_giros returns rows", rows.length === 1 && rows[0].id === "mg_1", JSON.stringify(rows));
    check("manual_giros safe fields selected", !/nombre|telefono|direccion|wa_id/i.test(supabase.calls[0].fields), JSON.stringify(supabase.calls[0]));
  }

  console.log("\n══ Allowlist guards / safe errors ══");
  {
    const adapter = createReadOnlyDbAdapter({ supabase: fakeSupabase() });
    check("blocks unknown table",
      await expectSafeError(() => adapter.select("clientes", { fields: ["id"] }), /table_not_allowed/));
    check("blocks PII fields",
      await expectSafeError(() => adapter.select("ordenes", { fields: ["id", "nombre", "telefono", "direccion", "wa_id"] }), /field_not_allowed/));
    check("missing supabase safe error",
      await expectSafeError(() => createReadOnlyDbAdapter().select("ordenes", { fields: ["id"] }), /supabase_client_missing/));
    check("supabase error safe",
      await expectSafeError(
        () => createReadOnlyDbAdapter({ supabase: fakeSupabase({ error: { message: "boom with secret SUPABASE_KEY" } }) })
          .select("ordenes", { fields: ["id"] }),
        /db_select_failed/
      ));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNEXPECTED TEST ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
