// tests/v3GreenfieldBaseline.test.js -- offline guard of the V3 greenfield baseline (tip 138) and of the canonical deployment path.
// The behaviour on a real catalogue (empty PostgreSQL 17 -> baseline -> 139..156, catalog parity with staging tip 138, bootstrap) is
// certified in ~/Downloads/LA_DIECI_ECONOMY_FINAL_GREENFIELD_EVIDENCE_2026-09-27/. This file proves, without a database, that the committed
// baseline is exactly what the committed catalog generates, that both match the pin, and that neither carries business or staging data.
// Run: node tests/v3GreenfieldBaseline.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BL = require("../scripts/v3GreenfieldBaseline.js");
const TX = require("../scripts/lib/migrationTx.js");
const CA = require("../scripts/economyChainApply.js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); } }

const cat = BL.load(BL.CATALOG_DIR);
const text = read(BL.BASELINE_FILE);
const pin = JSON.parse(read("migrations/baseline/v3_greenfield_baseline_tip138.fingerprint.json"));
// Everything the file runs outside the byte-exact function bodies (section 4 of the generated file).
const topLevel = (() => { const b = TX.txBody(text, "baseline"); const i = b.indexOf("\n-- 4. functions"); const j = b.indexOf("\n-- 5. column defaults");
  if (i < 0 || j < i) throw new Error("baseline sections not found"); return (b.slice(0, i) + b.slice(j)).split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"); })();

console.log("\n── determinism + pin ──");
check("the committed baseline is byte-identical to generate(committed catalog)", BL.generate(cat) === text);
check("baseline sha256 = pin", sha(Buffer.from(text, "utf8")) === pin.baseline_sha256, pin.baseline_sha256);
check("catalog fingerprint = pin", BL.fingerprint(cat).sha256 === pin.catalog_fingerprint_sha256);
for (const f of ["functions.json", "structure.json", "extras.json"]) check(`catalog file ${f} sha256 = pin`, sha(fs.readFileSync(path.join(BL.CATALOG_DIR, f))) === pin.catalog_files_sha256[f]);
check("counts: 163 functions, 62 tables, 7 sequences, 3 publication members, 1 platform trigger",
  JSON.stringify(pin.counts) === JSON.stringify({ functions: 163, tables: 62, sequences: 7, publications: 3, platform_triggers: 1 }), JSON.stringify(pin.counts));
check("the catalog fingerprint is independent of JSON key order", BL.fingerprint(JSON.parse(JSON.stringify(cat, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)))).sha256 === pin.catalog_fingerprint_sha256);
check("the file is ONE transaction (exactly one BEGIN; / COMMIT;, nothing outside)", (() => { try { TX.txBody(text, "b"); return true; } catch (_) { return false; } })());
check("every function body of the catalog is pinned by md5 in the post-condition", cat.functions.every((f) => text.includes(`'${f.md5_prosrc}')`)));

console.log("\n── no business data, no staging value ──");
const uuids = [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || [])];
check("the only UUID literal is the nil sentinel", JSON.stringify(uuids) === JSON.stringify(["00000000-0000-0000-0000-000000000000"]), JSON.stringify(uuids));
check("no Supabase project reference", !/tdikhfeinufaahagmpjz|wnswassgfuuivmfwjxsf|supabase\.co/.test(text));
const inserts = topLevel.split("\n").filter((l) => /^INSERT INTO/.test(l));
check("top-level INSERTs: exactly the three singletons (defaults) and the DRIVER_STATO lock anchor ('{}')", JSON.stringify(inserts) === JSON.stringify([
  "INSERT INTO public.service_session_state (singleton) VALUES (true);", "INSERT INTO public.business_day_policy (singleton) VALUES (true);",
  "INSERT INTO public.business_day_lifecycle_state (singleton) VALUES (true);", "INSERT INTO public.config (chiave, valore) VALUES ('DRIVER_STATO', '{}');"]), JSON.stringify(inserts));
check("no workspace / actor / user / ledger / registry row in the baseline", !/^INSERT INTO (public\.)?(workspaces|auth_actors|user_profiles|workspace_memberships|ladieci_schema_migrations|restaurant_tables|menu_\w+)|supabase_migrations/m.test(topLevel));
check("the committed catalog carries no staging rows (no ledger / registry / row counts / default ACL sections)", !["ledger", "registry", "row_counts_structural", "default_acl"].some((k) => k in cat.structure));
check("the committed catalog publication list is limited to the application schemas", cat.structure.publications.every((p) => BL.SCHEMAS.includes(p.schema)));

console.log("\n── platform vs application ──");
check("the baseline never creates a platform object (roles, extensions, auth schema, publication, registry)", !/^\s*(CREATE (ROLE|EXTENSION|PUBLICATION)|CREATE SCHEMA (auth|extensions|supabase_migrations)|CREATE TABLE auth\.)/m.test(topLevel));
check("the baseline guard requires every PLATFORM_PREREQUISITE", ["extensions.pgcrypto", "API roles", "auth.users", "supabase_realtime", "REFERENCES + TRIGGER on auth.users", "BYPASSRLS"].every((k) => text.includes(k)));
check("the baseline refuses a non-greenfield database and a role other than postgres", /schema public is not empty or V3 schemas exist/.test(text) && /apply as role postgres/.test(text));
check("schema public (a platform object) is not re-granted or commented by the baseline", !/(GRANT|REVOKE) [A-Z, ]+ ON SCHEMA public|COMMENT ON SCHEMA public/.test(text));
check("the application trigger on the platform table auth.users is created", /CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth\.users FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user\(\);/.test(text));
check("gen_random_uuid() resolves to the core function (pg_catalog implicitly first)", /SET LOCAL search_path = public, extensions;/.test(text) && !/extensions\.gen_random_uuid/.test(topLevel));
const emu = read("ci/greenfield/supabase_platform_emulation.lab.sql");
check("the platform emulation is lab-only and declares it", /LAB EMULATION ONLY\. NEVER RUN ON A SUPABASE PROJECT/.test(emu) && !/emulation/i.test(topLevel));

console.log("\n── canonical deployment path ──");
check("plan: baseline -> 139 .. 148 -> GUARDED(149 + 150) -> 151 .. 156 -> business bootstrap", CA.PLAN.length === 19 && /GUARDED\(149 \+ 150\)/.test(CA.PLAN[10]) && /^151 /.test(CA.PLAN[12]) && /BUSINESS BOOTSTRAP/.test(CA.PLAN[18]));
const src = read("scripts/economyChainApply.js");
check("149 / 150 are only ever applied through the guarded step (never applyOne)", /if \(n === 149 \|\| n === 150\) \{\s*const r = await GS\.runForward/.test(src) && /if \(n === 150 \|\| n === 149\) \{\s*const r = await GS\.runRollback/.test(src));
check("every chain file has the one-transaction shape the runner needs", require("../scripts/economy139to146Preflight.js").CHAIN.every((c) => { try { TX.txBody(read("migrations/" + c.file), c.file); TX.txBody(read("migrations/" + c.file.replace(/\.sql$/, ".ROLLBACK.sql")), c.file); return true; } catch (_) { return false; } }));
check("the runner refuses the transaction pooler (port 6543)", (() => { try { TX.refuseTransactionPooler("postgres://u@h:6543/d"); return false; } catch (e) { return e.code === "POOLER"; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
