#!/usr/bin/env node
"use strict";
// ONDA 0 — CLI entry point for the Spanish domain-language guardrail.
// Usage:
//   node scripts/check-domain-language.js                 full-tree + local diff (working tree + staged)
//   node scripts/check-domain-language.js --base=X --head=Y   CI mode: diff X..Y instead of local diff
//   node scripts/check-domain-language.js --stats             print baseline stats only, no pass/fail
//   node scripts/check-domain-language.js --write-baseline     overwrite the baseline with the current scan
//
// See docs/contrato-linguistico-dominio.md for the authoritative glossary and rules.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  collectFiles,
  scanFile,
  isAllowlisted,
  countsByFileAndTerm,
  compareToBaseline,
  parseAddedLines,
  SCAN_EXTENSIONS,
} = require("./lib/domainLanguageGuard");

const ROOT = path.join(__dirname, "..");
const BASELINE_PATH = path.join(ROOT, "config", "domain-language-legacy-baseline.json");

// Narrow, file-level exceptions. Nothing else is exempt — new code anywhere,
// including new migrations and new tests, is fully in scope.
const ALLOWLIST_PATTERNS = [
  // Historical `messa` migration family V3-H/I/J/K (forward + ROLLBACK) —
  // immutable, per docs/contrato-linguistico-dominio.md.
  /^migrations\/2026-08-01_v3h.*\.sql$/,
  /^migrations\/2026-08-02_v3[ijk].*\.sql$/,
  // Static tests that verify those specific historical migrations (V3-H
  // messa-named originals, plus V3-I/J/K which assert the messa→mesa
  // cutover and rollback contracts by name).
  /^tests\/v3h(1|1a|2)?Messa[A-Za-z]*\.static\.test\.js$/,
  /^tests\/v3iMesaCoversDeferred\.static\.test\.js$/,
  /^tests\/v3jMesaNomenclatureCutover\.static\.test\.js$/,
  /^tests\/v3kMesaTableShapes\.static\.test\.js$/,
  // H-1's rollback restores four pre-existing function bodies BYTE-IDENTICALLY
  // -- its own post-conditions assert md5(pg_get_functiondef(...)) equals the
  // captured pre-H-1 checksums. Two of those bodies legitimately contain the
  // PRANZO/SERA service_kind literals, and a suppression comment cannot help:
  // the marker would have to sit INSIDE the function body, which lands in
  // pg_proc.prosrc and breaks the very byte-identity the file exists to
  // guarantee. File-level exemption is the only correct resolution, and is
  // exactly what this allowlist is for.
  /^migrations\/2026-08-20_h1_legacy_lifecycle_writer_hardening\.ROLLBACK\.sql$/,
  // L-1's privilege+RLS lockdown names nine pre-existing legacy tables
  // (clientes/ordenes/storico/conv/wa_msgs/archivio_conv/analisi_serata/
  // suggerimenti/geo_cache) by identifier throughout its grants, policies
  // and post-condition assertions -- citing existing schema, not introducing
  // vocabulary. Ledger apply_order 102 already has this exact forward file's
  // checksum (e21e5c2cbdd82980) recorded as verified; an inline suppression
  // comment would change those bytes and break that checksum, so -- exactly
  // like the H-1 ROLLBACK case above -- a file-level exemption is the only
  // correct resolution. Its paired ROLLBACK is exempted for the same reason
  // and to stay symmetric with every other forward+ROLLBACK pair above.
  /^migrations\/2026-08-22_l1_legacy_public_data_lockdown\.sql$/,
  /^migrations\/2026-08-22_l1_legacy_public_data_lockdown\.ROLLBACK\.sql$/,
  // The guard's own source and its unit tests: they must hold the
  // blocked-term list, allowlist patterns and fixture strings as literal
  // data — that is not domain contamination.
  /^scripts\/check-domain-language\.js$/,
  /^scripts\/lib\/domainLanguageGuard\.js$/,
  /^tests\/domainLanguageGuard\.test\.js$/,
];

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}`));
const flagValue = (name) => {
  const f = flag(name);
  if (!f) return null;
  const eq = f.indexOf("=");
  return eq === -1 ? "" : f.slice(eq + 1);
};

function relPath(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { generatedAt: null, entries: [] };
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

function scanRepo() {
  const files = collectFiles(ROOT, { extensions: SCAN_EXTENSIONS })
    .map(relPath)
    .filter((f) => !isAllowlisted(f, ALLOWLIST_PATTERNS));

  const allViolations = [];
  const allSuppressions = [];
  const allInvalidSuppressions = [];
  for (const f of files) {
    const { violations, suppressions, invalidSuppressions } = scanFile(path.join(ROOT, f));
    allViolations.push(...violations.map((v) => ({ ...v, file: f })));
    allSuppressions.push(...suppressions.map((s) => ({ ...s, file: f })));
    allInvalidSuppressions.push(...invalidSuppressions.map((s) => ({ ...s, file: f })));
  }
  return { files, violations: allViolations, suppressions: allSuppressions, invalidSuppressions: allInvalidSuppressions };
}

function printStats(violations) {
  const byTerm = new Map();
  const byFile = new Map();
  for (const v of violations) {
    byTerm.set(v.term, (byTerm.get(v.term) || 0) + 1);
    byFile.set(v.file, (byFile.get(v.file) || 0) + 1);
  }
  console.log(`\nTotale occorrenze legacy: ${violations.length}`);
  console.log("\nPer termine:");
  [...byTerm.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, c]) => console.log(`  ${t}: ${c}`));
  console.log("\nTop 10 file:");
  [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([f, c]) => console.log(`  ${c}\t${f}`));
}

function writeBaseline(violations) {
  const counts = countsByFileAndTerm(violations);
  const entries = [...counts.entries()]
    .map(([key, count]) => {
      const [file, term] = key.split("::");
      return { file, term, count };
    })
    .sort((a, b) => (a.file === b.file ? a.term.localeCompare(b.term) : a.file.localeCompare(b.file)));
  const baseline = { generatedAt: new Date().toISOString(), entries };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`[check-domain-language] baseline scritta: ${entries.length} coppie file+termine.`);
}

function getGitDiff() {
  const base = flagValue("base");
  const head = flagValue("head");
  try {
    if (base && head) {
      return execFileSync("git", ["diff", "--unified=0", `${base}..${head}`, "--", ...SCAN_EXTENSIONS.map((e) => `*${e}`)], { cwd: ROOT, encoding: "utf8" });
    }
    const working = execFileSync("git", ["diff", "--unified=0", "--", ...SCAN_EXTENSIONS.map((e) => `*${e}`)], { cwd: ROOT, encoding: "utf8" });
    const staged = execFileSync("git", ["diff", "--cached", "--unified=0", "--", ...SCAN_EXTENSIONS.map((e) => `*${e}`)], { cwd: ROOT, encoding: "utf8" });
    return working + staged;
  } catch (e) {
    console.log(`[check-domain-language] diff Git non disponibile (${e.message.split("\n")[0]}) — salto il controllo sulle righe aggiunte.`);
    return "";
  }
}

function checkAddedLines(scanned) {
  const diff = getGitDiff();
  if (!diff.trim()) return { ok: true, hits: [] };
  const added = parseAddedLines(diff);
  const violationsByFile = new Map();
  for (const v of scanned.violations) {
    if (!violationsByFile.has(v.file)) violationsByFile.set(v.file, []);
    violationsByFile.get(v.file).push(v);
  }
  const hits = [];
  for (const [file, lineNumbers] of added.entries()) {
    if (isAllowlisted(file, ALLOWLIST_PATTERNS)) continue;
    const fileViolations = violationsByFile.get(file) || [];
    for (const v of fileViolations) {
      if (lineNumbers.has(v.line)) hits.push(v);
    }
  }
  return { ok: hits.length === 0, hits };
}

function main() {
  const scanned = scanRepo();

  if (flag("stats")) {
    printStats(scanned.violations);
    process.exit(0);
  }

  if (flag("write-baseline")) {
    writeBaseline(scanned.violations);
    process.exit(0);
  }

  let failed = false;

  if (scanned.invalidSuppressions.length > 0) {
    failed = true;
    console.error("\n🛑 [type: invalid-suppression] Soppressioni 'language-guard: allow-legacy' senza motivazione:");
    for (const s of scanned.invalidSuppressions) console.error(`   ${s.file}:${s.line}`);
  }

  const counts = countsByFileAndTerm(scanned.violations);
  const baseline = loadBaseline();
  const cmp = compareToBaseline(counts, baseline);

  if (!cmp.ok) {
    failed = true;
    if (cmp.newEntries.length > 0) {
      console.error("\n🛑 [type: new-term] Nuove occorrenze di termini italiani non presenti in baseline:");
      for (const e of cmp.newEntries) console.error(`   term=${e.term} file=${e.file} count=${e.count}`);
    }
    if (cmp.increasedEntries.length > 0) {
      console.error("\n🛑 [type: baseline-increase] Aumento di occorrenze rispetto alla baseline:");
      for (const e of cmp.increasedEntries) console.error(`   term=${e.term} file=${e.file} count=${e.baselineCount} → ${e.count}`);
    }
  }

  const addedCheck = checkAddedLines(scanned);
  if (!addedCheck.ok) {
    failed = true;
    console.error("\n🛑 [type: added-line] Righe aggiunte in questo diff contengono termini italiani vietati:");
    for (const v of addedCheck.hits) console.error(`   term=${v.term} file=${v.file}:${v.line}`);
  }

  if (scanned.suppressions.length > 0) {
    console.log("\nEccezioni attive (language-guard: allow-legacy):");
    for (const s of scanned.suppressions) console.log(`   ${s.file}:${s.line} [${s.terms.join(", ")}] — ${s.reason}`);
  }

  if (failed) {
    console.error("\n[check-domain-language] FAIL — vedi docs/contrato-linguistico-dominio.md");
    process.exit(1);
  }

  console.log(`[check-domain-language] OK — ${scanned.files.length} file controllati, nessuna nuova occorrenza.`);
  console.log("DOMAIN_LANGUAGE_GUARD_OK");
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { ALLOWLIST_PATTERNS };
