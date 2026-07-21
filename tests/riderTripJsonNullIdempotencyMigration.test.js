// S2-2E static contract proof; runtime behavior is exercised in staging smoke.
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
const check = (label, ok) => { ok ? (pass++, console.log("  ✓ " + label)) : (fail++, console.log("  ✗ " + label)); };
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const fwd = read("migrations/2026-07-21_fix_rider_trip_json_null_idempotency.sql");
const rb = read("migrations/2026-07-21_fix_rider_trip_json_null_idempotency.ROLLBACK.sql");
const ts = read("migrations/2026-07-21_fix_rider_delivery_log_timestamps.sql");

check("replaces exactly three vulnerable RPCs", (fwd.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 3 && /complete_rider_stop/.test(fwd) && /close_rider_trip/.test(fwd) && /end_service_close/.test(fwd));
check("active_trip JSON null normalized in completion and close", (fwd.match(/NULLIF\(v_ds->'active_trip', 'null'::jsonb\)/g) || []).length === 2);
check("service_closing JSON null normalized", /v_marker := NULLIF\(v_ds->'service_closing', 'null'::jsonb\)/.test(fwd));
check("completion rejects absent or malformed active trip", /v_active IS NULL OR jsonb_typeof\(v_active\) <> 'object'[\s\S]*NO_ACTIVE_TRIP/.test(fwd));
check("close preserves valid-history idempotency", /v_active IS NULL[\s\S]*last_closed_trip[\s\S]*IDEMPOTENT/.test(fwd));
check("close without history preserves NO_ACTIVE_TRIP", /last_closed_trip[\s\S]*IDEMPOTENT[\s\S]*NO_ACTIVE_TRIP/.test(fwd));
check("close remains single-log authority", (fwd.match(/INSERT INTO public\.delivery_logs/g) || []).length === 1);
check("timestamp hotfix retained", /NULLIF\(v_active->>'started_at', ''\)::timestamptz,\s*v_now,\s*v_now/.test(fwd) && !/to_char/.test(fwd));
check("rollback retains timestamp hotfix", /NULLIF\(v_active->>'started_at', ''\)::timestamptz,\s*v_now,\s*v_now/.test(rb) && !/to_char/.test(rb));
check("rollback restores pre-S2-2E close exactly", rb.includes(ts.match(/CREATE OR REPLACE FUNCTION public\.close_rider_trip[\s\S]*?\n\$\$;/)[0]));
check("security settings retained x3", (fwd.match(/SECURITY INVOKER/g) || []).length === 3 && (fwd.match(/SET search_path = public, pg_temp/g) || []).length === 3 && (fwd.match(/pg_advisory_xact_lock/g) || []).length === 3);
check("service-role-only privileges restored x3", (fwd.match(/FROM PUBLIC, anon, authenticated/g) || []).length === 3 && (fwd.match(/TO service_role/g) || []).length === 3);
check("no financial mutation", !/pagado|ya_pagado|totale|descuento|financial|ledger|refund|void/i.test(fwd.replace(/--.*$/gm, "")));

console.log(`\nriderTripJsonNullIdempotencyMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
