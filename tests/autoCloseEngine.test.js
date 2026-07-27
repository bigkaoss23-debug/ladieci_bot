"use strict";
// S2-7D6D — structural proof that cron (serviceCloseTick), boot recovery
// (catchUpChiusura) and the external backup (triggerCloseIfNeeded) all
// delegate to the SAME decision engine (computeAutoCloseDecision +
// hasPendingOperationalActivity), rather than each carrying its own rule —
// which is exactly how boot's old SERA-only hour-window heuristic diverged
// from the kind-agnostic cron tick before this patch. Same style as
// tests/twoServiceMigration.test.js: a source-text proof for wiring that a
// live DB round trip cannot cheaply exercise for all three triggers at once.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const INDEX = read("index.js");

console.log("\n══ A. one shared decision module, not three local rules ══");
assert("A: index.js imports computeAutoCloseDecision", /require\("\.\/src\/serviceSessions\/autoCloseDecision"\)/.test(INDEX));
assert("A: index.js imports hasPendingOperationalActivity", /require\("\.\/src\/serviceSessions\/pendingActivityGuard"\)/.test(INDEX));
assert("A: no local serviceCloseDecision() duplicate remains", !/function serviceCloseDecision\(/.test(INDEX));

console.log("\n══ B. serviceCloseTick (cron) uses the shared engine ══");
{
  const tick = INDEX.slice(INDEX.indexOf("async function serviceCloseTick"), INDEX.indexOf("function schedulaCloseTick"));
  assert("B: tick calls computeAutoCloseDecision", /computeAutoCloseDecision\(/.test(tick));
  assert("B: tick calls hasPendingOperationalActivity before closing", /hasPendingOperationalActivity\(/.test(tick));
  assert("B: tick still reuses the single close implementation", /chiudiServizio\(true, decision\.source\)/.test(tick));
}

console.log("\n══ C. catchUpChiusura (boot) is now kind-agnostic ══");
{
  const boot = INDEX.slice(INDEX.indexOf("async function catchUpChiusura"), INDEX.indexOf("if (require.main === module) {\n  schedula2340"));
  assert("C: boot calls computeAutoCloseDecision (same engine as cron)", /computeAutoCloseDecision\(/.test(boot));
  assert("C: boot calls hasPendingOperationalActivity before closing", /hasPendingOperationalActivity\(/.test(boot));
  assert("C: the old SERA-only LAST_CLOSE_DATE marker check is gone", !/LAST_CLOSE_DATE/.test(boot));
  assert("C: the old ad-hoc 23:00-05:59 hour window is gone", !/h === 23/.test(boot) && !/h >= 0 && h < 6/.test(boot));
  assert("C: boot still reuses the single close implementation", /chiudiServizio\(true, "catchUp"\)/.test(boot));
}

console.log("\n══ D. triggerCloseIfNeeded (external backup) is no longer an unconditional force-close ══");
{
  const handler = INDEX.slice(INDEX.indexOf('action === "triggerCloseIfNeeded"'), INDEX.indexOf('} else if (action === "scanServizio")'));
  assert("D: no longer an unconditional chiudiServizio(true, \"external\") with zero gate", !/^\s*result = await chiudiServizio\(true, "external"\);\s*$/m.test(handler));
  assert("D: external trigger checks computeAutoCloseDecision", /computeAutoCloseDecision\(/.test(handler));
  assert("D: external trigger checks hasPendingOperationalActivity", /hasPendingOperationalActivity\(/.test(handler));
  assert("D: external trigger still calls the single close implementation when due", /chiudiServizio\(true, "external"\)/.test(handler));
}

console.log("\n══ E. testability — the audit's flagged gap is closed ══");
assert("E: serviceCloseTick is exported for direct testing", /module\.exports\.serviceCloseTick = serviceCloseTick;/.test(INDEX));
assert("E: catchUpChiusura is exported for direct testing", /module\.exports\.catchUpChiusura = catchUpChiusura;/.test(INDEX));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
