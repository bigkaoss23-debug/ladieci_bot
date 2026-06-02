-- ===============================================================
-- 2026-06-02_driver_schedule_fields.sql
-- DELIVERY-DRIVER-SCHEDULE-SEPARATION-01
-- ===============================================================
-- Separa definitivamente lo schedule driver/rider da forno_out (cucina).
--
-- Prima di questa migration, la cascade EN_COCINA
--   updateEstado -> cambiaStato -> risincronizzaGiro -> planFornoOutSync
--   -> simulateDriverSchedule
-- riscriveva ordenes.forno_out con la partenza driver simulata (Bug #2,
-- replay reale 2026-05-31: #006 forno_out 00:09 -> 00:27, #007 00:13 -> 00:56).
--
-- forno_out resta SEMPRE target cucina (hora - durata). I dati driver vivono
-- in colonne dedicate, nullable e non distruttive:
--   salida_driver_estimada  partenza rider stimata (HH:MM)
--   entrega_estimada         consegna stimata al cliente (HH:MM)
--   retraso_estimado_min     max(0, entrega - hora) in minuti, service-day-aware
--   conflicto_driver         true se lo schedule driver prevede ritardo
--
-- Idempotente (add column if not exists). Nessuna rename/drop. Nessun backfill
-- obbligatorio. Nessuna modifica a forno_out o a dati storici.
-- ===============================================================

alter table public.ordenes
  add column if not exists salida_driver_estimada text null,
  add column if not exists entrega_estimada text null,
  add column if not exists retraso_estimado_min integer null,
  add column if not exists conflicto_driver boolean not null default false;

create index if not exists idx_ordenes_conflicto_driver
  on public.ordenes (conflicto_driver)
  where conflicto_driver = true;
