-- migrations/2026-09-23_harden_order_state_logs_rls.sql
-- Paired rollback: 2026-09-23_harden_order_state_logs_rls.ROLLBACK.sql
-- SEPARATA da 2026-09-23_payment_method_change_v1.sql: le due si applicano e si annullano indipendentemente.
--
-- WHY. public.orden_estado_logs (migration 2026-06-05) è nata senza RLS e senza REVOKE: i default ACL di
-- Supabase sullo schema public le hanno dato ALL (arwdDxtm) ad anon e authenticated. Stato LIVE letto il
-- 2026-09-23 (read-only):
--   RLS off, nessuna policy, relacl = {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
-- La chiave publishable è nel bundle FE, quindi chiunque poteva INSERT / UPDATE / DELETE (e, a livello SQL,
-- TRUNCATE, che la RLS non ferma) sull'audit — incluso il nuovo audit finanziario payment_method_changed.
--
-- WHO NEEDS IT (dimostrato, non assunto):
--   - FE (ladieci-app33 src + netlify functions + realtime WS): ZERO riferimenti alla tabella.
--   - realtime: la tabella NON è nella publication supabase_realtime.
--   - BE: un solo writer, src/utils/orderStateLogger.js (INSERT via SUPABASE_KEY) + la RPC
--     payment_method_change_v1 (SECURITY INVOKER, EXECUTE solo service_role).
--   - Log edge Supabase 2026-09-22→23: 72 richieste sulla tabella, TUTTE POST, user-agent node,
--     chiave sb_secret_ (= service_role), 201. Nessuna richiesta con la chiave publishable.
--   - Nessuna view, funzione SQL o trigger che la legga/scriva.
--
-- WHAT (convenzione P0 2026-07-10: RLS on + nessuna policy = default-deny per i ruoli API; service_role
-- bypassa la RLS con BYPASSRLS):
--   1. ENABLE ROW LEVEL SECURITY (non FORCE: il proprietario postgres e service_role restano come oggi);
--   2. REVOKE ALL ad anon, authenticated, PUBLIC — anche SELECT: nessun client la legge (vedi sopra) e la
--      metadata contiene dati operativi; il REVOKE copre anche TRUNCATE/TRIGGER/REFERENCES/MAINTAIN, che la
--      RLS da sola non ferma;
--   3. nessuna policy creata; service_role e postgres INVARIATI (arwdDxtm).
-- Nessuna riga toccata, nessuna colonna, nessuna tabella nuova.
--
-- ROLLOUT ORDER. Indipendente dal BE/FE: nessun client legittimo usa anon/authenticated su questa tabella.
-- Va applicata PRIMA del deploy del payment hotfix (così l'audit finanziario nasce già protetto).
--
-- NOT APPLIED to any database by this commit/branch. Run by the operator in the SQL editor.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.orden_estado_logs') IS NULL THEN
    RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS refused: public.orden_estado_logs does not exist';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS refused: service_role lacks BYPASSRLS — enabling RLS would stop backend logging';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.orden_estado_logs'::regclass) THEN
    RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS refused: unexpected policies on orden_estado_logs (state differs from the audited one)';
  END IF;
END $guard$;

ALTER TABLE public.orden_estado_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.orden_estado_logs FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.orden_estado_logs IS
  'Append-only non-PII audit log for order state transitions and payment_method_changed. RLS on, no policies: writable/readable only by service_role (backend) and postgres. Hardened 2026-09-23.';

DO $verify$
DECLARE
  r text;
  p text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.orden_estado_logs'::regclass) THEN
    RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS verify failed: RLS is not enabled';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.orden_estado_logs', p) THEN
        RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS verify failed: % still has % ', r, p;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT (has_table_privilege('service_role', 'public.orden_estado_logs', 'INSERT')
          AND has_table_privilege('service_role', 'public.orden_estado_logs', 'SELECT')) THEN
    RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS verify failed: service_role lost INSERT/SELECT';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
