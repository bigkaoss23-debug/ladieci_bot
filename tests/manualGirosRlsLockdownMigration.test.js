// tests/manualGirosRlsLockdownMigration.test.js — S2-1B static assertions (no SQL run).
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }
const dir = path.join(__dirname, "..", "migrations");
const strip = (s) => s.replace(/--.*$/gm, "");
const fwd = strip(fs.readFileSync(path.join(dir, "2026-07-20_manual_giros_rls_lockdown.sql"), "utf8"));
const rb = strip(fs.readFileSync(path.join(dir, "2026-07-20_manual_giros_rls_lockdown.ROLLBACK.sql"), "utf8"));

check("wrapped in transaction", /BEGIN;/.test(fwd) && /COMMIT;/.test(fwd));
check("enables RLS", /ALTER TABLE public\.manual_giros ENABLE ROW LEVEL SECURITY/.test(fwd));
check("revokes DML from anon", /REVOKE SELECT, INSERT, UPDATE, DELETE ON public\.manual_giros FROM anon/.test(fwd));
check("revokes DML from authenticated", /REVOKE SELECT, INSERT, UPDATE, DELETE ON public\.manual_giros FROM authenticated/.test(fwd));
check("adds NO public policy", !/CREATE POLICY/.test(fwd));
check("does not touch service_role grants", !/REVOKE[^\n]*service_role/.test(fwd));
check("rollback restores grants + disables RLS", /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.manual_giros TO anon/.test(rb) && /DISABLE ROW LEVEL SECURITY/.test(rb));

console.log(`\nmanualGirosRlsLockdownMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
