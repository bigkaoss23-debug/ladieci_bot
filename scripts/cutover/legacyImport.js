#!/usr/bin/env node
'use strict';
// LEGACY -> V3 IMPORT (cutover). Contract: docs/LEGACY_IMPORT_CONTRACT.md. Schema: cutover/legacy_archive_v1.sql.
//
// Three domains, never mixed:
//   LEGACY_ARCHIVE      legacy_archive.*       every legacy row, immutable, versioned by content; admin daily snapshot; CUTOVER_AT
//   COMMERCIAL_HISTORY  commercial_history.*   what customers ordered (no money authority, no payment status, no V3 key)
//   V3_CANONICAL        public.*               ONLY public.clientes and public.geo_cache are written (commercial, trigger-free in V3,
//                                              no economic reader); lineage of every write lives in commercial_history.import_lineage
// Never written by this job: ordenes, storico, order_*, payment_*, service_*, cash_counts, orden_estado_logs, business_*, auth_*, config.
// Legacy money never becomes an obligation, a transaction, an allocation, a financial event, a closeout, a reconciliation or a fiscal fact.
//
// Commands (V3: PREFLIGHT_DATABASE_URL / PG* as scripts/economyChainApply.js; legacy: LEGACY_DATABASE_URL, read in a READ ONLY transaction):
//   archive --kind initial|delta|final_delta [--cutover-at <iso>] [--v3-candidate <sha>]   read the legacy DB -> legacy_archive (+ at
//                        final_delta: refuses unless legacy ordenes is empty; writes admin_daily_snapshot and the CUTOVER_AT manifest)
//   commercial --batch <uuid>                     archived rows of that batch -> public.clientes / public.geo_cache (+ lineage) and
//                                                 commercial_history.customer_orders / customer_stats
//   fingerprint                                   READ-ONLY: the V3 economic fingerprint (counts + sums of every economic table)
// Exit code: 0 done, 1 refused, 2 usage / connection error.

const crypto = require('crypto');
const path = require('path');

const LEGACY_TABLES = ['storico', 'serata_summary', 'backup_serata', 'clientes', 'geo_cache', 'orden_estado_logs', 'delivery_logs', 'manual_giros',
  'archivio_conv', 'analisi_serata', 'config', 'conv', 'wa_msgs', 'suggerimenti', 'ordenes'];
const SECRET_KEY_RE = /(KEY|TOKEN|PIN|SECRET|PASSWORD|PASSWD)/i;           // config values that are never archived in clear
const V3_ECONOMIC_TABLES = ['ordenes', 'storico', 'order_entities', 'order_obligations', 'order_financial_events', 'payment_transactions', 'payment_allocations',
  'service_sessions', 'service_closeouts', 'service_closeout_snapshots', 'service_closeout_reconciliations', 'service_closeout_attempts', 'service_incidents',
  'cash_counts', 'business_days', 'period_consolidations', 'table_sessions', 'table_order_lines', 'archived_order_financial_resolutions', 'orden_estado_logs', 'serata_summary'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' && !(v instanceof Date) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v instanceof Date ? v.toISOString() : v === undefined ? null : v));

// V3 stores a phone the way WhatsApp identifies it: international digits, no '+', no separators (agentWhatsapp getCliente,
// readActions.validTelefono). Spanish national numbers (9 digits, 6/7/8/9) get the 34 prefix; '00' is an international prefix.
function normalizeTel(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, reason: 'EMPTY' };
  s = s.replace(/[\s\-.()\/]/g, '');
  if (s.startsWith('+')) s = s.slice(1); else if (s.startsWith('00')) s = s.slice(2);
  if (!/^\d+$/.test(s)) return { ok: false, reason: 'NON_DIGIT' };
  if (/^[6789]\d{8}$/.test(s)) s = '34' + s;
  if (!/^\d{8,15}$/.test(s)) return { ok: false, reason: 'LENGTH' };
  if (s.startsWith('34') && !/^34[6789]\d{8}$/.test(s)) return { ok: false, reason: 'SPANISH_SHAPE' };
  return { ok: true, tel: s };
}

async function pgClient(connectionString) {
  const base = process.env.W3_PG_NODE_MODULES;
  const pg = base ? require(path.join(base, 'pg')) : require('pg');
  const c = connectionString ? new pg.Client({ connectionString }) : new pg.Client();
  await c.connect(); await c.query("SET client_encoding = 'UTF8'");
  return c;
}

