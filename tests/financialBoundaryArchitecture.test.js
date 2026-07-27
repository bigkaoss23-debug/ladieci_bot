'use strict';
// B7A2C architectural guard. Run: node tests/financialBoundaryArchitecture.test.js
// NON-EXECUTING: module-aware source inspection of the financial DAO + service. Proves
// the offline boundary never bypasses SQL authority, plus negative controls that FAIL
// if a violation is introduced. Comment lines are stripped before code scans so guards
// match real code, not documentation.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const DAO_SRC = read('src/auth/financialDao.js');
const SVC_SRC = read('src/auth/financialService.js');
const DAO = strip(DAO_SRC);
const SVC = strip(SVC_SRC);
const BOTH = DAO + '\n' + SVC;

// Detectors (relation/module-aware, applied to comment-stripped code).
const insertsLedger = (s) => /order_financial_events/.test(s);
const writesOrdenesTable = (s) =>
  /sbRest\(\s*['"](?:POST|PATCH|PUT|DELETE)['"]\s*,\s*['"]ordenes\b/i.test(s)
  || /from\(\s*['"]ordenes['"]\s*\)\s*\.\s*(?:update|insert|upsert|delete)\s*\(/i.test(s)
  || /rest\/v1\/ordenes\b/i.test(s);
const genericEventWriter = (s) => /insertFinancialEvent|writeLedger|insertLedger|order_insert_financial_event|financialEventWriter/i.test(s);
const buildsDigest = (s) => /createHash|sha256|payload_digest|computeDigest|\bdigest\b\s*=/.test(s);
const derivesRefundAmount = (s) => {
  // refund/void RPC payloads must carry NO amount; only import may send p_amount.
  const refundBlock = s.slice(s.indexOf("'order_refund'"), s.indexOf('}', s.indexOf("'order_refund'")) + 1);
  const voidBlock = s.slice(s.indexOf("'order_void'"), s.indexOf('}', s.indexOf("'order_void'")) + 1);
  const markBlock = s.slice(s.indexOf("'order_mark_paid'"), s.indexOf('}', s.indexOf("'order_mark_paid'")) + 1);
  return /p_amount/.test(refundBlock) || /p_amount/.test(voidBlock) || /p_amount/.test(markBlock);
};
const passesCallerRole = (s) => /p_by_role|p_expected_role|p_role\b|p_actor_role/.test(s);
const hasRetry = (s) => /for\s*\([^)]*retry|while\s*\([^)]*retry|retr(y|ies)\s*[<>=]|attempt\s*<|\.retry\(|setTimeout\([\s\S]*rpc/i.test(s);
const hasHttpWiring = (s) => /require\(['"]express|app\.(get|post|put|delete)\(|router\.(get|post|put|delete)\(|\(req\s*,\s*res\)|res\.(status|json|send)\(/.test(s);
const modifiesMigrations = (s) => /CREATE OR REPLACE FUNCTION|writeFileSync\([^)]*migrations|migrations\/[\w-]+\.sql/i.test(s);
const logsSensitive = (s) => /logger\.(info|warn|error|debug)\([\s\S]{0,400}?(meta|ip_hash|ipHash|payload_digest|\bdigest\b|confirmation|\bpin\b|serviceKey|SUPABASE_KEY|\bamount\b|\breason\b)/i.test(s);

// ── positive guards ─────────────────────────────────────────────────────────
assert('DAO does not touch order_financial_events', !insertsLedger(DAO));
assert('DAO/service do not write ordenes table directly', !writesOrdenesTable(BOTH));
assert('no generic financial event writer', !genericEventWriter(BOTH));
assert('no Node-side digest construction', !buildsDigest(BOTH));
assert('no Node-side amount on refund/void/mark_paid payloads', !derivesRefundAmount(DAO));
assert('import is the only RPC carrying p_amount', /'order_import_legacy_payment'[\s\S]*?p_amount/.test(DAO));
assert('no caller-supplied actor role sent to SQL', !passesCallerRole(BOTH));
assert('no automatic retry around a mutation', !hasRetry(BOTH));
assert('single RPC transport call per DAO method', (DAO.match(/await rpc\(/g) || []).length === 4 && (DAO.match(/sbRest\(/g) || []).length === 1);
assert('no HTTP/router wiring in this phase', !hasHttpWiring(BOTH));
assert('does not modify SQL migrations', !modifiesMigrations(BOTH));
assert('actor sourced from context.sub (not request-body actor)', /authContext\.sub|const sub = authContext\.sub/.test(SVC) && !/req\.body\.actor|body\.actor|args\.actor/.test(SVC));
assert('service never reads a body-supplied role into a payload', !/p_by_role|expectedRole|byRole/.test(SVC));
assert('logging limited to safe operational fields', !logsSensitive(BOTH) && /order_id: orderId, by_actor: byActor, outcome, code/.test(SVC));
// S2-7D6E SUPERSEDES the B7A2C "UNWIRED" clause. Keeping the ledger disconnected was the
// direct cause of the live staging defect (order #723: cash collected, order RETIRADO, but
// cobrado=false and zero ledger rows, so the closeout reported Cobrado 0.00 on a real 12.00
// sale). The DAO/service are now reachable from index.js, but through exactly ONE operator
// entry point. The invariant that still matters — and that this assertion now guards — is
// that index.js never bypasses that entry point to touch the DAO or the RPCs directly.
assert('DAO reached only via the operator payment registrar', (() => {
  const idx = read('index.js');
  const usesRegistrar = /createOperatorPaymentRegistrar/.test(idx);
  const constructsOnce = (idx.match(/createFinancialDao\(/g) || []).length === 1
    && (idx.match(/createFinancialService\(/g) || []).length === 1;
  // Quoted form only: an RPC name is only *invoked* as a string literal. Naming one in a
  // comment is documentation, not a bypass, and must not fail the boundary check.
  const noDirectRpc = !/['"`]order_(mark_paid|refund|void|import_legacy_payment)['"`]/.test(idx);
  const noDirectDaoCall = !/\.markOrderPaid\(|\.refundOrder\(|\.voidOrder\(|\.importLegacyPayment\(/.test(idx);
  return usesRegistrar && constructsOnce && noDirectRpc && noDirectDaoCall;
})());

// ── NEGATIVE CONTROLS: each detector must fire on an injected violation ──────
assert('NC1: direct ledger insert detected', insertsLedger(DAO + "\nawait sbRest('POST','order_financial_events',{body:{}});"));
assert('NC2: direct ordenes update detected', writesOrdenesTable(DAO + "\nawait sbRest('PATCH','ordenes',{body:{estado:'ANULADO'}});"));
assert('NC3: generic event writer detected', genericEventWriter(DAO + '\nfunction insertFinancialEvent(){}'));
assert('NC4: Node-side digest detected', buildsDigest(DAO + "\nconst d = require('crypto').createHash('sha256');"));
assert('NC5: refund amount derivation detected', derivesRefundAmount(DAO.replace("'order_refund', {\n      p_order_id: orderId,", "'order_refund', {\n      p_amount: 1, p_order_id: orderId,")));
assert('NC6: caller role passed detected', passesCallerRole(DAO + '\nconst x = { p_by_role: role };'));
assert('NC7: automatic retry detected', hasRetry(DAO + '\nfor (let attempt < 3;) { await rpc(); }'));
assert('NC8: HTTP wiring detected', hasHttpWiring(SVC + '\nrouter.post("/refund", (req, res) => res.json({}));'));
assert('NC9: migration modification detected', modifiesMigrations(DAO + "\nfs.writeFileSync('migrations/x.sql','CREATE OR REPLACE FUNCTION');"));
assert('NC10: sensitive logging detected', logsSensitive(SVC + '\nlogger.info({ payload_digest: d, ip_hash: h });'));

// ── session-version guard (B7A2D) ────────────────────────────────────────────
// DAO forwards p_session_version in every RPC payload; service takes it from the
// trusted context (authContext.sv) and NEVER from the request body.
const daoSessionCount = (s) => (s.match(/p_session_version:\s*sessionVersion/g) || []).length;
const svcForwardsCtxSv = (s) => /sessionVersion:\s*authContext\.sv/.test(s);
const svcReadsBodySession = (s) => /\b(?:b|body|req\.body)\.(sv|sessionVersion|session_version|p_session_version)\b/.test(s);
assert('DAO forwards p_session_version in all four RPC payloads', daoSessionCount(DAO) === 4);
assert('service forwards session version from trusted context (authContext.sv)', svcForwardsCtxSv(SVC));
assert('service validates a positive integer session_version before DAO', /Number\.isInteger\(authContext\.sv\)\s*\|\|\s*authContext\.sv\s*<\s*1/.test(SVC));
assert('service never reads a body-supplied session version', !svcReadsBodySession(SVC));
// NC11: an RPC payload omitting p_session_version is detected
assert('NC11: DAO omission of p_session_version detected', daoSessionCount(DAO) === 4 && daoSessionCount(DAO.replace(/p_session_version:\s*sessionVersion,\s*/, '')) === 3);
// NC12: service dropping the trusted-context sv forward is detected
assert('NC12: service omission of trusted sv forward detected', svcForwardsCtxSv(SVC) && !svcForwardsCtxSv(SVC.replace(/sessionVersion:\s*authContext\.sv/g, 'x: 1')));
// NC13: service reading a body-controlled session version is detected
assert('NC13: body-controlled session version detected', !svcReadsBodySession(SVC) && svcReadsBodySession(SVC + '\nconst v = body.sessionVersion;'));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
