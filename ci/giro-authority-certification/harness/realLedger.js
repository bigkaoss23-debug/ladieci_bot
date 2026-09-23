'use strict';
// Installs the REAL economic ledger on top of a fixture database (ephemeral PostgreSQL only).
// Replaces the W3 economic stubs with the live table shapes (fixture/real_ledger_v1.sql) and installs the
// three writer/classifier functions VERBATIM from migrations/. Every function body is then compared with the
// md5(prosrc) read from staging (SELECT-only, 2026-09-19): a mismatch is returned to the caller, which fails
// the run -- the proofs below are only meaningful if the ledger under test IS the live ledger.

const rt = require('./pgRuntime');

// md5(prosrc) on staging tdikhfeinufaahagmpjz, 2026-09-19 (ledger tip 138).
const LIVE_MD5 = Object.freeze({
  _ledger_write_payment: '94fa5265c0ad334b79f3f00228f8300d',
  order_post_payment_v1: '778cd30008632707e47a372e6afa5640',
  classify_economic_period_v1: null, // repo body verified by identity of source only (immutable helper, not md5-pinned on staging)
  mesa_append_only_v1: 'c6b87e45c54e88ea189a23c411fff6a0',
  order_canonical_obligation_v1: 'c68e831344fd537128608567727c2f9d',
  order_financial_events_append_only: '7455e58ce21a485c4ea1c1d35b10505a',
  order_obligation_anchor_v1: '97bf65b4e31d63a81c4d6d234a45b898',
  order_obligation_revision_v1: '49387a6bf8e0ec66694d7bebe14d3d17',
  order_obligations_append_only_v1: '0f03a69b95ad691c7b999e0a89592913',
  payment_transactions_stamp_economic_period_v1: '841ba7aaa34748d26e8059c26e8f9137',
  service_session_assign_financial_event: '0354a6cf78ba634a7c80bb214b494a07',
});

// The complete CREATE OR REPLACE FUNCTION statement (dollar-quoted body included) from a migration file.
function extractStatement(sql, name) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const i = sql.indexOf(marker);
  if (i < 0) throw new Error(`function ${name} not found`);
  const open = /AS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(i));
  if (!open) throw new Error(`function ${name}: no dollar-quoted body`);
  const tag = open[1];
  const bodyStart = i + open.index + open[0].length;
  const end = sql.indexOf(tag, bodyStart);
  if (end < 0) throw new Error(`function ${name}: unterminated body`);
  return sql.slice(i, end + tag.length) + ';';
}

async function installRealLedger(su) {
  // order_post_payment_v1 resolves digest() through search_path "public, extensions, pg_temp" (pgcrypto lives in the
  // `extensions` schema on Supabase). Same shape here.
  await su.query(`CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
    GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;`);
  // The verbatim live function bodies first (they name tables the next file creates), then the table shapes + triggers.
  await su.query(rt.readCert('fixture/real_ledger_functions_v1.sql.txt'));
  await su.query(rt.readCert('fixture/real_ledger_v1.sql'));

  const m126 = rt.readRepo('migrations/2026-09-11_economic_writer_hardening_v1_migration_126.sql');
  const sc = rt.readRepo('migrations/2026-08-17_s_c_economic_period_stamping.sql');
  const stmts = [
    ['classify_economic_period_v1', extractStatement(sc, 'classify_economic_period_v1')],
    ['_ledger_write_payment', extractStatement(m126, '_ledger_write_payment')],
    ['order_post_payment_v1', extractStatement(m126, 'order_post_payment_v1')],
  ];
  await su.query('SET ROLE postgres');
  for (const [, text] of stmts) await su.query(text);
  await su.query(
    'REVOKE ALL ON FUNCTION public._ledger_write_payment(text,text,text,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public._ledger_write_payment(text,text,text,text,text,text,jsonb,text) TO service_role; ' +
    'REVOKE ALL ON FUNCTION public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean) TO service_role; ' +
    'REVOKE ALL ON FUNCTION public.classify_economic_period_v1(timestamptz) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public.classify_economic_period_v1(timestamptz) TO service_role;');
  await su.query('RESET ROLE');
  // The W3 write audit (statement-level, fires even for zero-row statements) follows the real tables.
  await su.query(`DO $$
    DECLARE t text;
    BEGIN
      FOREACH t IN ARRAY ARRAY['order_obligations', 'order_financial_events', 'payment_transactions'] LOOP
        EXECUTE format('CREATE TRIGGER zz_fixture_write_audit AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION fixture_audit.record_write()', t);
      END LOOP;
    END $$;`);

  const md5s = (await su.query(
    `SELECT p.proname, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY ($1::text[])`, [Object.keys(LIVE_MD5)])).rows;
  const mismatches = [];
  for (const r of md5s) {
    const want = LIVE_MD5[r.proname];
    if (want && r.md5 !== want) mismatches.push({ fn: r.proname, got: r.md5, want });
  }
  const missing = Object.keys(LIVE_MD5).filter((k) => !md5s.some((r) => r.proname === k));
  return { mismatches, missing, checked: md5s.length };
}

// The three actors the ledger's CHECK constraints admit, all in the singleton workspace.
async function seedActors(su) {
  await su.query(`
    INSERT INTO public.auth_actors (actor, role, active, session_version, workspace_id)
    SELECT a.actor, a.role, true, 1, (SELECT id FROM public.workspaces ORDER BY name LIMIT 1)
      FROM (VALUES ('rider', 'rider'), ('operator_primary', 'operator'), ('operator_backup', 'operator'), ('owner', 'admin')) AS a(actor, role)
    ON CONFLICT (actor) DO UPDATE SET role = EXCLUDED.role, active = true, session_version = 1,
                                      workspace_id = EXCLUDED.workspace_id`);
}

module.exports = { installRealLedger, seedActors, LIVE_MD5, extractStatement };
