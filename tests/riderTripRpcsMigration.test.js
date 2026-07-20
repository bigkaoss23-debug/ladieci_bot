// tests/riderTripRpcsMigration.test.js — S2-1B static migration assertions (no SQL run).
// Run: node tests/riderTripRpcsMigration.test.js
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

const dir = path.join(__dirname, "..", "migrations");
const stripComments = (s) => s.replace(/--.*$/gm, "");
const fwd = stripComments(fs.readFileSync(path.join(dir, "2026-07-20_rider_trip_rpcs.sql"), "utf8"));
const rb = stripComments(fs.readFileSync(path.join(dir, "2026-07-20_rider_trip_rpcs.ROLLBACK.sql"), "utf8"));

check("wrapped in one transaction", /^\s*BEGIN;/m.test(fwd) && /COMMIT;\s*$/m.test(fwd));
for (const fn of ["start_rider_trip(p_anchor_order_id text)", "complete_rider_stop(", "close_rider_trip()"]) {
  check("defines " + fn, fwd.includes("CREATE OR REPLACE FUNCTION public." + fn.split("(")[0].replace("public.", "")) && fwd.includes(fn.split(" ")[0]));
}
check("all functions SECURITY INVOKER (x3)", (fwd.match(/SECURITY INVOKER/g) || []).length === 3);
check("all functions fixed search_path (x3)", (fwd.match(/SET search_path = public, pg_temp/g) || []).length === 3);
check("advisory lock in every function (x3)", (fwd.match(/pg_advisory_xact_lock\(hashtext\('LA_DIECI_DRIVER_STATO'\)\)/g) || []).length === 3);
check("bootstraps missing DRIVER_STATO row", /INSERT INTO public\.config\(chiave, valore\)[\s\S]*ON CONFLICT \(chiave\) DO NOTHING/.test(fwd));
check("locks config row FOR UPDATE", /FROM public\.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE/.test(fwd));
check("schema-qualifies ordenes/manual_giros/config", /public\.ordenes/.test(fwd) && /public\.manual_giros/.test(fwd) && /public\.config/.test(fwd));
check("uses gen_random_uuid for trip_id", /gen_random_uuid\(\)/.test(fwd));
// Privilege hardening — do not rely on default PUBLIC EXECUTE.
check("REVOKE EXECUTE FROM PUBLIC/anon/authenticated (x3)", (fwd.match(/REVOKE EXECUTE ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated/g) || []).length === 3);
check("GRANT EXECUTE TO service_role (x3)", (fwd.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g) || []).length === 3);
check("grants/revokes use exact signatures", /start_rider_trip\(text\)/.test(fwd) && /complete_rider_stop\(text, boolean, text\)/.test(fwd) && /close_rider_trip\(\)/.test(fwd));
// Financial invariant: completion writes only operational columns.
const compBody = fwd.slice(fwd.indexOf("complete_rider_stop"), fwd.indexOf("close_rider_trip"));
check("completion never writes pagado/ya_pagado/total/descuento/ledger",
  !/pagado|ya_pagado|totale|total|descuento|financial|ledger|refund|void/i.test(compBody.replace(/--.*$/gm, "")));
check("completion sets only estado/hora_entrega/cobrado/metodo_pago",
  /SET estado[\s\S]*hora_entrega[\s\S]*cobrado[\s\S]*metodo_pago/.test(compBody));
check("no PII columns in snapshot (no nombre/tel/direccion/items)",
  !/nombre|tel\b|telefono|direccion|items/i.test(fwd.replace(/--.*$/gm, "")));
// Rollback drops exact signatures.
check("rollback drops exact signatures", /DROP FUNCTION IF EXISTS public\.start_rider_trip\(text\)/.test(rb) && /public\.complete_rider_stop\(text, boolean, text\)/.test(rb) && /public\.close_rider_trip\(\)/.test(rb));
check("no CREATE POLICY / no new table", !/CREATE POLICY/.test(fwd) && !/CREATE TABLE/i.test(fwd));

// ── S2-1C line-by-line contract review assertions ──
check("config.valore text<->jsonb conversion", /NULLIF\(valore,''\)::jsonb/.test(fwd) && /valore = v_ds::text/.test(fwd));
check("manual-giro grouping query", /WHERE manual_giro_id = v_giro\s+AND estado IN \('LISTO','EN_ENTREGA'\)/.test(fwd));
check("standalone anchor fallback", /v_order_ids := ARRAY\[p_anchor_order_id\]/.test(fwd));
check("idempotent same-member start", /v_active->'order_ids' \? p_anchor_order_id/.test(fwd));
check("different active trip conflict", /ACTIVE_TRIP_CONFLICT/.test(fwd));
check("all members transitioned in one UPDATE (id = ANY)", /UPDATE public\.ordenes[\s\S]*?WHERE id = ANY\(v_order_ids\) AND estado = 'LISTO'/.test(fwd));
check("completion membership check", /v_active->'order_ids' \? p_order_id/.test(fwd));
check("close verifies all snapshot orders terminal", /estado NOT IN \('RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','ANULADO'\)/.test(fwd));
check("early close returns EARLY_CLOSE", /EARLY_CLOSE/.test(fwd));
check("idempotent duplicate close returns last_closed_trip w/o new write", /last_closed_trip[\s\S]*?IDEMPOTENT/.test(fwd));
check("no swallowed EXCEPTION that could commit partial work", !/EXCEPTION\s+WHEN/i.test(fwd));
check("column types honored (bigint epoch ms for hora_*)", /hora_salida = \(extract\(epoch FROM v_now\) \* 1000\)::bigint/.test(fwd) && /hora_entrega = \(extract\(epoch FROM now\(\)\) \* 1000\)::bigint/.test(fwd));

console.log(`\nriderTripRpcsMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
