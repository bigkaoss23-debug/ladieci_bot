-- migrations/2026-09-23_harden_order_state_logs_rls.ROLLBACK.sql
-- Exact inverse of 2026-09-23_harden_order_state_logs_rls.sql: RLS off and the ACL restored to the value read
-- from LIVE on 2026-09-23 ({postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm},
-- on PG 17 "ALL" = arwdDxtm). No row is touched. The table comment is restored to the 2026-06-05 text.
--
-- WARNING: this RE-OPENS the audit log to anyone holding the publishable key (INSERT/UPDATE/DELETE).
-- Use only to undo the hardening itself; the backend does not need it (it writes as service_role).
--
-- NOT APPLIED to any database by this commit/branch.

BEGIN;

ALTER TABLE public.orden_estado_logs DISABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.orden_estado_logs TO anon, authenticated;

COMMENT ON TABLE public.orden_estado_logs IS
  'Append-only non-PII audit log for order state transitions.';

DO $verify$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.orden_estado_logs'::regclass) THEN
    RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS rollback verify failed: RLS still enabled';
  END IF;
  -- confronto come INSIEME di voci ACL (l'ordine nell'array dipende dalla sequenza dei GRANT)
  IF (SELECT array_agg(x::text ORDER BY x::text) FROM pg_class, unnest(relacl) x WHERE oid = 'public.orden_estado_logs'::regclass)
     <> ARRAY['anon=arwdDxtm/postgres', 'authenticated=arwdDxtm/postgres', 'postgres=arwdDxtm/postgres', 'service_role=arwdDxtm/postgres'] THEN
    RAISE EXCEPTION 'HARDEN_ORDER_STATE_LOGS rollback verify failed: ACL differs from the pre-hardening state: %',
      (SELECT relacl::text FROM pg_class WHERE oid = 'public.orden_estado_logs'::regclass);
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
