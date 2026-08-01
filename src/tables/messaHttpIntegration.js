'use strict';

const express = require('express');
const { registerMessaRoutes } = require('./messaHttpHandlers');

const PREFIX = '/api/messa/v1';

function isMessaHttpEnabled(env = process.env) {
  return !!env && env.MESSA_HTTP_ENABLED === 'true';
}

function integrateMessaRoutes(app, { env = process.env, logger = console, ...deps } = {}) {
  if (!app || typeof app.use !== 'function') throw new TypeError('Express app required');
  if (!isMessaHttpEnabled(env)) return Object.freeze({ enabled: false, prefix: PREFIX, routes: 0 });
  const router = express.Router();
  const registered = registerMessaRoutes(router, { logger, ...deps });
  app.use(PREFIX, router);
  return Object.freeze({ enabled: true, prefix: PREFIX, routes: registered.routes });
}

module.exports = { PREFIX, isMessaHttpEnabled, integrateMessaRoutes };
