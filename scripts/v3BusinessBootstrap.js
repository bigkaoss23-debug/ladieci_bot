#!/usr/bin/env node
'use strict';
// V3 BUSINESS BOOTSTRAP -- the deterministic first-owner procedure of a greenfield V3 database. SEPARATE from the schema baseline.
// Contract: docs/V3_GREENFIELD_INSTALL_AND_BOOTSTRAP_CONTRACT.md.
//
// WHY. The schema baseline carries no business row. A V3 database becomes usable only once it has ONE workspace with ONE active owner and
// the four canonical actors bound to that workspace (auth_actors.workspace_id is NOT NULL since V3-A, so the actors cannot exist before the
// workspace). Historically the four actors were seeded by the pre-V3 B0 migration and later bound by auth_account_claim_workspace; on a
// greenfield database nothing creates them: no RPC, no backend path (verified). This script is that step, written once, reviewed, in the
// repository -- never copied from staging (no staging UUID, no staging PIN, no staging config value).
//
// WHAT IT DOES (ONE transaction, as role postgres, on a database at POST_APPLY with a consistent ledger and NO workspace / actor / service):
//   1. the owner's Supabase Auth user must already exist (created by the owner's own sign-up; the auth.users trigger created user_profiles);
//   2. auth_account_claim_workspace(owner_user_id, slug, display_name) -- the product's own claim RPC: workspace (provisioning -> active),
//      owner membership, two audit rows;
//   3. the four canonical actors (owner:admin, operator_primary:operator, operator_backup:operator, rider:rider) bound to that workspace,
//      with NO PIN (pin_hash NULL), exactly the shape the V3-A migration found for them (created_by NULL, session_version 1, active);
//   4. post-conditions: one workspace, active, one active owner membership, exactly the four actors, all without PIN, no service opened.
// WHAT IT NEVER DOES: set a PIN (the owner does it in the app: auth_set_actor_pin_v3, caller_kind account_owner), create access users
// (the owner does it in the app: auth_create_access_user_v3), create tables (mesa_save_table_v1 from the Mesa admin), menu or restaurant
// configuration (the admin screens / env), import legacy data (the cutover importer, docs/LEGACY_IMPORT_CONTRACT.md), open a service.
//
// Usage (connection as for scripts/economyChainApply.js):
//   node scripts/v3BusinessBootstrap.js check                         READ-ONLY: bootstrap state
//   node scripts/v3BusinessBootstrap.js apply --config <file.json>    {"owner_user_id": "<uuid>", "workspace": {"slug": "...", "display_name": "..."}}
// Idempotent: re-running with the same config on a bootstrapped database changes nothing (ALREADY_BOOTSTRAPPED); a different config is refused.
// Exit code: 0 done / already done, 1 refused (nothing changed), 2 usage / connection error.

const fs = require('fs');
const path = require('path');
const CA = require('./economyChainApply.js');

const CANONICAL_ACTORS = [['owner', 'admin'], ['operator_primary', 'operator'], ['operator_backup', 'operator'], ['rider', 'rider']];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATE_SQL = `SELECT
  (SELECT count(*) FROM public.workspaces)::int AS workspaces,
  (SELECT json_agg(json_build_object('id', id, 'slug', slug, 'lifecycle_status', lifecycle_status)) FROM public.workspaces) AS workspace_rows,
  (SELECT count(*) FROM public.workspace_memberships WHERE role = 'workspace_owner' AND status = 'active')::int AS active_owners,
  (SELECT json_agg(json_build_object('user_id', user_id, 'workspace_id', workspace_id)) FROM public.workspace_memberships WHERE role = 'workspace_owner' AND status = 'active') AS owner_rows,
  (SELECT json_agg(actor || ':' || role ORDER BY actor) FROM public.auth_actors) AS actors,
  (SELECT count(*) FROM public.auth_actors WHERE pin_hash IS NOT NULL)::int AS actors_with_pin,
  (SELECT count(DISTINCT workspace_id) FROM public.auth_actors)::int AS actor_workspaces,
  (SELECT count(*) FROM public.service_sessions)::int AS services,
  (SELECT count(*) FROM public.restaurant_tables)::int AS tables,
  (SELECT count(*) FROM public.menu_productos)::int AS menu_products,
  (SELECT json_agg(chiave ORDER BY chiave) FROM public.config) AS config_keys`;

async function state(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try { return (await client.query(STATE_SQL)).rows[0]; } finally { await client.query('ROLLBACK'); }
}

function readConfig(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = [];
  if (!UUID_RE.test(String(c.owner_user_id || ''))) bad.push('owner_user_id must be the owner\'s Supabase Auth user uuid');
  if (!c.workspace || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(String(c.workspace.slug || ''))) bad.push('workspace.slug: lowercase letters, digits, dashes');
  if (!c.workspace || !String(c.workspace.display_name || '').trim()) bad.push('workspace.display_name required');
  const extra = Object.keys(c).filter((k) => !['owner_user_id', 'workspace'].includes(k));
  if (extra.length) bad.push(`unknown keys ${extra.join(', ')}: tables / menu / config / PINs are NOT bootstrap inputs`);
  if (bad.length) throw Object.assign(new Error('invalid bootstrap config: ' + bad.join('; ')), { code: 'USAGE' });
  return { owner: c.owner_user_id, slug: c.workspace.slug, name: c.workspace.display_name.trim() };
}

