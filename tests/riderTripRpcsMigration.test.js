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
for (const fn of ["start_rider_trip(p_anchor_order_id text)", "complete_rider_stop(", "close_rider_trip(p_trigger_order_id text DEFAULT NULL)"]) {
  check("defines " + fn, fwd.includes("CREATE OR REPLACE FUNCTION public." + fn.split("(")[0].replace("public.", "")) && fwd.includes(fn.split(" ")[0]));
}
check("all functions SECURITY INVOKER (x7)", (fwd.match(/SECURITY INVOKER/g) || []).length === 7);
check("all functions fixed search_path (x7)", (fwd.match(/SET search_path = public, pg_temp/g) || []).length === 7);
check("advisory lock in every function (x7)", (fwd.match(/pg_advisory_xact_lock\(hashtext\('LA_DIECI_DRIVER_STATO'\)\)/g) || []).length === 7);
check("bootstraps missing DRIVER_STATO row", /INSERT INTO public\.config\(chiave, valore\)[\s\S]*ON CONFLICT \(chiave\) DO NOTHING/.test(fwd));
check("locks config row FOR UPDATE", /FROM public\.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE/.test(fwd));
check("schema-qualifies ordenes/manual_giros/config", /public\.ordenes/.test(fwd) && /public\.manual_giros/.test(fwd) && /public\.config/.test(fwd));
check("uses gen_random_uuid for trip_id", /gen_random_uuid\(\)/.test(fwd));
// Privilege hardening — do not rely on default PUBLIC EXECUTE.
check("REVOKE EXECUTE FROM PUBLIC/anon/authenticated (x7)", (fwd.match(/REVOKE EXECUTE ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated/g) || []).length === 7);
check("GRANT EXECUTE TO service_role (x7)", (fwd.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g) || []).length === 7);
check("grants/revokes use exact signatures", /start_rider_trip\(text\)/.test(fwd) && /complete_rider_stop\(text, boolean, text\)/.test(fwd) && /close_rider_trip\(text\)/.test(fwd) && /begin_service_close_if_idle\(text, text\)/.test(fwd) && /end_service_close\(text\)/.test(fwd) && /delete_order_if_not_active\(text\)/.test(fwd) && /delete_conversation_if_not_active\(text\)/.test(fwd));
// S2-1G — cardinality, delete guard, service-close race.
check("close enforces snapshot row cardinality (MISSING_TRIP_MEMBER)", /v_found <> v_raw_count[\s\S]{0,80}MISSING_TRIP_MEMBER/.test(fwd));
check("close validates duplicate snapshot ids", /v_raw_count <> v_distinct_count[\s\S]{0,120}INVALID_TRIP_SNAPSHOT/.test(fwd));
check("close validates active_trip.n_orders", /v_snapshot_count <> v_raw_count[\s\S]{0,120}INVALID_TRIP_SNAPSHOT/.test(fwd));
check("close counts missing rows after structure validation", /SELECT count\(\*\) INTO v_found FROM public\.ordenes WHERE id = ANY\(v_order_ids\);[\s\S]{0,140}MISSING_TRIP_MEMBER/.test(fwd));
check("delete guard refuses active member", /delete_order_if_not_active[\s\S]*?ACTIVE_TRIP_MEMBER_CONFLICT/.test(fwd));
check("delete guard membership+delete in one txn (lock)", /delete_order_if_not_active[\s\S]*?pg_advisory_xact_lock[\s\S]*?DELETE FROM public\.ordenes WHERE id = p_order_id/.test(fwd));
check("conversation delete guard refuses any active wa_id member", /delete_conversation_if_not_active[\s\S]*?unnest\(v_order_ids\)[\s\S]*?ACTIVE_TRIP_MEMBER_CONFLICT/.test(fwd));
check("conversation delete keeps legacy delete set", /DELETE FROM public\.conv WHERE wa_id = p_wa_id[\s\S]*DELETE FROM public\.wa_msgs WHERE wa_id = p_wa_id[\s\S]*DELETE FROM public\.ordenes WHERE wa_id = p_wa_id/.test(fwd));
check("start rejects during any service_closing marker", /IF v_ds \? 'service_closing'[\s\S]{0,120}SERVICE_CLOSING/.test(fwd));
check("service_closing has no timeout reopen", !/30 minutes|service_closing_at|interval/.test(fwd));
check("begin gate sets structured service_closing marker", /'close_id'[\s\S]*'service_date'[\s\S]*'started_at'[\s\S]*'source'[\s\S]*'phase'/.test(fwd) && /'service_closing',\s*v_marker/.test(fwd));
check("begin resumes existing close_id", /v_marker IS NOT NULL[\s\S]*'resumed', true/.test(fwd));
check("end_service_close clears only matching marker", /COALESCE\(v_ds->'service_closing'->>'close_id'[\s\S]*SERVICE_CLOSE_ID_MISMATCH[\s\S]*v_ds := v_ds - 'service_closing'/.test(fwd));
// S2-1E — begin_service_close_if_idle: idle-only lifecycle reset.
check("defines begin_service_close_if_idle", /CREATE OR REPLACE FUNCTION public\.begin_service_close_if_idle\(\s*p_service_date text DEFAULT NULL,\s*p_source\s+text DEFAULT 'backend'/.test(fwd));
check("reset refuses active trip (conflict)", /begin_service_close_if_idle[\s\S]*?ACTIVE_TRIP_CONFLICT/.test(fwd));
const beginBody = fwd.slice(fwd.indexOf("FUNCTION public.begin_service_close_if_idle"), fwd.indexOf("FUNCTION public.end_service_close"));
check("reset preserves trip_seq / last_closed_trip (no deletion)",
  /NOT \(v_ds \? 'trip_seq'\)/.test(beginBody) &&
  !/(DELETE FROM|last_closed_trip'\s*,\s*'null)/.test(beginBody));
check("close reconciliation non-member no-op", /NON_MEMBER_NOOP/.test(fwd) && /NOT \(v_active->'order_ids' \? p_trigger_order_id\)/.test(fwd));
check("close signature carries optional trigger", /close_rider_trip\(p_trigger_order_id text DEFAULT NULL\)/.test(fwd));
check("rollback drops reset + close(text)", /begin_service_close_if_idle\(text, text\)/.test(rb) && /close_rider_trip\(text\)/.test(rb));
// Financial invariant: completion writes only operational columns.
const compBody = fwd.slice(fwd.indexOf("complete_rider_stop"), fwd.indexOf("close_rider_trip"));
check("completion never writes pagado/ya_pagado/total/descuento/ledger",
  !/pagado|ya_pagado|totale|total|descuento|financial|ledger|refund|void/i.test(compBody.replace(/--.*$/gm, "")));
check("completion sets only estado/hora_entrega/cobrado/metodo_pago",
  /SET estado[\s\S]*hora_entrega[\s\S]*cobrado[\s\S]*metodo_pago/.test(compBody));
check("no PII columns in snapshot (no nombre/tel/direccion/items)",
  !/nombre|tel\b|telefono|direccion|items/i.test(fwd.replace(/--.*$/gm, "")));
// Rollback drops exact signatures.
check("rollback drops exact signatures", /DROP FUNCTION IF EXISTS public\.start_rider_trip\(text\)/.test(rb) && /public\.complete_rider_stop\(text, boolean, text\)/.test(rb) && /public\.close_rider_trip\(text\)/.test(rb));
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
check("close checks ONLY snapshot members (next-trip orders ignored)", /WHERE id = ANY\(v_order_ids\)\s+AND estado NOT IN/.test(fwd));
check("early close returns EARLY_CLOSE", /EARLY_CLOSE/.test(fwd));
check("idempotent duplicate close returns last_closed_trip w/o new write", /last_closed_trip[\s\S]*?IDEMPOTENT/.test(fwd));
check("no swallowed EXCEPTION that could commit partial work", !/EXCEPTION\s+WHEN/i.test(fwd));
check("column types honored (bigint epoch ms for hora_*)", /hora_salida = \(extract\(epoch FROM v_now\) \* 1000\)::bigint/.test(fwd) && /hora_entrega = \(extract\(epoch FROM now\(\)\) \* 1000\)::bigint/.test(fwd));

console.log(`\nriderTripRpcsMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