async function pkColumns(legacy, table) {
  const r = await legacy.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = ('public.' || quote_ident($1))::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [table]);
  return r.rows.map((x) => x.attname);
}

// ── archive ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function archive({ v3, legacy, kind, legacySource, cutoverAt = null, v3Candidate = null, log = console.error }) {
  if (!['initial', 'delta', 'final_delta'].includes(kind)) return { code: 2, result: 'USAGE' };
  const batch = crypto.randomUUID();
  const readStart = new Date();
  const counts = {}; const hashes = {}; const redacted = []; const rows = [];
  await legacy.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');      // ONE consistent legacy snapshot
  try {
    for (const t of LEGACY_TABLES) {
      if ((await legacy.query('SELECT to_regclass($1) r', ['public.' + t])).rows[0].r === null) { counts[t] = null; continue; }
      const pk = await pkColumns(legacy, t);
      // to_jsonb: the values exactly as PostgreSQL renders them (a date stays 'YYYY-MM-DD', numerics stay exact) -- never re-typed by the driver
      const data = (await legacy.query(`SELECT to_jsonb(x) AS j FROM public.${t} x`)).rows.map((r) => r.j);
      counts[t] = data.length;
      const items = data.map((row) => {
        let r = row;
        if (t === 'config' && SECRET_KEY_RE.test(String(row.chiave))) { r = { ...row, valore: null, redacted: true }; redacted.push(String(row.chiave)); }
        const c = canon(r);
        return { key: pk.length ? pk.map((k) => String(row[k])).join('|') : sha256(c), sha: sha256(c), data: r };
      }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      hashes[t] = sha256(items.map((i) => i.key + ':' + i.sha).join('\n'));
      rows.push(...items.map((i) => [t, i]));
    }
  } finally { await legacy.query('ROLLBACK'); }
  if (kind === 'final_delta' && counts.ordenes) return { code: 1, result: 'REFUSED_LEGACY_NOT_FROZEN', detail: `legacy ordenes has ${counts.ordenes} row(s): close the legacy service first (docs/LEGACY_IMPORT_CONTRACT.md §5)` };
  await v3.query('BEGIN');
  try {
    if (kind === 'final_delta' && (await v3.query('SELECT count(*)::int n FROM legacy_archive.cutover_manifest')).rows[0].n) throw new Error('CUTOVER_AT already recorded');
    await v3.query(`INSERT INTO legacy_archive.import_batches (batch_id, kind, legacy_source, read_started_at, read_ended_at, table_counts, table_sha256, secrets_redacted)
      VALUES ($1, $2, $3, $4, now(), $5, $6, $7)`, [batch, kind, legacySource, readStart, counts, hashes, JSON.stringify(redacted)]);
    let fresh = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const r = await v3.query(`INSERT INTO legacy_archive.source_rows (source_table, legacy_key, row_sha256, row_data, batch_id)
        SELECT x.t, x.k, x.s, x.d, $1 FROM jsonb_to_recordset($2::jsonb) AS x(t text, k text, s text, d jsonb) ON CONFLICT DO NOTHING`,
      [batch, JSON.stringify(chunk.map(([t, it]) => ({ t, k: it.key, s: it.sha, d: it.data })))]);
      fresh += r.rowCount;
    }
    let snapshot = null;
    if (kind === 'final_delta') {
      snapshot = await writeAdminSnapshot(v3, batch);
      const lastFecha = (await v3.query(`SELECT max(business_date)::text d FROM legacy_archive.admin_daily_snapshot`)).rows[0].d;
      const archiveSha = (await v3.query(`SELECT encode(sha256(string_agg(source_table || '|' || legacy_key || '|' || row_sha256, E'\\n' ORDER BY source_table, legacy_key, row_sha256)::bytea), 'hex') h FROM legacy_archive.source_rows`)).rows[0].h;
      await v3.query(`INSERT INTO legacy_archive.cutover_manifest (cutover_at, legacy_last_fecha, final_batch_id, legacy_system, v3_candidate, archive_sha256)
        VALUES ($1, $2, $3, $4, $5, $6)`, [cutoverAt || new Date().toISOString(), lastFecha || '1970-01-01', batch, legacySource, v3Candidate || 'unspecified', archiveSha]);
    }
    await v3.query('COMMIT');
    log(`archive ${kind}: batch ${batch}, ${rows.length} rows read, ${fresh} new archive versions`);
    return { code: 0, result: 'ARCHIVED', batch, kind, counts, newVersions: fresh, redacted, snapshot };
  } catch (e) { await v3.query('ROLLBACK').catch(() => {}); return { code: 1, result: 'REFUSED_ROLLED_BACK', detail: e.message }; }
}