const bootstrapped = (st, cfg) => st.workspaces === 1 && st.active_owners === 1 && st.workspace_rows[0].slug === cfg.slug && st.owner_rows[0].user_id === cfg.owner
  && JSON.stringify(st.actors) === JSON.stringify(CANONICAL_ACTORS.map(([a, r]) => `${a}:${r}`).sort()) && st.actor_workspaces === 1;

async function apply(client, cfg, { log = console.error } = {}) {
  const pos = await CA.position(client, true);
  if (pos.mode !== 'POST_APPLY' || !pos.ledgerOk) return { code: 1, result: 'REFUSED_NOT_POST_APPLY', detail: { mode: pos.mode, ledger: pos.ledgerDetail } };
  const st = await state(client);
  if (st.workspaces > 0 || (st.actors || []).length > 0) {
    if (bootstrapped(st, cfg)) return { code: 0, result: 'ALREADY_BOOTSTRAPPED', state: st };
    return { code: 1, result: 'REFUSED_NOT_EMPTY', detail: 'a workspace or an actor already exists and does not match this config', state: st };
  }
  if (st.services > 0) return { code: 1, result: 'REFUSED_SERVED', detail: 'a service exists: this is not a greenfield database' };
  await client.query('BEGIN');
  try {
    const u = (await client.query('SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = $1) AS auth, EXISTS (SELECT 1 FROM public.user_profiles WHERE id = $1) AS profile', [cfg.owner])).rows[0];
    if (!u.auth) throw Object.assign(new Error('the owner auth user does not exist: the owner signs up first (Supabase Auth)'), { code: 'OWNER_MISSING' });
    if (!u.profile) throw Object.assign(new Error('user_profiles row missing: the on_auth_user_created trigger did not run'), { code: 'OWNER_MISSING' });
    const claim = (await client.query('SELECT public.auth_account_claim_workspace($1, $2, $3) AS r', [cfg.owner, cfg.slug, cfg.name])).rows[0].r;
    if (claim.created !== true) throw new Error('claim did not create the workspace');
    for (const [actor, role] of CANONICAL_ACTORS) {
      await client.query(`INSERT INTO public.auth_actors (actor, role, workspace_id, pin_hash, session_version, active, failed_count, created_by)
        VALUES ($1, $2, $3, NULL, 1, true, 0, NULL)`, [actor, role, claim.workspace_id]);
    }
    const after = (await client.query(STATE_SQL)).rows[0];
    const problems = [];
    if (!bootstrapped(after, cfg)) problems.push('post-condition: workspace / owner / actors');
    if (after.workspace_rows[0].lifecycle_status !== 'active') problems.push('workspace not active');
    if (after.actors_with_pin !== 0) problems.push('an actor has a PIN');
    if (after.services !== 0) problems.push('a service was opened');
    if (problems.length) throw new Error(problems.join('; '));
    await client.query('COMMIT');
    log(`bootstrapped workspace ${cfg.slug} (${claim.workspace_id}) for owner ${cfg.owner}; next: the owner sets the PIN in the app`);
    return { code: 0, result: 'BOOTSTRAPPED', workspace_id: claim.workspace_id, state: after,
      next: ['owner PIN: the owner, signed in, sets it in the app (auth_set_actor_pin_v3, caller_kind account_owner)',
        'access users: created by the owner in the app (auth_create_access_user_v3)', 'tables: Mesa admin (mesa_save_table_v1)',
        'menu + restaurant configuration: admin screens / environment', 'legacy commercial import: docs/LEGACY_IMPORT_CONTRACT.md'] };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { code: 1, result: 'REFUSED_ROLLED_BACK', detail: e.message };
  }
}

module.exports = { apply, state, readConfig, CANONICAL_ACTORS };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    if (!['check', 'apply'].includes(cmd) || (cmd === 'apply' && !opt('--config'))) { console.error('usage: v3BusinessBootstrap.js check | apply --config <file.json>'); process.exit(2); }
    let cfg; if (cmd === 'apply') { try { cfg = readConfig(path.resolve(opt('--config'))); } catch (e) { console.error(e.message); process.exit(2); } }
    let client; try { client = await CA.connect(); } catch (e) { console.error('connection error: ' + e.message); process.exit(2); }
    try {
      const r = cmd === 'check' ? { code: 0, state: await state(client) } : await apply(client, cfg);
      console.log(JSON.stringify(r, null, 1)); process.exit(r.code);
    } finally { await client.end().catch(() => {}); }
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
