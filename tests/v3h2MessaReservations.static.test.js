'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const forward = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-01_v3h2_messa_reservations.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-01_v3h2_messa_reservations.ROLLBACK.sql'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, '../migrations/MIGRATION_MANIFEST.md'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  else { failed += 1; process.stderr.write(`  FAIL  ${name}\n`); }
}

test('migration is staging-only and exact-predecessor guarded',
  /STAGING ONLY/.test(forward)
  && /20260710075612/.test(forward)
  && /messa_open_session_v1\(uuid,text,uuid,uuid,integer\)/.test(forward));
test('reservation stores the approved operational fields',
  /CREATE TABLE public\.table_reservations/.test(forward)
  && /guest_name\s+text NOT NULL/.test(forward)
  && /guest_phone\s+text NULL/.test(forward)
  && /covers_total\s+integer NOT NULL/.test(forward)
  && /reserved_at\s+timestamptz NOT NULL/.test(forward)
  && /note\s+text NULL/.test(forward));
test('duration is exactly the approved two hours',
  /duration_minutes\s+integer NOT NULL DEFAULT 120 CHECK \(duration_minutes = 120\)/.test(forward));
test('active lifecycle includes booked, seated, completed, cancelled and no-show',
  /'booked','seated','completed','cancelled','no_show'/.test(forward)
  && /table_reservations_lifecycle_chk/.test(forward));
test('operator, cashier and waiter can manage bookings without owner-only coupling',
  (forward.match(/'admin','operator','owner','cashier','waiter','shift_manager','legacy_operator'/g) || []).length >= 2);
test('stale edits fail instead of overwriting another operator',
  /version\s+integer NOT NULL DEFAULT 1/.test(forward)
  && /MESSA_RESERVATION_VERSION_CONFLICT/.test(forward)
  && /version = version \+ 1/.test(forward));
test('same-table two-hour overlap is checked while workspace write lock is held', (() => {
  const body = forward.match(/CREATE OR REPLACE FUNCTION public\.messa_save_reservation_v1[\s\S]*?END\n\$fn\$;/)?.[0] || '';
  return body.indexOf('FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE') >= 0
    && body.indexOf('FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE')
      < body.indexOf("r.status IN ('booked','seated')")
    && /interval '120 minutes'/.test(body)
    && /MESSA_RESERVATION_OVERLAP/.test(body);
})());
test('moving a reservation changes table_id through the same overlap guard',
  /UPDATE public\.table_reservations SET[\s\S]*table_id = p_table_id/.test(forward));
test('capacity uses the room-setting maximum',
  /p_covers_total > v_table\.capacity[\s\S]*MESSA_RESERVATION_CAPACITY_EXCEEDED/.test(forward));
test('walk-in open RPC is not replaced or blocked by the reservation migration',
  !/CREATE OR REPLACE FUNCTION public\.messa_open_session_v1/.test(forward));
test('seating is atomic and opens a new account with reserved covers',
  /messa_open_reservation_v1[\s\S]*INSERT INTO public\.table_sessions[\s\S]*v_reservation\.covers_total[\s\S]*status = 'seated'/.test(forward));
test('waiter seating self-assigns consistently with ordinary Mesa open',
  /CASE WHEN v_actor\.role='waiter' THEN p_by_actor ELSE NULL END/.test(forward)
  && /table_session_assignment_history/.test(forward));
test('full account settlement completes the linked reservation in the same transaction',
  /AFTER UPDATE OF status ON public\.table_sessions/.test(forward)
  && /OLD\.status = 'open' AND NEW\.status = 'closed'/.test(forward)
  && /status = 'completed'/.test(forward));
test('future reservations prevent structural table removal',
  /BEFORE UPDATE OF active ON public\.restaurant_tables/.test(forward)
  && /MESSA_TABLE_HAS_RESERVATIONS/.test(forward));
test('reservation table is RLS-enabled and backend-only',
  /ALTER TABLE public\.table_reservations ENABLE ROW LEVEL SECURITY/.test(forward)
  && /REVOKE ALL ON public\.table_reservations FROM PUBLIC, anon, authenticated/.test(forward)
  && /GRANT SELECT, INSERT, UPDATE ON public\.table_reservations TO service_role/.test(forward));
test('all reservation RPCs are SECURITY INVOKER and service-role only',
  (forward.match(/SECURITY INVOKER/g) || []).length >= 5
  && (forward.match(/REVOKE ALL ON FUNCTION public\.messa_(?:save_reservation|set_reservation_status|open_reservation)_v1/g) || []).length === 3
  && (forward.match(/GRANT EXECUTE ON FUNCTION public\.messa_(?:save_reservation|set_reservation_status|open_reservation)_v1/g) || []).length === 3);
test('rollback refuses to erase reservation evidence',
  /rollback refused: Mesa reservation evidence exists/.test(rollback));
test('manifest row 47 checksum matches this exact forward file', (() => {
  const checksum = crypto.createHash('sha256').update(forward, 'utf8').digest('hex').slice(0, 16);
  return manifest.includes('| 47 |') && manifest.includes(checksum);
})());

process.stdout.write(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