// Latest archived version of each legacy row (content-versioned archive).
const LATEST = (table) => `SELECT DISTINCT ON (legacy_key) legacy_key, row_sha256, row_data, batch_id FROM legacy_archive.source_rows WHERE source_table = '${table}' ORDER BY legacy_key, archived_at DESC, row_sha256`;

async function writeAdminSnapshot(v3, batch) {
  // storico: the legacy "cassa" is the sum of declared order totals (LIVE inventory: serata_summary.cassa_totale = sum(storico.totale)).
  const days = (await v3.query(`WITH st AS (SELECT row_data d FROM (${LATEST('storico')}) x WHERE (row_data->>'fecha') ~ '^\\d{4}-\\d{2}-\\d{2}$')
    SELECT (d->>'fecha')::date::text bd, count(*)::int orders, round(sum(coalesce((d->>'totale')::numeric, 0)), 2) declared_total,
      round(sum(coalesce((d->>'delivery_fee')::numeric, 0)), 2) fees,
      count(*) FILTER (WHERE d->>'tipo_consegna' = 'DOMICILIO')::int delivery, count(*) FILTER (WHERE coalesce(d->>'tipo_consegna', 'RITIRO') <> 'DOMICILIO')::int pickup,
      jsonb_build_object('efectivo', round(sum(coalesce((d->>'totale')::numeric, 0)) FILTER (WHERE lower(coalesce(d->>'metodo_pago', '')) = 'efectivo'), 2),
                         'tarjeta', round(sum(coalesce((d->>'totale')::numeric, 0)) FILTER (WHERE lower(coalesce(d->>'metodo_pago', '')) = 'tarjeta'), 2),
                         'bizum', round(sum(coalesce((d->>'totale')::numeric, 0)) FILTER (WHERE lower(coalesce(d->>'metodo_pago', '')) = 'bizum'), 2),
                         'no_especificado', round(sum(coalesce((d->>'totale')::numeric, 0)) FILTER (WHERE lower(coalesce(d->>'metodo_pago', '')) NOT IN ('efectivo', 'tarjeta', 'bizum')), 2)) by_method
    FROM st GROUP BY 1`)).rows;
  const sums = new Map((await v3.query(`SELECT (row_data->>'fecha')::date::text bd, sum((row_data->>'cassa_totale')::numeric) c FROM (${LATEST('serata_summary')}) x
    WHERE (row_data->>'fecha') ~ '^\\d{4}-\\d{2}-\\d{2}$' GROUP BY 1`)).rows.map((x) => [x.bd, x.c]));
  const all = new Set([...days.map((d) => d.bd), ...sums.keys()]);
  let n = 0;
  for (const bd of [...all].sort()) {
    const d = days.find((x) => x.bd === bd);
    const summary = sums.has(bd) ? Number(sums.get(bd)) : null;
    const coherence = !d ? 'SUMMARY_ONLY' : summary === null ? 'STORICO_ONLY' : Math.round(summary * 100) === Math.round(Number(d.declared_total) * 100) ? 'EQUAL' : 'DIFFERENT';
    await v3.query(`INSERT INTO legacy_archive.admin_daily_snapshot (business_date, orders, declared_total, declared_by_method, delivery_orders, pickup_orders,
      declared_delivery_fees, serata_summary_cassa_totale, coherence, computed_from_batch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [bd, d ? d.orders : 0, d ? d.declared_total : 0, d ? d.by_method : {}, d ? d.delivery : 0, d ? d.pickup : 0, d ? d.fees : 0, summary, coherence, batch]);
    n += 1;
  }
  return { days: n };
}

// ── commercial ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CLIENT_COLS = ['nombre', 'total_pedidos', 'ultimo_pedido', 'ultimo_items', 'pizza_pref', 'bevanda_pref', 'nota_fissa', 'orario_solito', 'direccion', 'direccion_note',
  'zona', 'zona_lat', 'zona_lon', 'durata_andata_min', 'geo_source', 'geo_aggiornato_il', 'direccion_confermata_il', 'alias', 'preferito'];
const GEO_COLS = ['direccion_orig', 'zona', 'lat', 'lon', 'durata_andata_min', 'source', 'hit_count', 'n_ordini_creati', 'n_ordini_consegnati'];

async function commercial({ v3, batch, log = console.error }) {
  const b = (await v3.query('SELECT kind FROM legacy_archive.import_batches WHERE batch_id = $1', [batch])).rows[0];
  if (!b) return { code: 1, result: 'REFUSED_UNKNOWN_BATCH' };
  // every parameter is cast to the V3 column type (no driver / planner type guessing)
  const types = {};
  for (const r of (await v3.query(`SELECT table_name, column_name, format_type(a.atttypid, a.atttypmod) t FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = ('public.' || c.table_name)::regclass AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name IN ('clientes', 'geo_cache')`)).rows) types[`${r.table_name}.${r.column_name}`] = r.t;
  const ph = (table, cols, from) => cols.map((k, i) => `$${i + from}::${types[`${table}.${k}`]}`);
  const out = { clientes: {}, geo_cache: {}, customer_orders: 0, customer_stats: 0 };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  await v3.query('BEGIN');
  try {
    // clientes -> public.clientes (identity key = normalized phone; V3 wins over an import-owned row edited in V3 since)
    const seenTel = new Set(); const seenAlias = new Set((await v3.query("SELECT upper(alias) a FROM public.clientes WHERE alias IS NOT NULL AND alias <> ''")).rows.map((x) => x.a));
    for (const r of (await v3.query(`${LATEST('clientes')}`)).rows) {
      const d = r.row_data; const n = normalizeTel(d.tel || d.wa_id);
      const lin = (outcome, key, tsha, detail) => v3.query(`INSERT INTO commercial_history.import_lineage (batch_id, source_table, legacy_key, source_sha256, target_table, target_key, target_sha256, outcome, detail)
        VALUES ($1, 'clientes', $2, $3, 'public.clientes', $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [batch, r.legacy_key, r.row_sha256, key, tsha, outcome, detail || null]);
      if (!n.ok) { bump(out.clientes, 'SKIPPED_INVALID'); await lin('SKIPPED_INVALID', '-', '-', n.reason); continue; }
      if (seenTel.has(n.tel)) { bump(out.clientes, 'SKIPPED_DUPLICATE'); await lin('SKIPPED_DUPLICATE', n.tel, '-', 'same normalized phone as an earlier legacy row'); continue; }
      seenTel.add(n.tel);
      const vals = Object.fromEntries(CLIENT_COLS.map((k) => [k, d[k] === undefined ? null : d[k]]));
      if (vals.preferito === null) vals.preferito = false;
      if (vals.nombre === null) vals.nombre = '';
      const cur = (await v3.query('SELECT * FROM public.clientes WHERE tel = $1', [n.tel])).rows[0];
      if (vals.alias && String(vals.alias).trim() && (!cur || String(cur.alias || '').toUpperCase() !== String(vals.alias).toUpperCase()) && seenAlias.has(String(vals.alias).toUpperCase())) vals.alias = null;
      if (cur) {
        const prev = (await v3.query(`SELECT target_sha256 FROM commercial_history.import_lineage WHERE target_table = 'public.clientes' AND target_key = $1 AND outcome IN ('INSERTED','UPDATED') ORDER BY imported_at DESC LIMIT 1`, [n.tel])).rows[0];
        if (!prev || prev.target_sha256 !== sha256(canon(rowOf(cur, CLIENT_COLS)))) { bump(out.clientes, 'SKIPPED_V3_WINS'); await lin('SKIPPED_V3_WINS', n.tel, sha256(canon(rowOf(cur, CLIENT_COLS))), prev ? 'edited in V3 after the import' : 'created in V3'); continue; }
        const P = ph('clientes', CLIENT_COLS, 2);
        await v3.query(`UPDATE public.clientes SET ${CLIENT_COLS.map((k, i) => `${k} = ${P[i]}`).join(', ')} WHERE tel = $1`, [n.tel, ...CLIENT_COLS.map((k) => json(vals[k]))]);
        const after = (await v3.query('SELECT * FROM public.clientes WHERE tel = $1', [n.tel])).rows[0];
        bump(out.clientes, 'UPDATED'); await lin('UPDATED', n.tel, sha256(canon(rowOf(after, CLIENT_COLS))));
      } else {
        await v3.query(`INSERT INTO public.clientes (tel, ${CLIENT_COLS.join(', ')}) VALUES ($1, ${ph('clientes', CLIENT_COLS, 2).join(', ')})`, [n.tel, ...CLIENT_COLS.map((k) => json(vals[k]))]);
        const after = (await v3.query('SELECT * FROM public.clientes WHERE tel = $1', [n.tel])).rows[0];
        bump(out.clientes, 'INSERTED'); await lin('INSERTED', n.tel, sha256(canon(rowOf(after, CLIENT_COLS))));
      }
      if (vals.alias) seenAlias.add(String(vals.alias).toUpperCase());
    }
    // geo_cache -> public.geo_cache (identity key = direccion_key, already normalized by the legacy system)
    for (const r of (await v3.query(LATEST('geo_cache'))).rows) {
      const d = r.row_data; const key = String(d.direccion_key || '');
      const lin = (outcome, tsha, detail) => v3.query(`INSERT INTO commercial_history.import_lineage (batch_id, source_table, legacy_key, source_sha256, target_table, target_key, target_sha256, outcome, detail)
        VALUES ($1, 'geo_cache', $2, $3, 'public.geo_cache', $4, $5, $6, $7) ON CONFLICT DO NOTHING`, [batch, r.legacy_key, r.row_sha256, key || '-', tsha, outcome, detail || null]);
      if (!key || !d.zona) { bump(out.geo_cache, 'SKIPPED_INVALID'); await lin('SKIPPED_INVALID', '-', 'no key / zona'); continue; }
      const cur = (await v3.query('SELECT * FROM public.geo_cache WHERE direccion_key = $1', [key])).rows[0];
      const vals = GEO_COLS.map((k) => (d[k] === undefined ? null : d[k]));
      if (cur) {
        const prev = (await v3.query(`SELECT target_sha256 FROM commercial_history.import_lineage WHERE target_table = 'public.geo_cache' AND target_key = $1 AND outcome IN ('INSERTED','UPDATED') ORDER BY imported_at DESC LIMIT 1`, [key])).rows[0];
        if (!prev || prev.target_sha256 !== sha256(canon(rowOf(cur, GEO_COLS)))) { bump(out.geo_cache, 'SKIPPED_V3_WINS'); await lin('SKIPPED_V3_WINS', sha256(canon(rowOf(cur, GEO_COLS)))); continue; }
        const P = ph('geo_cache', GEO_COLS, 2);
        await v3.query(`UPDATE public.geo_cache SET ${GEO_COLS.map((k, i) => `${k} = coalesce(${P[i]}, ${k})`).join(', ')} WHERE direccion_key = $1`, [key, ...vals]);
        bump(out.geo_cache, 'UPDATED');
      } else {
        const P = ph('geo_cache', GEO_COLS, 2);
        await v3.query(`INSERT INTO public.geo_cache (direccion_key, ${GEO_COLS.join(', ')}) VALUES ($1, ${GEO_COLS.map((k, i) => `coalesce(${P[i]}, ${k === 'source' ? "'unknown'" : k === 'hit_count' || k.startsWith('n_ordini') ? '0' : 'NULL'})`).join(', ')})`, [key, ...vals]);
        bump(out.geo_cache, 'INSERTED');
      }
      await lin(cur ? 'UPDATED' : 'INSERTED', sha256(canon(rowOf((await v3.query('SELECT * FROM public.geo_cache WHERE direccion_key = $1', [key])).rows[0], GEO_COLS))));
    }
    // storico -> commercial_history.customer_orders (append-only; a legacy row already imported keeps its first version)
    const st = (await v3.query(LATEST('storico'))).rows;
    for (const r of st) {
      const d = r.row_data; const n = normalizeTel(d.tel || d.wa_id);
      const ins = await v3.query(`INSERT INTO commercial_history.customer_orders (legacy_storico_id, business_date, customer_key, items, channel, tipo_consegna, zona, informational_total, source_row_sha256, batch_id)
        VALUES ($1, CASE WHEN $2 ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN $2::date END, $3, coalesce($4::jsonb, '[]'::jsonb), $5, $6, $7, $8, $9, $10) ON CONFLICT (legacy_storico_id) DO NOTHING`,
      [Number(r.legacy_key), String(d.fecha || ''), n.ok ? n.tel : null, json(d.items), d.canal || null, d.tipo_consegna || null, d.zona || null, d.totale == null ? null : Number(d.totale), r.row_sha256, batch]);
      out.customer_orders += ins.rowCount;
    }
    // customer_stats: a full snapshot for this batch, recomputed from customer_orders
    const s = await v3.query(`INSERT INTO commercial_history.customer_stats (customer_key, orders_count, first_order_date, last_order_date, delivery_share, top_items, batch_id)
      SELECT customer_key, count(*)::int, min(business_date), max(business_date), round(avg(CASE WHEN tipo_consegna = 'DOMICILIO' THEN 1 ELSE 0 END), 4),
        coalesce((SELECT jsonb_agg(t.n ORDER BY t.c DESC, t.n) FROM (SELECT it->>'n' n, count(*) c FROM commercial_history.customer_orders o2, jsonb_array_elements(o2.items) it
                   WHERE o2.customer_key = o.customer_key AND it ? 'n' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5) t), '[]'::jsonb), $1
      FROM commercial_history.customer_orders o WHERE customer_key IS NOT NULL GROUP BY customer_key`, [batch]);
    out.customer_stats = s.rowCount;
    await v3.query('COMMIT');
    log(`commercial import of batch ${batch}: ${JSON.stringify(out)}`);
    return { code: 0, result: 'IMPORTED', batch, ...out };
  } catch (e) { await v3.query('ROLLBACK').catch(() => {}); return { code: 1, result: 'REFUSED_ROLLED_BACK', detail: e.message }; }
}
const rowOf = (r, cols) => Object.fromEntries(cols.map((k) => [k, r[k] instanceof Date ? r[k].toISOString() : r[k] === undefined ? null : r[k]]));
const json = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

