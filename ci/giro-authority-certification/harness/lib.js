'use strict';
// Assertions and fixture helpers shared by the certification groups. Every assertion is
// recorded (group, name, ok) so run.js can prove the W3 contract matrix mechanically.

const state = { pass: 0, fail: 0, current: null, groups: {}, results: [] };

function section(title) {
  state.current = title;
  state.groups[title] = state.groups[title] || { pass: 0, fail: 0 };
  console.log('\n── ' + title + ' ──');
}

function assert(name, cond, detail = '') {
  const g = state.groups[state.current] || (state.groups[state.current] = { pass: 0, fail: 0 });
  state.results.push({ group: state.current, name, ok: !!cond });
  if (cond) { state.pass++; g.pass++; console.log('  PASS  ' + name); }
  else {
    state.fail++; g.fail++;
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.log('  FAIL  ' + name + (d ? '  -> ' + d : ''));
  }
}

// Returns the SQLSTATE of a failing statement, or null if it succeeded.
async function sqlstate(client, sql, params = []) {
  try { await client.query(sql, params); return null; } catch (e) { return e.code || 'NO_CODE'; }
}

async function call(client, fn, args = []) {
  const ph = args.map((_, i) => '$' + (i + 1)).join(', ');
  const r = await client.query(`SELECT public.${fn}(${ph}) AS r`, args);
  return r.rows[0].r;
}

let orderSeq = 0;
const nextOrderId = (prefix = '#T') => `${prefix}${String(++orderSeq).padStart(4, '0')}`;

function fixture(su) {
  return {
    async day(date, status = 'open') {
      await su.query('INSERT INTO public.business_days (business_date) VALUES ($1) ON CONFLICT (business_date) DO NOTHING', [date]);
      const r = await su.query(
        `INSERT INTO public.service_sessions (business_date, status, business_day_id)
         SELECT $1::date, $2, id FROM public.business_days WHERE business_date = $1::date RETURNING id`, [date, status]);
      return r.rows[0].id;
    },
    // Inserts one order the way the backend does (as service_role). Returns the stored row.
    // forno: undefined -> '20:40'; null -> NULL (explicitly no forno_out).
    async order(svc, o = {}) {
      const id = o.id || nextOrderId();
      const r = await svc.query(
        `INSERT INTO public.ordenes (id, estado, zona, hora, forno_out, service_session_id, table_session_id,
                                     pending_giro_intent, totale,
                                     -- language-guard: allow-legacy tipo_consegna is the existing ordenes column name
                                     tipo_consegna)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, order_uid, pending_giro_intent, xmin::text AS xmin`,
        [id, o.estado || 'EN_COCINA', o.zona || 'Q1', o.hora || '21:00', o.forno === undefined ? '20:40' : o.forno,
          o.session, o.table || null, o.intent == null ? null : JSON.stringify(o.intent), o.totale || 20,
          o.delivery || 'DOMICILIO']);
      return r.rows[0];
    },
    async setEstado(id, estado) {
      await su.query('UPDATE public.ordenes SET estado = $2 WHERE id = $1', [id, estado]);
    },
    async driverStato(value) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      await su.query(
        `INSERT INTO public.config (chiave, valore) VALUES ('DRIVER_STATO', $1)
         ON CONFLICT (chiave) DO UPDATE SET valore = EXCLUDED.valore`, [raw]);
    },
    async membership() {
      const r = await su.query('SELECT order_uid, giro_id FROM giro_authority.giro_members ORDER BY order_uid');
      return r.rows;
    },
    async intent(uid) {
      const r = await su.query('SELECT * FROM giro_authority.giro_intents WHERE order_uid = $1', [uid]);
      return r.rows[0] || null;
    },
  };
}

function intentInput(kind, ref, extra = {}) {
  return { v: 1, source: 'operator_http', actor: 'op-1', sv: 3, target_kind: kind, target_ref: ref, ...extra };
}

const sortUids = (a) => [...a].sort();

module.exports = { state, section, assert, sqlstate, call, fixture, intentInput, nextOrderId, sortUids };
