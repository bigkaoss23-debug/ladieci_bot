// S2-2D static proof for the close_rider_trip timestamptz-only hotfix.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label); }
}

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const original = read("migrations/2026-07-20_rider_trip_rpcs.sql");
const forward = read("migrations/2026-07-21_fix_rider_delivery_log_timestamps.sql");
const rollback = read("migrations/2026-07-21_fix_rider_delivery_log_timestamps.ROLLBACK.sql");
const originalHash = crypto.createHash("sha256").update(original).digest("hex");

function closeBlock(sql) {
  const match = sql.match(/CREATE OR REPLACE FUNCTION public\.close_rider_trip\([\s\S]*?\n\$\$;/);
  return match && match[0];
}

const oldBlock = closeBlock(original);
const newBlock = closeBlock(forward);
const rollbackBlock = closeBlock(rollback);
const normalizeLogic = (sql) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
const expectedNew = oldBlock
  .replace("    (v_active->>'started_at'),", "    NULLIF(v_active->>'started_at', '')::timestamptz,")
  .replace("    to_char(v_now, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),\n    to_char(v_now, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')", "    v_now,\n    v_now");

check("original applied migration remains byte-identical", originalHash === "450c5d75edf210b8f6822587e71f1ce4b0a5aedc6ec8ca8a7436562b6ee54bb1");
check("forward replaces only close_rider_trip(text)", (forward.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 1 && !!newBlock);
check("forward differs from accepted close only by three timestamp expressions", normalizeLogic(newBlock) === normalizeLogic(expectedNew));
check("partito_alle explicitly casts non-empty JSON ISO timestamp", /NULLIF\(v_active->>'started_at', ''\)::timestamptz/.test(newBlock));
check("ultimo_entregado and rientro_stimato receive native timestamptz", /NULLIF[\s\S]*::timestamptz,\s*v_now,\s*v_now\s*\)/.test(newBlock));
check("delivery log values contain no to_char", !/INSERT INTO public\.delivery_logs[\s\S]*?VALUES[\s\S]*?to_char/.test(newBlock));
check("security contract retained", /SECURITY INVOKER/.test(newBlock) && /SET search_path = public, pg_temp/.test(newBlock));
check("advisory transaction lock retained", /pg_advisory_xact_lock\(hashtext\('LA_DIECI_DRIVER_STATO'\)\)/.test(newBlock));
check("forward restores service-role-only execute", /REVOKE EXECUTE ON FUNCTION public\.close_rider_trip\(text\) FROM PUBLIC, anon, authenticated/.test(forward) && /GRANT EXECUTE ON FUNCTION public\.close_rider_trip\(text\) TO service_role/.test(forward));
check("rollback restores exact accepted close definition", rollbackBlock === oldBlock);
check("rollback uses exact signature and explicit transaction", /^\s*BEGIN;/m.test(rollback) && /COMMIT;\s*$/.test(rollback) && /close_rider_trip\(text\)/.test(rollback));
check("no other rider RPC is modified", !/start_rider_trip|complete_rider_stop|begin_service_close_if_idle|end_service_close|delete_order_if_not_active|delete_conversation_if_not_active/.test(forward + rollback));
check("no financial mutation introduced", !/pagado|ya_pagado|totale|descuento|financial|ledger|refund|void/i.test(newBlock));

console.log(`\nriderDeliveryLogTimestampHotfixMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