// ── the V3 economic fingerprint (what an import must never change) ─────────────────────────────────────────────────────────────────────
async function economicFingerprint(v3) {
  await v3.query('BEGIN TRANSACTION READ ONLY');
  try {
    const out = {};
    for (const t of V3_ECONOMIC_TABLES) {
      const cols = (await v3.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name IN ('amount','gross_amount','totale')`, [t])).rows.map((x) => x.column_name);
      const r = (await v3.query(`SELECT count(*)::int n${cols.map((c) => `, coalesce(sum(${c}),0)::text s_${c}`).join('')}, coalesce(md5(string_agg(t::text, '' ORDER BY t::text)), '') h FROM public.${t} t`)).rows[0];
      out[t] = r;
    }
    out.pointer = (await v3.query('SELECT current_session_id, recent_closed_session_id FROM public.service_session_state')).rows[0];
    out.day = (await v3.query('SELECT current_business_day_id, current_period_id FROM public.business_day_lifecycle_state')).rows[0];
    return { sha256: sha256(canon(out)), tables: out };
  } finally { await v3.query('ROLLBACK'); }
}

module.exports = { archive, commercial, economicFingerprint, normalizeTel, LEGACY_TABLES, V3_ECONOMIC_TABLES, SECRET_KEY_RE };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    if (!['archive', 'commercial', 'fingerprint'].includes(cmd)) { console.error('usage: legacyImport.js archive --kind initial|delta|final_delta | commercial --batch <uuid> | fingerprint'); process.exit(2); }
    let v3; let legacy;
    try { v3 = await pgClient(process.env.PREFLIGHT_DATABASE_URL); if (cmd === 'archive') legacy = await pgClient(process.env.LEGACY_DATABASE_URL); } catch (e) { console.error('connection error: ' + e.message); process.exit(2); }
    try {
      const r = cmd === 'fingerprint' ? { code: 0, ...(await economicFingerprint(v3)) }
        : cmd === 'archive' ? await archive({ v3, legacy, kind: opt('--kind'), legacySource: process.env.LEGACY_SOURCE_LABEL || 'legacy', cutoverAt: opt('--cutover-at'), v3Candidate: opt('--v3-candidate') })
          : await commercial({ v3, batch: opt('--batch') });
      console.log(JSON.stringify(r, null, 1)); process.exit(r.code);
    } finally { await v3.end().catch(() => {}); if (legacy) await legacy.end().catch(() => {}); }
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
