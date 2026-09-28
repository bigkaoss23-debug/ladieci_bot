'use strict';
// scripts/lib/postFreezeLayerChecks.js -- the exact catalog state of every OWN post-freeze layer (scripts/lib/postFreezeLayers.js).
// Each check is a read-only read() (safe inside or outside a transaction, on a database with or without the layer) and a pure classify():
//   ABSENT    nothing of the layer exists
//   APPLIED   every object exists with its certified definition (pinned fingerprints below)
//   DETACHED  (layers with a DETACH rollback) the retained part exists exactly, the attached part is gone
//   DRIFT     anything else -- every mutating command of the runner refuses it (fail closed)
// The pins are the fingerprints the certified forward file produces on PostgreSQL 17 (recorded in the lab, re-checked by the runner inside
// the apply transaction). A change of the forward file changes its sha256 AND these pins, in the same reviewed change.

// ── layer 170: FISCAL_PREREQ / P1 sale_evidence ────────────────────────────────────────────────────────────────────────────────────────
// retained part (identical when APPLIED and when DETACHED): every object of schema sale_evidence except the capture function
const L170_RETAINED_SQL = `
  SELECT md5(string_agg(x, E'\\n' ORDER BY x COLLATE "C")) FROM (
    SELECT 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || p.prosecdef::text || ' ' || p.provolatile::text || ' '
           || COALESCE(array_to_string(p.proconfig, ','), '') || ' ' || pg_get_userbyid(p.proowner) || ' ' || COALESCE(array_to_string(p.proacl, ','), '') AS x
      FROM pg_proc p WHERE p.pronamespace = to_regnamespace('sale_evidence') AND p.proname <> 'capture_composition_v1'
    UNION ALL
    SELECT 'col ' || c.relname || ' ' || lpad(a.attnum::text, 3, '0') || ' ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' '
           || a.attnotnull::text || ' ' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relnamespace = to_regnamespace('sale_evidence') AND c.relkind = 'r'
    UNION ALL
    SELECT 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || pg_get_userbyid(c.relowner) || ' rls=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
           || ' acl=' || COALESCE(array_to_string(c.relacl, ','), '')
      FROM pg_class c WHERE c.relnamespace = to_regnamespace('sale_evidence')
    UNION ALL
    SELECT 'con ' || t.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
      FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid WHERE k.connamespace = to_regnamespace('sale_evidence')
    UNION ALL
    SELECT 'idx ' || pg_get_indexdef(i.indexrelid)
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid WHERE t.relnamespace = to_regnamespace('sale_evidence')
    UNION ALL
    SELECT 'trg ' || t.relname || ' ' || g.tgname || ' ' || g.tgenabled::text || ' ' || pg_get_triggerdef(g.oid)
      FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid WHERE t.relnamespace = to_regnamespace('sale_evidence') AND NOT g.tgisinternal
    UNION ALL
    SELECT 'pol ' || tablename || ' ' || policyname FROM pg_policies WHERE schemaname = 'sale_evidence'
    UNION ALL
    SELECT 'nsp ' || pg_get_userbyid(n.nspowner) || ' ' || COALESCE(array_to_string(n.nspacl, ','), '') FROM pg_namespace n WHERE n.nspname = 'sale_evidence'
    UNION ALL
    SELECT 'pub ' || pr.prrelid::regclass::text FROM pg_publication_rel pr JOIN pg_class c ON c.oid = pr.prrelid WHERE c.relnamespace = to_regnamespace('sale_evidence')
  ) s`;

const L170_STATE_SQL = `SELECT
    to_regnamespace('sale_evidence') IS NOT NULL AS schema_present,
    (${L170_RETAINED_SQL}) AS retained_fp,
    (SELECT md5(p.prosrc) || ' ' || p.prosecdef::text || ' ' || COALESCE(array_to_string(p.proconfig, ','), '') || ' ' || pg_get_userbyid(p.proowner)
            || ' ' || COALESCE(array_to_string(p.proacl, ','), '')
       FROM pg_proc p WHERE p.oid = to_regprocedure('sale_evidence.capture_composition_v1()')) AS capture_fn,
    (SELECT string_agg(g.tgenabled::text || ' ' || pg_get_triggerdef(g.oid), E'\\n' ORDER BY g.tgname COLLATE "C")
       FROM pg_trigger g WHERE g.tgname LIKE 'ordenes\\_zzz\\_sale\\_evidence\\_%' OR g.tgfoid = COALESCE(to_regprocedure('sale_evidence.capture_composition_v1()'), 0)) AS capture_triggers`;

