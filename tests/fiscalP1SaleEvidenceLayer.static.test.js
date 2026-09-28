"use strict";
// FISCAL PREREQUISITES V1 / P1 -- static pins of post-freeze layer 170 (sale_evidence). No network, no database: the behaviour is certified
// on PostgreSQL 17 in the lab (real-PG matrix, Economy differential, concurrency / deadlock gate; FISCAL P1 evidence pack).
// Contract: docs/FISCAL_P1_SALE_EVIDENCE_CONTRACT.md. Run: node --test tests/fiscalP1SaleEvidenceLayer.static.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REG = require("../scripts/lib/postFreezeLayers.js");
const TX = require("../scripts/lib/migrationTx.js");
const PF = require("../scripts/economy139to146Preflight.js");
const L = REG.layerOf(170);
const FWD = fs.readFileSync(path.join(ROOT, L.dir, L.file), "utf8");
const RBK = fs.readFileSync(path.join(ROOT, L.dir, L.file.replace(/\.sql$/, ".ROLLBACK.sql")), "utf8");
const code = (sql) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");      // SQL without comments
const FWD_CODE = code(FWD);
const bodies = (sql) => { const out = {}; const re = /CREATE OR REPLACE FUNCTION (sale_evidence\.[a-z_0-9]+)\(([\s\S]*?)\$fn\$([\s\S]*?)\$fn\$/g; let m;
  while ((m = re.exec(sql))) out[m[1]] = { header: m[2], body: m[3] }; return out; };
const FNS = bodies(FWD);
const BASIS = ["items", "totale", "delivery_fee", "descuento_tipo", "descuento_valor", "descuento_importe", "tipo_consegna"]; // language-guard: allow-legacy existing ordenes column names (the Economy's EDITOR_BASIS_FIELDS)

test("both files have the one-transaction shape the runner requires", () => {
  assert.ok(TX.txBody(FWD, "fwd").length > 0);
  assert.ok(TX.txBody(RBK, "rbk").length > 0);
});

test("no Economy object is created, replaced, altered, dropped, re-granted or written: outside schema sale_evidence only the two ordenes triggers", () => {
  const strip = FWD_CODE.replace(/'(?:[^']|'')*'/g, "''");                                      // string literals (COMMENT texts) out
  assert.deepEqual(strip.match(/\b(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?(TABLE|FUNCTION|VIEW|INDEX|SEQUENCE|TYPE|POLICY|SCHEMA|PROCEDURE|RULE|TRIGGER)\s+(IF\s+(NOT\s+)?EXISTS\s+)?public\./gi), null);
  assert.deepEqual(strip.match(/\b(ALTER\s+TABLE|GRANT|REVOKE|COMMENT\s+ON|ALTER\s+PUBLICATION)\b[^;]*\bpublic\./gi), null);
  assert.deepEqual(strip.match(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?public\./gi), null);
  const triggers = [...strip.matchAll(/\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+[^;]*?\bON\s+([a-z_]+)\./gi)].filter((m) => m[3] === "public").map((m) => m[2]);
  assert.deepEqual(triggers, ["ordenes_zzz_sale_evidence_capture_ins_v1", "ordenes_zzz_sale_evidence_capture_upd_v1"]);
  assert.match(FWD_CODE, /LOCK TABLE public\.ordenes IN SHARE ROW EXCLUSIVE MODE;/);
});

test("the UPDATE trigger watches exactly the Economy's seven editor basis columns (agentOrdini EDITOR_BASIS_FIELDS = 153 v_basis)", () => {  // language-guard: allow-legacy agentOrdini is the existing backend module name
  const src = fs.readFileSync(path.join(ROOT, "src/agents/agentOrdini.js"), "utf8");  // language-guard: allow-legacy existing module path
  const editor = JSON.parse(/const EDITOR_BASIS_FIELDS = Object\.freeze\((\[[^\]]+\])\)/.exec(src)[1]);
  const m153 = fs.readFileSync(path.join(ROOT, "migrations/2026-09-26_order_editor_canonical_writer_v1_migration_153.sql"), "utf8");
  const v153 = /v_basis constant text\[\] := ARRAY\[([^\]]+)\]/.exec(m153)[1].split(",").map((x) => x.trim().replace(/'/g, ""));
  assert.deepEqual(editor, BASIS); assert.deepEqual(v153, BASIS);
  const upd = /CREATE TRIGGER ordenes_zzz_sale_evidence_capture_upd_v1\s+AFTER UPDATE OF ([^\n]+?) ON public\.ordenes\s+FOR EACH ROW WHEN \(NEW\.table_session_id IS NULL AND \(([\s\S]*?)\)\)\s+EXECUTE FUNCTION sale_evidence\.capture_composition_v1\(\);/.exec(FWD_CODE);
  assert.ok(upd, "update trigger shape");
  assert.deepEqual(upd[1].split(",").map((x) => x.trim()), BASIS);
  const distinct = [...upd[2].matchAll(/OLD\.([a-z_]+) IS DISTINCT FROM NEW\.([a-z_]+)/g)].map((x) => { assert.equal(x[1], x[2]); return x[1]; });
  assert.deepEqual(distinct, BASIS);
  assert.match(FWD_CODE, /CREATE TRIGGER ordenes_zzz_sale_evidence_capture_ins_v1\s+AFTER INSERT ON public\.ordenes\s+FOR EACH ROW WHEN \(NEW\.table_session_id IS NULL\)\s+EXECUTE FUNCTION sale_evidence\.capture_composition_v1\(\);/);
  // the basis digest covers the same seven columns, in the same order, in the capture and in the marker query
  const calls = [...FWD_CODE.matchAll(/sale_evidence\.basis_digest_v1\(([A-Za-z]+)\.items, \1\.totale, \1\.delivery_fee, \1\.descuento_tipo, \1\.descuento_valor, \1\.descuento_importe, \1\.tipo_consegna\)/g)].map((x) => x[1]);  // language-guard: allow-legacy existing ordenes column name
  assert.deepEqual(calls.sort(), ["NEW", "OLD", "o"]);
});

test("the capture triggers fire after every Economy AFTER trigger of ordenes (name order)", () => {
  const economyAfter = ["mesa_snapshot_order_lines_v1", "ordenes_order_obligation_anchor_v1", "ordenes_order_obligation_revision_v1", "ordenes_paid_at_creation_payment_v1"];
  for (const t of economyAfter) {
    assert.ok(Buffer.compare(Buffer.from(t), Buffer.from("ordenes_zzz_sale_evidence_capture_ins_v1")) < 0, t);
    assert.ok(Buffer.compare(Buffer.from(t), Buffer.from("ordenes_zzz_sale_evidence_capture_upd_v1")) < 0, t);
  }
  assert.match(FWD_CODE, /t\.tgname COLLATE "C" >= 'ordenes_zzz_sale_evidence_capture_ins_v1'/, "the guard re-checks it on the target database");
});

test("the Economy bodies the layer pins are the certified POST_APPLY bodies known to the frozen preflight", () => {
  const pins = [...FWD.matchAll(/\('(public\.[a-z_0-9]+\([^)]*\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  assert.equal(pins.length, 14, "seven pins, in the guard and in the post-condition");
  const known = new Map(PF.FN.map((f) => [f.sig, f.states]));
  let crossChecked = 0;
  for (const [sig, md5] of pins) {
    const st = known.get(sig);
    if (!st) continue;
    const last = Object.keys(st).map(Number).filter((k) => k <= 156).sort((a, b) => a - b).pop();
    assert.equal(st[last], md5, `${sig}: pinned ${md5}, preflight POST_APPLY state ${st[last]}`);
    crossChecked += 1;
  }
  assert.ok(crossChecked >= 2, `at least the 151 revision body and the 153 editor are cross-checked (${crossChecked})`);
});

test("capture: SECURITY DEFINER with a pinned search_path; every function pins its search_path; nothing is callable by API roles", () => {
  const cap = /CREATE OR REPLACE FUNCTION sale_evidence\.capture_composition_v1\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER\s+SET search_path TO 'pg_catalog', 'pg_temp'/;
  assert.match(FWD, cap);
  const defs = FWD.match(/CREATE OR REPLACE FUNCTION sale_evidence\.[a-z_0-9]+\([\s\S]*?AS \$fn\$/g);
  assert.ok(defs.length >= 11);
  for (const d of defs) assert.match(d, /SET search_path TO 'pg_catalog', 'pg_temp'/, d.slice(0, 80));
  assert.equal((FWD_CODE.replace(/'(?:[^']|'')*'/g, "''").match(/SECURITY DEFINER/g) || []).length, 1, "only the capture is SECURITY DEFINER");
  assert.doesNotMatch(FWD_CODE, /GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
  assert.match(FWD_CODE, /REVOKE ALL ON FUNCTION sale_evidence\.capture_composition_v1\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(FWD_CODE, /GRANT SELECT ON ALL TABLES IN SCHEMA sale_evidence TO service_role;/);
  assert.doesNotMatch(FWD_CODE, /GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*sale_evidence/i);
  assert.doesNotMatch(FWD_CODE, /CREATE POLICY/i);
  assert.doesNotMatch(FWD_CODE, /ALTER PUBLICATION/i);
});

test("no back-fill: revisions and lines are inserted ONLY inside the capture function", () => {
  const outside = FWD_CODE.replace(/CREATE OR REPLACE FUNCTION sale_evidence\.capture_composition_v1\(\)[\s\S]*?\$fn\$[\s\S]*?\$fn\$/, "");
  assert.doesNotMatch(outside, /INSERT INTO sale_evidence\.composition_(revisions|lines)/);
  assert.equal((FNS["sale_evidence.capture_composition_v1"].body.match(/INSERT INTO sale_evidence\.composition_(revisions|lines)/g) || []).length, 2);
  assert.match(outside, /INSERT INTO sale_evidence\.history_gap_markers/, "existing orders are MARKED, not evidenced");
  assert.match(FWD_CODE, /EXISTS \(SELECT 1 FROM sale_evidence\.composition_revisions r WHERE r\.txid = txid_current\(\)\)/, "post-condition: the attach transaction wrote no revision");
});

test("evidence model: append-only guards, deterministic identities, no fiscal / tax / numbering / PII vocabulary in the schema", () => {
  for (const t of ["composition_revisions", "composition_lines", "capture_epochs", "history_gap_markers"]) {
    assert.match(FWD_CODE, new RegExp(`CREATE OR REPLACE TRIGGER ${t}_append_only_v1 BEFORE UPDATE OR DELETE ON sale_evidence\\.${t}`));
    assert.match(FWD_CODE, new RegExp(`CREATE OR REPLACE TRIGGER ${t}_no_truncate_v1 BEFORE TRUNCATE ON sale_evidence\\.${t}`));
    assert.match(FWD_CODE, new RegExp(`CREATE OR REPLACE TRIGGER ${t}_write_guard_v1 BEFORE INSERT ON sale_evidence\\.${t}`));
  }
  assert.match(FWD_CODE, /CHECK \(id = md5\('sale_evidence\.revision\.v1\|' \|\| order_uid::text \|\| '\|' \|\| revision::text\)::uuid\)/);
  assert.match(FWD_CODE, /CHECK \(id = md5\('sale_evidence\.line\.v1\|' \|\| order_uid::text \|\| '\|' \|\| revision::text \|\| '\|' \|\| line_index::text\)::uuid\)/);
  const cols = [...FWD_CODE.matchAll(/CREATE TABLE IF NOT EXISTS sale_evidence\.[a-z_]+ \(([\s\S]*?)\n\);/g)].flatMap((m) => m[1].split("\n").map((l) => (/^\s+([a-z_]+)\s/.exec(l) || [])[1]).filter(Boolean));
  assert.ok(cols.length > 60);
  const FISCAL = new Set(["tax", "vat", "iva", "rate", "invoice", "factura", "serie", "series", "numbering", "qr", "aeat", "verifactu", "nif", "cif", "prev", "previous"]);
  const PII = new Set(["nombre", "tel", "direccion", "wa", "cliente", "email", "phone", "address", "name"]);
  for (const c of cols) {
    const words = c.split("_");
    assert.ok(!words.some((w) => FISCAL.has(w)), `fiscal concept column ${c}`);
    // names are allowed ONLY as product description snapshots of a line (classic / fantasy name), never as a person's data
    assert.ok(!words.some((w) => PII.has(w)) || ["classic_name", "fantasy_name"].includes(c), `PII column ${c}`);
  }
  assert.doesNotMatch(FWD_CODE, /\bREFERENCES\s+public\./i, "no foreign key to an Economy table (it would add a lock edge)");
  assert.doesNotMatch(FWD_CODE, /\bFOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/i, "the layer takes no row lock");
});

test("rollback = DETACH: drops only the two triggers and the capture function, keeps every table and row, requires the acknowledgement", () => {
  const r = code(RBK);
  const drops = r.match(/\bDROP\s+\w+[^;]*;/g);
  assert.deepEqual(drops, ["DROP TRIGGER ordenes_zzz_sale_evidence_capture_upd_v1 ON public.ordenes;", "DROP TRIGGER ordenes_zzz_sale_evidence_capture_ins_v1 ON public.ordenes;", "DROP FUNCTION sale_evidence.capture_composition_v1();"]);
  assert.doesNotMatch(r, /\b(DELETE|TRUNCATE|DROP TABLE|DROP SCHEMA|UPDATE sale_evidence)\b/i);
  assert.match(r, /current_setting\('ladieci\.fp1_detach_ack', true\) IS DISTINCT FROM 'DETACH_SALE_EVIDENCE_CAPTURE_ACCEPT_EVIDENCE_GAP'/);
  assert.equal(REG.layerOf(170).rollback.ack, "DETACH_SALE_EVIDENCE_CAPTURE_ACCEPT_EVIDENCE_GAP");
  assert.match(r, /INSERT INTO sale_evidence\.capture_epochs[\s\S]*'DETACHED'/);
  assert.match(r, /LOCK TABLE public\.ordenes IN ACCESS EXCLUSIVE MODE;/);
});

test("no Economy runtime module reads or writes sale_evidence (the capture is the only writer; Economy never depends on it)", () => {
  const hits = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|mjs|cjs)$/.test(e.name) && /sale_evidence/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p)); } };
  walk(path.join(ROOT, "src"));
  if (/sale_evidence/.test(fs.readFileSync(path.join(ROOT, "index.js"), "utf8"))) hits.push("index.js");
  assert.deepEqual(hits, []);
});
