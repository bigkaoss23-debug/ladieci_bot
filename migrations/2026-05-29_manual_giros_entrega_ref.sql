-- ===============================================================
-- 2026-05-29 — manual_giros.entrega_ref (ENTREGA_REF-01)
-- ===============================================================
-- Adds the operator-chosen DELIVERY target time of a manual giro, kept
-- SEPARATE from hora_ref (which stays the operational/forno-exit time).
--
-- Semantics (approved 2026-05-29):
--   - hora_ref     = orario operativo / uscita forno comune (guida cucina/driver).
--   - entrega_ref  = target consegna/giro comune scelto dall'operatore (HH:MM).
--   - anchor_order_id = ordine di provenienza della scelta (audit/UX).
--   In Cocina: ⏱ usa hora_ref, 🛵 usa entrega_ref (uguale per tutti i membri);
--   la hora cliente del singolo ordine resta mostrata come riferimento secondario.
--
-- Scope discipline (invariato rispetto alle migration del 25/05 e del 29/05):
--   - NON si tocca ordenes.hora (orario cliente).
--   - NON si tocca ordenes.forno_out (Q4 BLOCKED).
--   - NON si tocca ordenes.hora_salida (epoch ms reale, semantica diversa).
--   - NON si propaga nulla a public.storico / cassa / stati.
--
-- Nullable on purpose: vecchi giri e build pre-ENTREGA_REF restano validi
-- (entrega_ref = NULL → fallback frontend al comportamento attuale).
--
-- Apply manually via Supabase SQL editor (project: LaDieci10App,
-- ref wnswassgfuuivmfwjxsf). No migration framework in use.
-- Rollback statement at the bottom of this file (commented).
-- ===============================================================


-- 1) entrega_ref — target consegna/giro comune (HH:MM)
--
-- text NULL on purpose: nessun default DB. Il backend scrive il valore
-- solo quando l'operatore lo fornisce alla creazione del giro; assenza
-- = NULL = "nessun orario consegna scelto" (fallback frontend).
-- Validazione del formato HH:MM fatta lato backend (createManualGiro),
-- non con un CHECK constraint, per restare coerenti con lo stile del
-- modulo (come hora_ref) e poter evolvere il formato senza DDL.
ALTER TABLE public.manual_giros
  ADD COLUMN IF NOT EXISTS entrega_ref text NULL;


-- ===============================================================
-- Rollback (commented — apply manually if needed)
-- ===============================================================
--
-- ALTER TABLE public.manual_giros DROP COLUMN IF EXISTS entrega_ref;
--
-- Rollback is safe at any time: the column is nullable, additive,
-- and not referenced by any constraint or index.