// the data part, read only when the tables exist (a second statement: plain SQL cannot name a table that may not exist)
const L170_DATA_SQL = `SELECT
    (SELECT event FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1) AS last_epoch,
    (SELECT count(*)::int FROM sale_evidence.capture_epochs) AS epochs,
    (SELECT count(*)::int FROM sale_evidence.composition_revisions) AS revisions,
    (SELECT count(*)::int FROM sale_evidence.history_gap_markers) AS markers`;

const L170_PINS = Object.freeze({
  retained_fp: "84d39a8c192c665fd20042cec5d71d3d",
  capture_fn: "76a41ccee9faa5d774eb4eeb8e8d737d true search_path=pg_catalog, pg_temp postgres postgres=X/postgres",
  // language-guard: allow-legacy the pinned trigger definitions name the existing ordenes column tipo_consegna
  capture_triggers: "O CREATE TRIGGER ordenes_zzz_sale_evidence_capture_ins_v1 AFTER INSERT ON public.ordenes FOR EACH ROW WHEN ((new.table_session_id IS NULL)) EXECUTE FUNCTION sale_evidence.capture_composition_v1()\nO CREATE TRIGGER ordenes_zzz_sale_evidence_capture_upd_v1 AFTER UPDATE OF items, totale, delivery_fee, descuento_tipo, descuento_valor, descuento_importe, tipo_consegna ON public.ordenes FOR EACH ROW WHEN (((new.table_session_id IS NULL) AND ((old.items IS DISTINCT FROM new.items) OR (old.totale IS DISTINCT FROM new.totale) OR (old.delivery_fee IS DISTINCT FROM new.delivery_fee) OR (old.descuento_tipo IS DISTINCT FROM new.descuento_tipo) OR (old.descuento_valor IS DISTINCT FROM new.descuento_valor) OR (old.descuento_importe IS DISTINCT FROM new.descuento_importe) OR (old.tipo_consegna IS DISTINCT FROM new.tipo_consegna)))) EXECUTE FUNCTION sale_evidence.capture_composition_v1()",
});

// ONE catalog SELECT, then (only if the layer's tables exist) ONE data SELECT; both read-only, in the caller's transaction if any.
async function read170(client) {
  const s = (await client.query(L170_STATE_SQL)).rows[0];
  const tables = (await client.query(`SELECT to_regclass('sale_evidence.capture_epochs') IS NOT NULL AND to_regclass('sale_evidence.composition_revisions') IS NOT NULL
      AND to_regclass('sale_evidence.history_gap_markers') IS NOT NULL AS ok`)).rows[0].ok;
  const d = tables ? (await client.query(L170_DATA_SQL)).rows[0] : { last_epoch: null, epochs: null, revisions: null, markers: null };
  return { ...s, ...d };
}

function classify170(s, pins = L170_PINS) {
  const nothing = !s.schema_present && s.capture_fn == null && s.capture_triggers == null;
  if (nothing) return 'ABSENT';
  const retained = s.schema_present && s.retained_fp === pins.retained_fp;
  if (retained && s.capture_fn === pins.capture_fn && s.capture_triggers === pins.capture_triggers && s.last_epoch === 'ATTACHED') return 'APPLIED';
  if (retained && s.capture_fn == null && s.capture_triggers == null && s.last_epoch === 'DETACHED') return 'DETACHED';
  return 'DRIFT';
}

const LAYER_CHECKS = Object.freeze({
  170: Object.freeze({ read: read170, classify: classify170, pins: L170_PINS }),
});

module.exports = { LAYER_CHECKS, L170_STATE_SQL, L170_DATA_SQL, L170_PINS, read170, classify170 };
