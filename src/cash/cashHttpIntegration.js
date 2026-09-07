'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 — mount point, mirroring
// src/tables/mesaHttpIntegration.js exactly: its own env flag, its own
// prefix, disabled by default.

const express = require('express');
const { registerCashRoutes } = require('./cashHttpHandlers');

const PREFIX = '/api/cash/v1';

function isCashHttpEnabled(env = process.env) {
  return !!env && env.CASH_HTTP_ENABLED === 'true';
}

function integrateCashRoutes(app, { env = process.env, logger = console, ...deps } = {}) {
  if (!app || typeof app.use !== 'function') throw new TypeError('Express app required');
  if (!isCashHttpEnabled(env)) return Object.freeze({ enabled: false, prefix: PREFIX, routes: 0 });
  const router = express.Router();
  const registered = registerCashRoutes(router, { logger, ...deps });
  app.use(PREFIX, router);
  return Object.freeze({ enabled: true, prefix: PREFIX, routes: registered.routes });
}

module.exports = { PREFIX, isCashHttpEnabled, integrateCashRoutes };
