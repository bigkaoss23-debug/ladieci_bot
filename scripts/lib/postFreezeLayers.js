'use strict';
// scripts/lib/postFreezeLayers.js -- THE registry of POST-FREEZE layers: migrations that come after the Economy 139 -> 156 freeze and are NOT
// part of it. Contract: docs/POST_FREEZE_LAYERS_CONTRACT.md. Dependency-free on purpose (read by scripts/postFreezeLayerApply.js, by the
// static tests, and -- in the integration of the SECURITY/G4 work -- by the Economy tooling's ledger rule).
//
// NUMBERING / NAMESPACE POLICY (v1)
//   139 .. 156   ECONOMY, frozen and closed (141 / 142 are void forever). Nothing in this registry may use a number <= 156.
//   Numbers above 156 are allocated in DOMAIN RANGES, so that work streams developed in parallel isolated copies (security, fiscal, delivery)
//   never have to renumber a certified file when they are integrated:
//     157 .. 169   SECURITY         (157 = SECURITY/G4, isolated copy ~/Downloads/ladieci-g4-security-be; G4b takes the next free number)
//     170 .. 189   FISCAL_PREREQ    (170 = FP-1 sale_evidence; FP-2 identity, FP-3 tax config, FP-5 emission config take the next free numbers)
//     190 .. 209   FISCAL_CORE      (Fiscal Candidate read adapter, Fiscal Core; nothing allocated yet)
//     210 .. 229   DELIVERY         (G2 Delivery work; nothing allocated yet)
//     >= 230       unallocated: a new domain gets a range by a reviewed change of THIS file.
//   A number is allocated ONLY by an entry here; it must lie in its domain's range, be unique, and appear in the file name
//   (`_layer_<n>.sql`; the G4 file keeps its historical `_migration_157.sql` name). apply_order is the ledger identity of a layer, NOT
//   its chronology: layers of different domains may be applied in any order unless an entry declares `requires`.
//   status OWN      = the certified file pair lives in this checkout; scripts/postFreezeLayerApply.js applies / rolls it back.
//   status EXTERNAL = certified in another isolated copy and integrated later; this checkout never applies, rolls back or verifies it, but a
//                     database carrying EXACTLY its ledger row (apply_order, filename, sha256/16) is accepted as known (fail closed on any
//                     other row above 156).

const ECONOMY_FROZEN_TIP = 156;

const DOMAINS = Object.freeze([
  Object.freeze({ domain: 'SECURITY', from: 157, to: 169 }),
  Object.freeze({ domain: 'FISCAL_PREREQ', from: 170, to: 189 }),
  Object.freeze({ domain: 'FISCAL_CORE', from: 190, to: 209 }),
  Object.freeze({ domain: 'DELIVERY', from: 210, to: 229 }),
]);

const POST_FREEZE_LAYERS = Object.freeze([
  Object.freeze({
    n: 157, domain: 'SECURITY', name: 'SECURITY/G4 clientes + geo_cache anon exposure', status: 'EXTERNAL',
    dir: 'migrations/post_freeze', file: '2026-09-27_g4_clientes_geo_cache_rls_hardening_v1_migration_157.sql',
    sha: '0880353a36abbb876d0610d453c49c19e18308282019f6ae9e9a372088d540c1', rbkSha: '47685c26d141a9299a02f0576a0d4fadb1d0f34d4337d8a3f532790bb3262105',
    origin: '~/Downloads/ladieci-g4-security-be (G4_SECURITY_PASS local 2026-09-27, not deployed)',
  }),
]);

const domainOf = (n) => DOMAINS.find((d) => n >= d.from && n <= d.to) || null;
const layerOf = (n) => POST_FREEZE_LAYERS.find((l) => l.n === n) || null;
// A ledger row above the Economy tip is known iff it is EXACTLY a registered layer (own or external).
const isCertifiedPostFreezeRow = (row) => POST_FREEZE_LAYERS.some((l) => l.n === row.apply_order && l.file === row.filename && l.sha.slice(0, 16) === row.checksum_sha256);

module.exports = { ECONOMY_FROZEN_TIP, DOMAINS, POST_FREEZE_LAYERS, domainOf, layerOf, isCertifiedPostFreezeRow };
