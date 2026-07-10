// tests/readActions.test.js — private authenticated READ contracts (P0)
// Verifies each fixed read action: table, filters, ordering, max page size,
// param validation (400) and controlled read failure (500). ./supabase is
// stubbed via require.cache (same pattern as manualGiros.test.js).

const assert = require("assert");

// Capture every query the module emits so we can assert the fixed contract.
const observed = [];
let failNext = false; // simulate a backend read failure

const supabasePath = require.resolve("../src/utils/supabase");
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    sbSelect: async (table, query) => {
      observed.push({ table, query });
      if (failNext) { failNext = false; throw new Error("boom"); }
      // Return a deterministic marker row echoing what was queried.
      return [{ _table: table, _query: query }];
    },
    sbUpsert: async () => [], sbUpdate: async () => [],
    sbInsert: async () => [], sbDelete: async () => [], getConfig: async () => ({}),
  },
};

const R = require("../src/utils/readActions");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
function last() { return observed[observed.length - 1]; }
async function expectParamError(fn, label) {
  try { await fn(); check(label + " → throws", false, "(no throw)"); }
  catch (e) { check(label + " → 400", e.name === "ReadParamError" && e.httpStatus === 400, e.name); }
}

(async () => {
  console.log("\n── Fixed contracts: table / filter / order / limit ──");
  await R.getOrdenesRecent();
  check("getOrdenesRecent → ordenes, ts.desc, limit 100",
    last().table === "ordenes" && /order=ts\.desc/.test(last().query) && /limit=100/.test(last().query) && /ts=gte\./.test(last().query));

  await R.getWaMessages();
  check("getWaMessages → wa_msgs, ts.desc, limit 100",
    last().table === "wa_msgs" && /order=ts\.desc/.test(last().query) && /limit=100/.test(last().query));

  await R.getStorico();
  check("getStorico default → storico, ts.desc, limit 500 (no fecha)",
    last().table === "storico" && /order=ts\.desc/.test(last().query) && /limit=500/.test(last().query) && !/fecha=/.test(last().query));

  await R.getStorico({ fecha: "2026-07-10", limit: 200 });
  check("getStorico with fecha+limit → filtered",
    /fecha=eq\.2026-07-10/.test(last().query) && /limit=200/.test(last().query));

  await R.getStorico({ limit: 99999 });
  check("getStorico limit clamped to 500 max", /limit=500/.test(last().query), last().query);

  await R.getOrdenesArchivio();
  check("getOrdenesArchivio → estado in (COMPLETADO,RETIRADO), limit 500",
    last().table === "ordenes" && /estado=in\.\(COMPLETADO,RETIRADO\)/.test(last().query) && /limit=500/.test(last().query));

  await R.getDeliveryLogs();
  check("getDeliveryLogs → delivery_logs, partito_alle.desc",
    last().table === "delivery_logs" && /order=partito_alle\.desc/.test(last().query));

  await R.getSuggerimenti();
  check("getSuggerimenti → suggerimenti, stato=pending",
    last().table === "suggerimenti" && /stato=eq\.pending/.test(last().query));

  await R.getConversacionesActivas();
  check("getConversacionesActivas → conv, stato_ordine=confermata",
    last().table === "conv" && /stato_ordine=eq\.confermata/.test(last().query));

  console.log("\n── Single-row lookups + param validation ──");
  const c = await R.getClienteByTelefono({ telefono: "+34600111222" });
  check("getClienteByTelefono → clientes tel=eq (stripped +)",
    last().table === "clientes" && /tel=eq\.34600111222/.test(last().query) && c && c._table === "clientes");
  await expectParamError(() => R.getClienteByTelefono({ telefono: "abc" }), "clientes bad telefono");
  await expectParamError(() => R.getClienteByTelefono({ telefono: "1;drop" }), "clientes injection telefono");

  await R.getOrdenById({ id: "#001" });
  check("getOrdenById → ordenes id=eq", last().table === "ordenes" && /id=eq\.%23001/.test(last().query));
  await expectParamError(() => R.getOrdenById({ id: 'x=1&y' }), "ordenById metachars");
  await expectParamError(() => R.getWaMessageById({ id: 'a,b' }), "waMsgById comma");

  await R.getConvByWaId({ wa_id: "34600111222" });
  check("getConvByWaId → conv wa_id=eq order ts.desc limit 1",
    last().table === "conv" && /wa_id=eq\.34600111222/.test(last().query) && /order=ts\.desc/.test(last().query) && /limit=1/.test(last().query));

  console.log("\n── Batch getConvChats (CSV or array) + validation ──");
  await R.getConvChats({ wa_ids: "34600111222,34600333444" });
  check("getConvChats CSV → conv wa_id in(...) select wa_id,chat",
    last().table === "conv" && /wa_id=in\.\("34600111222","34600333444"\)/.test(last().query) && /select=wa_id,chat/.test(last().query));
  const empty = await R.getConvChats({ wa_ids: "" });
  check("getConvChats empty → [] (no query)", Array.isArray(empty) && empty.length === 0);
  await expectParamError(() => R.getConvChats({ wa_ids: "34600111222,bad-id" }), "convChats bad id in list");
  await expectParamError(() => R.getConvChats({ wa_ids: Array(201).fill("34600111222") }), "convChats too many");

  console.log("\n── Controlled backend read failure → 500 ──");
  failNext = true;
  try { await R.getStorico(); check("read failure → throws ReadBackendError 500", false, "(no throw)"); }
  catch (e) { check("read failure → ReadBackendError 500", e.name === "ReadBackendError" && e.httpStatus === 500 && e.message === "read failed", e.name + ":" + e.message); }

  console.log("\n── No arbitrary-table access exposed ──");
  const errorClasses = ["ReadParamError", "ReadBackendError"];
  const actionExports = Object.keys(R).filter(k => !errorClasses.includes(k));
  check("every exposed action is a fixed get* domain action (no generic query fn)",
    actionExports.length > 0 && actionExports.every(k => /^get[A-Z]/.test(k)),
    actionExports.join(","));

  console.log(`\n${fail === 0 ? "✅" : "❌"} readActions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
