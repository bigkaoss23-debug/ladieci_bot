'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');

const migration = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-01_v3h1_messa_fk_indexes.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-01_v3h1_messa_fk_indexes.ROLLBACK.sql'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, '../migrations/MIGRATION_MANIFEST.md'), 'utf8');

const indexes = [
  'payment_transactions_reversal_fk_idx',
  'restaurant_tables_created_by_fk_idx',
  'restaurant_tables_updated_by_fk_idx',
  'table_order_lines_service_fk_idx',
  'table_order_lines_workspace_fk_idx',
  'table_sessions_table_id_fk_idx',
];

test('V3-H.1 is staging-only and requires the exact applied V3-H migration', () => {
  assert.match(migration, /TARGET PROJECT REF: tdikhfeinufaahagmpjz/);
  assert.match(migration, /name = 'v3h_messa_billing_foundation'/);
});

test('all six foreign-key lookup indexes are created and reversibly dropped', () => {
  for (const name of indexes) {
    assert.match(migration, new RegExp(`CREATE INDEX ${name}`));
    assert.match(rollback, new RegExp(`DROP INDEX IF EXISTS public\\.${name}`));
  }
});

test('manifest row 46 checksum matches this exact migration', () => {
  const checksum = crypto.createHash('sha256').update(migration, 'utf8').digest('hex').slice(0, 16);
  assert.match(manifest, new RegExp(`\\| 46 \\|[^\\n]+\\| ${checksum} \\|`));
});
