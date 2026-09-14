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

module.exports = { open };
