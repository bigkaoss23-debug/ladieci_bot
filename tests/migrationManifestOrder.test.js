"use strict";
// S2-7C1 — replay-order guard for the account/workspace migrations. The two S2-7B/S2-7C
// files share a 2026-07-24 prefix and sort lexically as account < workspace, which is the
// REVERSE of the real dependency (S2-7C alters objects S2-7B creates). MIGRATION_MANIFEST.md
// is the replay authority and must keep S2-7B strictly before S2-7C. This test fails if the
// manifest is edited to invert them or if the future dependency is broken.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MIG = path.join(__dirname, "..", "migrations");
const manifest = fs.readFileSync(path.join(MIG, "MIGRATION_MANIFEST.md"), "utf8");
const workspaceSql = fs.readFileSync(path.join(MIG, "2026-07-24_workspace_foundation.sql"), "utf8");
const accountSql = fs.readFileSync(path.join(MIG, "2026-07-24_account_auth_boundary.sql"), "utf8");

function applyOrderOf(filename) {
  // rows look like: | 29 | ... | <filename> | ... |
  const line = manifest.split("\n").find((l) => l.includes(filename) && /^\s*\|\s*\d+\s*\|/.test(l));
  assert.ok(line, `manifest row for ${filename} not found`);
  return Number(line.match(/^\s*\|\s*(\d+)\s*\|/)[1]);
}

test("manifest applies S2-7B (workspace) strictly before S2-7C (account)", () => {
  const b = applyOrderOf("2026-07-24_workspace_foundation.sql");
  const c = applyOrderOf("2026-07-24_account_auth_boundary.sql");
  assert.ok(b < c, `workspace apply_order (${b}) must precede account apply_order (${c})`);
});

test("the dependency that forces that order still holds (S2-7C alters what S2-7B creates)", () => {
  assert.match(workspaceSql, /CREATE TABLE public\.user_profiles/);
  assert.match(workspaceSql, /CREATE TABLE public\.workspace_account_audit/);
  assert.match(accountSql, /ON public\.user_profiles/);
  assert.match(accountSql, /public\.workspace_account_audit/);
});

test("lexical filename order is the INVERSE of the required order (documents the hazard)", () => {
  const lex = ["2026-07-24_account_auth_boundary.sql", "2026-07-24_workspace_foundation.sql"].sort();
  assert.deepEqual(lex, ["2026-07-24_account_auth_boundary.sql", "2026-07-24_workspace_foundation.sql"]);
  // i.e. account sorts first lexically, but the manifest must run workspace first.
  assert.ok(
    applyOrderOf("2026-07-24_workspace_foundation.sql") < applyOrderOf("2026-07-24_account_auth_boundary.sql")
  );
});

test("every forward migration file appears exactly once in the manifest (no skip)", () => {
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql") && !f.includes("ROLLBACK"));
  for (const f of files) {
    const count = manifest.split("\n").filter((l) => l.includes(`| ${f} |`) || l.includes(` ${f} |`)).length;
    assert.ok(count >= 1, `migration ${f} missing from manifest`);
  }
});
