// tests/configWriteRevokeMigration.test.js — S2-1B static assertions (no SQL run).
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }
const dir = path.join(__dirname, "..", "migrations");
const fwd = fs.readFileSync(path.join(dir, "2026-07-20_config_write_revoke.sql"), "utf8");
const rb = fs.readFileSync(path.join(dir, "2026-07-20_config_write_revoke.ROLLBACK.sql"), "utf8");

check("wrapped in transaction", /BEGIN;/.test(fwd) && /COMMIT;/.test(fwd));
check("revokes write from anon", /REVOKE INSERT, UPDATE, DELETE ON public\.config FROM anon/.test(fwd));
check("revokes write from authenticated", /REVOKE INSERT, UPDATE, DELETE ON public\.config FROM authenticated/.test(fwd));
check("does NOT revoke SELECT (public read preserved)", !/REVOKE[^\n]*SELECT[^\n]*config/.test(fwd));
check("does NOT drop/alter the read policy", !/DROP POLICY/.test(fwd) && !/public_read_non_sensitive/.test(fwd.replace(/--.*$/gm, "")));
check("does not touch service_role", !/REVOKE[^\n]*service_role/.test(fwd));
check("rollback restores write grants", /GRANT INSERT, UPDATE, DELETE ON public\.config TO anon/.test(rb) && /TO authenticated/.test(rb));

console.log(`\nconfigWriteRevokeMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
