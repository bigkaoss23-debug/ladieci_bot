// tests/legacyImportInertness.static.test.js -- the legacy import contract (docs/LEGACY_IMPORT_CONTRACT.md), statically.
// Historical / imported data must be economically and fiscally inert. The dynamic proof (economic fingerprint unchanged, Pendientes /
// Economia / Caja unchanged, first V3 service closes on V3 facts only, archive immutable and unexposed) is the cutover dry-run evidence;
// this file pins the structural guarantees in the repository.
// Run: node tests/legacyImportInertness.static.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const LI = require("../scripts/cutover/legacyImport.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); } }
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));

console.log("\n── Z9 / Z10: no V3 reader (economic, closeout, financial, fiscal, any runtime code) touches the legacy domains ──");
const runtime = [...walk("src"), "index.js"];
const offenders = runtime.filter((f) => /legacy_archive|commercial_history/.test(read(f)));
check(`no runtime file names legacy_archive / commercial_history (${runtime.length} files scanned)`, offenders.length === 0, offenders.join(", "));
const baseline = read("migrations/baseline/2026-09-27_v3_greenfield_baseline_tip138.sql");
check("the V3 schema baseline knows nothing of the legacy domains", !/legacy_archive|commercial_history/.test(baseline));
const chain = require("../scripts/economy139to146Preflight.js").CHAIN;
check("no Economy chain migration names the legacy domains", chain.every((c) => !/legacy_archive|commercial_history/.test(read("migrations/" + c.file))));

console.log("\n── the archive schema: inert, append-only, unexposed ──");
const sql = read("cutover/legacy_archive_v1.sql");
const refs = [...sql.matchAll(/REFERENCES\s+([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]);
check("every foreign key stays inside legacy_archive (none into ordenes / order_* / payment_* / service_* / storico / cash_counts)", refs.every((r) => r.startsWith("legacy_archive.")), refs.join(", "));
check("no trigger on any public (V3) table", !/CREATE TRIGGER[^;]*\sON\s+public\./i.test(sql));
check("append-only at statement level (UPDATE / DELETE / TRUNCATE, even on zero rows)", /BEFORE UPDATE OR DELETE OR TRUNCATE ON %I\.%I FOR EACH STATEMENT/.test(sql));
check("nothing granted to anon / authenticated / service_role; both schemas revoked", !/GRANT[^;]*\b(anon|authenticated|service_role)\b/.test(sql) && /REVOKE ALL ON SCHEMA legacy_archive, commercial_history FROM PUBLIC, anon, authenticated, service_role/.test(sql));
check("commercial history carries no payment status and no V3 key", !/(cobrado|ya_pagado|metodo_pago|order_uid|service_session_id)/.test(sql.slice(sql.indexOf("CREATE TABLE commercial_history.customer_orders"), sql.indexOf("CREATE TABLE commercial_history.customer_stats"))));
check("legacy amounts are declared / informational, never obligations", /declared_total/.test(sql) && /informational_total numeric/.test(sql) && !/obligation/.test(sql.replace(/NEVER an obligation or a receipt/, "")));
check("the archive schema refuses a database that is not at Economy 156", /the V3 database must be at POST_APPLY/.test(sql));

console.log("\n── the importer: the only V3 tables it writes are public.clientes and public.geo_cache ──");
const imp = read("scripts/cutover/legacyImport.js");
const writes = [...imp.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]);
check("public writes = { public.clientes, public.geo_cache }", JSON.stringify([...new Set(writes)].sort()) === JSON.stringify(["public.clientes", "public.geo_cache"]), JSON.stringify([...new Set(writes)]));
check("never writes ordenes / storico / order_* / payment_* / service_* / cash_counts / orden_estado_logs / auth_* / config", !/(INSERT INTO|UPDATE|DELETE FROM)\s+(public\.)?(ordenes|storico|order_\w+|payment_\w+|service_\w+|cash_counts|orden_estado_logs|auth_\w+|config)\b/.test(imp));
check("the legacy database is read in ONE read-only snapshot", /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/.test(imp));
check("values are archived as PostgreSQL renders them (to_jsonb), never re-typed by the driver", /SELECT to_jsonb\(x\) AS j FROM public\./.test(imp));
check("the final delta refuses a legacy database with open orders", /REFUSED_LEGACY_NOT_FROZEN/.test(imp));
for (const k of ["ANTHROPIC_KEY", "WA_ACCESS_TOKEN", "APP_PIN", "REPARTIDOR_PIN"]) check(`secret config key ${k} is redacted, never archived in clear`, LI.SECRET_KEY_RE.test(k));
check("a harmless config key is kept", !LI.SECRET_KEY_RE.test("PIZZERIA_NOME") && !LI.SECRET_KEY_RE.test("TEMPO_EST_MIN"));

console.log("\n── phone identity: the V3 form (international digits, no '+'), as the backend looks customers up ──");
for (const [raw, want] of [["612 34 56 78", "34612345678"], ["+34 612345678", "34612345678"], ["0034612345678", "34612345678"], ["34612345678", "34612345678"], ["612-345-678", "34612345678"], ["+44 7700 900123", "447700900123"]]) {
  const r = LI.normalizeTel(raw); check(`${JSON.stringify(raw)} -> ${want}`, r.ok && r.tel === want, JSON.stringify(r));
}
for (const raw of ["", "612", "34512345678", "abc"]) check(`${JSON.stringify(raw)} refused`, !LI.normalizeTel(raw).ok);
check("the backend looks customers up by that form (agentWhatsapp getCliente strips '+')", /sbSelect\("clientes", `tel=eq\.\$\{String\(tel\)\.replace\("\+", ""\)\}`\)/.test(read("src/agents/agentWhatsapp.js")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
