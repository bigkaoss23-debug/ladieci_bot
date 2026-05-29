-- ===============================================================
-- 2026-05-29 — manual_giros.hora_ref (P1D of DELIVERY-MANUAL-GIRO-01)
-- ===============================================================
-- Adds the single operational time of a manual giro so that Cocina and
-- the driver have ONE guiding time, independent of the per-order client
-- horas (which stay untouched and keep being shown per card).
--
-- Decision (approved 2026-05-29):
--   - hora_ref = orario operativo del giro (HH:MM), cioè l'orario guida
--     per cucina/driver (≈ partenza driver / sfornata target).
--   - Quando l'operatore sceglie "usa orario ordine #A", il frontend
--     risolve al forno_out di quell'ordine, NON alla hora cliente.
--   - La hora cliente dei singoli ordini resta preservata e mostrata.
--
-- Scope discipline (invariato rispetto alla migration del 25/05):
--   - NON si tocca ordenes.hora (orario cliente).
--   - NON si tocca ordenes.forno_out (Q4 BLOCKED).
--   - NON si tocca ordenes.hora_salida (epoch ms reale, semantica diversa).
--   - NON si propaga nulla a public.storico / cassa / stati.
--
-- Both columns are nullable: vecchi giri e build pre-P1D restano validi
-- (hora_ref = NULL → fallback al comportamento attuale lato frontend).
--
-- Apply manually via Supabase SQL editor (project: LaDieci10App,
-- ref wnswassgfuuivmfwjxsf). No migration framework in use.
-- Rollback statements at the bottom of this file (commented).
-- ===============================================================


-- 1) hora_ref — orario operativo del giro (HH:MM)
--
-- text NULL on purpose: nessun default DB. Il backend scrive il valore
-- solo quando l'operatore lo fornisce alla creazione del giro; assenza
-- = NULL = "nessun orario operativo scelto" (fallback frontend).
-- Validazione del formato HH:MM fatta lato backend (createManualGiro),
-- non con un CHECK constraint, per restare coerenti con lo stile del
-- modulo e poter evolvere il formato senza DDL.
ALTER TABLE public.manual_giros
  ADD COLUMN IF NOT EXISTS hora_ref text NULL;


-- 2) anchor_order_id — provenienza della scelta orario (audit/UX)
--
-- text NULL. Quando l'operatore sceglie "usa orario ordine #A", qui
-- finisce l'id di quell'ordine, così la UI può mostrare da dove arriva
-- l'orario operativo. NULL per orario "personalizzato" o "più presto".
-- Volutamente NON una FK: è puro audit; l'ordine può cambiare stato o
-- uscire dal giro senza che questo riferimento debba essere ripulito.
ALTER TABLE public.manual_giros
  ADD COLUMN IF NOT EXISTS anchor_order_id text NULL;


-- ===============================================================
-- Rollback (commented — apply manually if needed)
-- ===============================================================
--
-- ALTER TABLE public.manual_giros DROP COLUMN IF EXISTS anchor_order_id;
-- ALTER TABLE public.manual_giros DROP COLUMN IF EXISTS hora_ref;
--
-- Rollback is safe at any time: both columns are nullable, additive,
-- and not referenced by any constraint or index.
