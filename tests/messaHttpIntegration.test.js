'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { isMessaHttpEnabled, integrateMessaRoutes, PREFIX } = require('../src/tables/messaHttpIntegration');

test('Messa HTTP is disabled by default and only exact lowercase true enables it', () => {
  assert.equal(isMessaHttpEnabled({}), false);
  assert.equal(isMessaHttpEnabled({ MESSA_HTTP_ENABLED: 'TRUE' }), false);
  assert.equal(isMessaHttpEnabled({ MESSA_HTTP_ENABLED: '1' }), false);
  assert.equal(isMessaHttpEnabled({ MESSA_HTTP_ENABLED: 'true' }), true);
});

test('disabled integration mounts zero routes', () => {
  const app = express();
  const result = integrateMessaRoutes(app, { env: {} });
  assert.deepEqual(result, { enabled: false, prefix: PREFIX, routes: 0 });
});

test('enabled integration mounts exactly ten static routes', () => {
  const app = express();
  const service = {
    floor: async () => ({ ok: true, tables: [] }),
    open: async () => ({ ok: true }),
    saveTable: async () => ({ ok: true }),
    addCommand: async () => ({ ok: true }),
    markServed: async () => ({ ok: true }),
    pay: async () => ({ ok: true }),
    saveReservation: async () => ({ ok: true }),
    setReservationStatus: async () => ({ ok: true }),
    openReservation: async () => ({ ok: true }),
  };
  const result = integrateMessaRoutes(app, {
    env: { MESSA_HTTP_ENABLED: 'true' },
    service,
    verifyToken: () => ({ sub: 'operator_primary', role: 'operator', sv: 1, sid: 'sid' }),
    getActor: async () => ({ actor: 'operator_primary', role: 'operator', active: true, session_version: 1, workspace_id: 'ws' }),
  });
  assert.deepEqual(result, { enabled: true, prefix: PREFIX, routes: 10 });
});
