'use strict';

const express = require('express');
const { registerMesaRoutes } = require('./mesaHttpHandlers');

const PREFIX = '/api/mesa/v1';

function isMesaHttpEnabled(env = process.env) {
  return !!env && env.MESA_HTTP_ENABLED === 'true';
}

function integrateMesaRoutes(app, { env = process.env, logger = console, ...deps } = {}) {
  if (!app || typeof app.use !== 'function') throw new TypeError('Express app required');
  if (!isMesaHttpEnabled(env)) return Object.freeze({ enabled: false, prefix: PREFIX, routes: 0 });
  const router = express.Router();
  const registered = registerMesaRoutes(router, { logger, ...deps });
  app.use(PREFIX, router);
  return Object.freeze({ enabled: true, prefix: PREFIX, routes: registered.routes });
}

module.exports = { PREFIX, isMesaHttpEnabled, integrateMesaRoutes };
