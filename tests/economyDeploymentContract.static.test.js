// tests/economyDeploymentContract.static.test.js -- ONE canonical deployment contract for Economy 139 -> 156 (greenfield finalization).
// Pins that no repository instruction contradicts docs/ECONOMY_139_156_ROLLOUT_CONTRACT.md, and that the runner is the only path.
// Run: node tests/economyDeploymentContract.static.test.js

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); } }
const PF = require("../scripts/economy139to146Preflight.js");

console.log("\n── the contract document ──");
const doc = read("docs/ECONOMY_139_156_ROLLOUT_CONTRACT.md");
check("the contract names scripts/economyChainApply.js as the only deployment path", /## 1\. The only deployment path/.test(doc) && /scripts\/economyChainApply\.js/.test(doc));
check("the contract forbids apply_migration / SQL editor / psql -f, 149 or 150 alone, manual ledger rows, the transaction pooler, a previous V3 backend",
  ["apply_migration", "SQL editor", "psql -f", "applying 149 or 150 alone", "inserting ledger rows by hand", "transaction-mode pooler", "2e3e59a"].every((k) => doc.includes(k)));
check("the contract states its precedence over the frozen migration headers (149, 150 named) and the manifest rows", /every `ROLLOUT:` \/ `ROLLBACK ORDER:` line in the frozen headers of the chain migrations/.test(doc) && /in\s+particular 149/.test(doc) && /rows 149 \/ 150 of `migrations\/MIGRATION_MANIFEST\.md`/.test(doc));
check("149 + 150: ONE transaction in both directions", /forward\*\* = ONE transaction/.test(doc) && /rollback\*\* = ONE transaction/.test(doc));
check("rollback / PONR table: 152 and 139 are points of no return; production floor BEFORE_151", /152: a post-close resolution fact exists \(PONR\)/.test(doc) && /139: an off-service payment receipt exists \(PONR\)/.test(doc) && /rollback floor in production is\s+`BEFORE_151`/.test(doc));
check("the former CRITICAL hold (exit 3) is gone from the runbooks", /no longer exists/.test(doc) && !/R2 — guarded step exit 3/.test(doc));

console.log("\n── no contradicting instruction left in the repository ──");
const pfSrc = read("scripts/economy139to146Preflight.js");
check("the preflight header no longer says 'applied by hand, one migration at a time'", !/applied by hand, one migration at a time/.test(pfSrc) && /deployed ONLY by scripts\/economyChainApply\.js/.test(pfSrc));
const manifest = read("migrations/MIGRATION_MANIFEST.md");
const row = (n) => manifest.split("\n").find((l) => l.startsWith(`| ${n} |`)) || "";
check("manifest row 149: no '149, then the backend' rollout, no 'backend first' rollback", !/-> 149, then the backend that calls/.test(row(149)) && !/Rollback order: backend first/.test(row(149)) && /GUARDED\(149 \+ 150\)/.test(row(149)));
check("manifest row 150: no 'rollback: backend first, then 150'", !/rollback: backend first, then 150/.test(row(150)) && /GUARDED\(rb150 \+ rb149\)/.test(row(150)));
check("the manifest's closing section points to the one contract", /## Economy 139 → 156 — the canonical deployment contract/.test(manifest) && /docs\/ECONOMY_139_156_ROLLOUT_CONTRACT\.md/.test(manifest));
const contradicting = PF.CHAIN.filter((c) => /149, then the backend|ROLLBACK ORDER: backend first|backend first,\s*\n?--\s*then 150/.test(read("migrations/" + c.file).split("\nBEGIN;")[0])).map((c) => c.n);
check("the frozen headers that contradict the contract are exactly 149 and 150 (named by the contract as historical)", JSON.stringify(contradicting) === "[149,150]", JSON.stringify(contradicting));
for (const f of fs.readdirSync(path.join(ROOT, "docs")).filter((x) => x.endsWith(".md"))) {
  const t = read("docs/" + f);
  if (/apply_migration/.test(t)) check(`docs/${f}: apply_migration only appears as a forbidden path`, /not deployment paths|NOT deployment paths|forbidden/i.test(t));
}

console.log("\n── the runner and the guarded step enforce it ──");
const ca = read("scripts/economyChainApply.js");
const gs = read("scripts/economy149150GuardedStep.js");
check("every chain step: ONE transaction with its ledger row, its registry row and the target-mode preflight before COMMIT", /await client\.query\(f\.body\)/.test(ca) && /TX\.recordApplied/.test(ca) && /pfInTx\(client, to, noRegistry\)/.test(ca));
check("the guarded step has no second-transaction revert and no lock-holding CRITICAL path", !/holdUntilConsistent|CRITICAL_REPAIRED_EXTERNALLY|keepLock/.test(gs));
check("the guarded step runs the pair inside one BEGIN ... COMMIT with the BEFORE_151 preflight in the open transaction", /for \(const b of bodies\) await client\.query\(b\);[\s\S]{0,200}recordPair[\s\S]{0,200}preflightRowsInTx\(client, 'BEFORE_151'/.test(gs));
check("both refuse the transaction pooler and prove one server session", /refuseTransactionPooler/.test(ca) && /assertSameSession/.test(ca) && /assertLockOwned/.test(gs));
check("141 / 142 (Fiscal) are not in the chain", !PF.CHAIN.some((c) => c.n === 141 || c.n === 142));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
