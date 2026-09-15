'use strict';
// One isolated database per group, cloned from the fixture + candidate template.
const rt = require('../pgRuntime');
const { fixture } = require('../lib');

async function open(env, label) {
  const db = await env.clone(label);
  const su = await rt.connect(env.cl, db, { name: `w3-su-${label}` });
  const svc = await rt.connect(env.cl, db, { role: 'service_role', name: `w3-svc-${label}` });
  const extra = [];
  return {
    db, su, svc, fx: fixture(su),
    async client(role = 'service_role', name = 'w3-extra') {
      const c = await rt.connect(env.cl, db, { role, name });
      extra.push(c);
      return c;
    },
    async close() {
      for (const c of [...extra, svc, su]) await c.end().catch(() => {});
    },
  };
}

// Some templates (w5ia_tpl, once migration 132 is applied) already carry the capture
// trigger; others (the plain W3/W5-Packet-01 templates) do not. Groups that need the
// trigger for their own scenarios call this instead of applying the W5_DORMANT
// candidate unconditionally, so the same group file works against every template.
async function ensureCaptureTrigger(su) {
  const already = (await su.query(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND tgname = 'ordenes_zz_giro_intent_capture_v1'`
  )).rows.length === 1;
  if (already) return false;
  await rt.applyAsPostgres(su, 'candidate/giro_intent_capture_trigger_v1.W5_DORMANT.sql');
  return true;
}

module.exports = { open, ensureCaptureTrigger };
