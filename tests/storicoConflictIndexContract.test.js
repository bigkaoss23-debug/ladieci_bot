"use strict";
// S2-6A3E — the storico archive upsert and its unique index must stay compatible.
//
// The backend archives storico via PostgREST upsert `on_conflict=service_session_id,orden_id`,
// which becomes `INSERT ... ON CONFLICT (service_session_id, orden_id) DO UPDATE`. PostgreSQL
// cannot infer a PARTIAL unique index for that specification (SQLSTATE 42P10), so the index on
// those columns MUST be non-partial. This static test fails if either side drifts: if the
// backend still uses that exact conflict target, no migration may (re)introduce a partial index
// on it.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const servizioSrc = fs.readFileSync(path.join(ROOT, "src/utils/servizio.js"), "utf8");

const CONFLICT_TARGET = "service_session_id,orden_id";

test("backend still upserts storico on the (service_session_id, orden_id) conflict target", () => {
  const usesTarget = new RegExp(
    `sbUpsert\\(\\s*["'\`]storico["'\`]\\s*,[^;]*["'\`]${CONFLICT_TARGET}["'\`]`
  ).test(servizioSrc);
  assert.ok(usesTarget, "storico upsert conflict target changed — revisit the index contract");
});

test("the net effect of all forward migrations leaves storico_session_order_uq NON-partial", () => {
  // Replay index CREATE/DROP/RENAME statements across forward migrations in filename
  // (chronological) order and assert the index that ends up named storico_session_order_uq
  // is non-partial. This tolerates the historical identity migration (which created it
  // partial) as long as a later migration corrects it — while still failing if a future
  // migration reintroduces a partial index on that conflict target. ROLLBACK files are
  // excluded: reverting to partial is an explicitly coupled, never-auto-run procedure.
  const migDir = path.join(ROOT, "migrations");
  const forwards = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql") && !/ROLLBACK/i.test(f)).sort();
  const indexes = new Map(); // name -> { partial:boolean }
  for (const f of forwards) {
    const sql = fs.readFileSync(path.join(migDir, f), "utf8");
    for (let stmt of sql.split(";")) {
      const s = stmt.replace(/\s+/g, " ").trim();
      let m;
      if ((m = s.match(/create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s+on\s+(?:public\.)?storico\s*\(\s*service_session_id\s*,\s*orden_id\s*\)(.*)$/i))) {
        indexes.set(m[1], { partial: /\bwhere\b/i.test(m[2]) });
      } else if ((m = s.match(/drop\s+index\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)/i))) {
        indexes.delete(m[1]);
      } else if ((m = s.match(/alter\s+index\s+(?:public\.)?(\w+)\s+rename\s+to\s+(\w+)/i))) {
        if (indexes.has(m[1])) { indexes.set(m[2], indexes.get(m[1])); indexes.delete(m[1]); }
      }
    }
  }
  const final = indexes.get("storico_session_order_uq");
  assert.ok(final, "storico_session_order_uq is not defined by any forward migration");
  assert.equal(final.partial, false, "storico_session_order_uq must end up NON-partial to match the backend ON CONFLICT target");
});

test("the dedicated fix migration builds a NON-partial unique index and reloads PostgREST", () => {
  const f = path.join(ROOT, "migrations/2026-07-23_storico_session_order_uq_nonpartial.sql");
  const sql = fs.readFileSync(f, "utf8");
  assert.match(sql, /CREATE UNIQUE INDEX\s+storico_session_order_uq_new\s+ON\s+public\.storico\s*\(\s*service_session_id\s*,\s*orden_id\s*\)\s*;/i);
  assert.doesNotMatch(sql.match(/CREATE UNIQUE INDEX[\s\S]*?;/i)[0], /where/i, "the new index must NOT be partial");
  assert.match(sql, /DROP INDEX\s+public\.storico_session_order_uq/i);
  assert.match(sql, /RENAME TO storico_session_order_uq/i);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/i);
});

test("no forward migration leaves a UNIQUE index/constraint on storico(orden_id, fecha)", () => {
  // S2-6A3F — same-day uniqueness on (orden_id, fecha) is incompatible with the
  // multi-service model (two services per business date reuse order numbers). Replay the
  // index CREATE/DROP/RENAME statements across forward migrations and assert nothing named
  // on those columns ends up UNIQUE. ROLLBACK files may restore it (coupled, never auto-run).
  const migDir = path.join(ROOT, "migrations");
  const forwards = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql") && !/ROLLBACK/i.test(f)).sort();
  const indexes = new Map(); // name -> { unique, cols }
  const offenders = [];
  for (const f of forwards) {
    const sql = fs.readFileSync(path.join(migDir, f), "utf8");
    for (let stmt of sql.split(";")) {
      const s = stmt.replace(/\s+/g, " ").trim();
      let m;
      if ((m = s.match(/create\s+(unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s+on\s+(?:public\.)?storico\s*\(\s*orden_id\s*,\s*fecha\s*\)/i))) {
        indexes.set(m[2], { unique: !!m[1] });
      } else if ((m = s.match(/drop\s+index\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)/i))) {
        indexes.delete(m[1]);
      } else if ((m = s.match(/alter\s+index\s+(?:public\.)?(\w+)\s+rename\s+to\s+(\w+)/i))) {
        if (indexes.has(m[1])) { indexes.set(m[2], indexes.get(m[1])); indexes.delete(m[1]); }
      }
      // also forbid a UNIQUE CONSTRAINT on those columns
      if (/add\s+constraint[\s\S]*unique\s*\(\s*orden_id\s*,\s*fecha\s*\)/i.test(s) && /storico/i.test(s)) {
        offenders.push(`${f}: unique constraint on (orden_id, fecha)`);
      }
    }
  }
  for (const [name, info] of indexes) if (info.unique) offenders.push(`index ${name} is UNIQUE on (orden_id, fecha)`);
  assert.deepEqual(offenders, [], `same-day uniqueness on storico(orden_id, fecha) is forbidden:\n${offenders.join("\n")}`);
});

test("the dedicated drop migration removes the legacy UNIQUE and adds a non-unique lookup index", () => {
  const f = path.join(ROOT, "migrations/2026-07-23_storico_drop_legacy_orden_fecha_uniqueness.sql");
  const sql = fs.readFileSync(f, "utf8");
  assert.match(sql, /DROP INDEX\s+public\.storico_orden_id_fecha_key/i);
  assert.match(sql, /CREATE INDEX\s+storico_orden_id_fecha_idx\s+ON\s+public\.storico\s*\(\s*orden_id\s*,\s*fecha\s*\)/i);
  assert.doesNotMatch(sql.match(/CREATE INDEX\s+storico_orden_id_fecha_idx[\s\S]*?;/i)[0], /unique/i);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/i);
});
