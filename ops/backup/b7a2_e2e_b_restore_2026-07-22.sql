-- Local, verifiable restore of the B7A2_E2E_B synthetic fixture.
-- NOT to be executed unless the S2-6A3B cleanup must be undone.
-- Staging only (tdikhfeinufaahagmpjz). Order matters: ordenes first, then dependents.
BEGIN;

INSERT INTO public.ordenes
  (id, nombre, tel, wa_id, canal, items, nota, nota_cucina, hora, estado, ts, llegado, created_at,
   tipo_consegna, cobrado, zona_manuale, ya_pagado, metodo_pago, delivery_fee, totale, forzado,
   ui_offset_min, conflicto_driver, refunded)
VALUES
  ('B7A2_E2E_B', 'B7A2 E2E FIXTURE B legacy — DELETE OK', '', '', 'MANUAL', '[]'::jsonb, '', '', '',
   'EN_COCINA', 0, false, '2026-07-16T16:01:17.178838+00'::timestamptz,
   'RITIRO', true, false, true, 'efectivo', 0, 30.00, false, 0, false, true);

-- order_financial_events is NOT restored here: the two events are append-only and
-- were never deleted by the cleanup. Re-inserting them would duplicate evidence.
-- Their verbatim content is kept in the .json backup for reference only.

INSERT INTO public.storico
  (id, orden_id, nombre, tel, wa_id, canal, items, nota, nota_cucina, hora, estado, totale, fecha,
   dia_semana, fascia_ora, ts, created_at, tipo_consegna, metodo_pago, delivery_fee, zona_manuale,
   cobrado, ya_pagado, llegado)
VALUES
  (20, 'B7A2_E2E_B', 'B7A2 E2E FIXTURE B legacy — DELETE OK', '', '', 'MANUAL', '[]'::jsonb, '', '', '', 'CHIUSO_FORZATO', 30, '2026-07-16', 'giovedi', 'tardivo', 1784238601720, '2026-07-16T21:50:01.74384+00'::timestamptz,  'RITIRO', 'efectivo', 0, false, true, true, false),
  (22, 'B7A2_E2E_B', 'B7A2 E2E FIXTURE B legacy — DELETE OK', '', '', 'MANUAL', '[]'::jsonb, '', '', '', 'CHIUSO_FORZATO', 30, '2026-07-17', 'venerdi', 'tardivo', 1784325001766, '2026-07-17T21:50:01.791266+00'::timestamptz, 'RITIRO', 'efectivo', 0, false, true, true, false),
  (25, 'B7A2_E2E_B', 'B7A2 E2E FIXTURE B legacy — DELETE OK', '', '', 'MANUAL', '[]'::jsonb, '', '', '', 'CHIUSO_FORZATO', 30, '2026-07-18', 'sabato',  'tardivo', 1784411401963, '2026-07-18T21:50:01.988462+00'::timestamptz, 'RITIRO', 'efectivo', 0, false, true, true, false),
  (28, 'B7A2_E2E_B', 'B7A2 E2E FIXTURE B legacy — DELETE OK', '', '', 'MANUAL', '[]'::jsonb, '', '', '', 'CHIUSO_FORZATO', 30, '2026-07-19', 'domenica','tardivo', 1784497801774, '2026-07-19T21:50:01.800429+00'::timestamptz, 'RITIRO', 'efectivo', 0, false, true, true, false),
  (31, 'B7A2_E2E_B', 'B7A2 E2E FIXTURE B legacy — DELETE OK', '', '', 'MANUAL', '[]'::jsonb, '', '', '', 'CHIUSO_FORZATO', 30, '2026-07-20', 'lunedi',  'tardivo', 1784584211572, '2026-07-20T21:50:11.63673+00'::timestamptz,  'RITIRO', 'efectivo', 0, false, true, true, false),
  (34, 'B7A2_E2E_B', 'B7A2 E2E FIXTURE B legacy — DELETE OK', '', '', 'MANUAL', '[]'::jsonb, '', '', '', 'CHIUSO_FORZATO', 30, '2026-07-21', 'martedi', 'tardivo', 1784670601861, '2026-07-21T21:50:01.886369+00'::timestamptz, 'RITIRO', 'efectivo', 0, false, true, true, false);

COMMIT;
