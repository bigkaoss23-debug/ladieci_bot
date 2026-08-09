-- migrations/2026-08-09_service_lifecycle_v3_table_release.sql
-- SERVICE LIFECYCLE V3 / SLICE 3.4 — the "V3 replacement" row 56 itself asks
-- for. STAGING ONLY, additive-only (one new function, no table, no
-- destructive statement). Requires row 59 applied first; does NOT require,
-- reference, or depend on row 56 (2026-08-09_service_closeout_cross_
-- service_table_policy.sql) in any way.
--
-- ── WHY THIS EXISTS — a Gate-0 finding from the V3.4 session, not a guess ──
-- Row 60 (2026-08-09_service_lifecycle_v3_incident_policy.sql, Slice 3.3)
-- has always required `mesa_release_empty_session_auto_v1` — the ONE
-- genuinely reusable piece of row 56 — to already exist, because
-- serviceLifecycleEngine.js's empty-table safe-action (src/tables/mesaDao.js
-- releaseEmptySessionAuto()) calls it directly. Row 56 itself is marked in
-- MIGRATION_MANIFEST.md as "UNAPPLIED — V2 legacy-policy migration; do not
-- deploy pending V3 replacement" — it is not just unapplied by omission, it
-- is the WRONG migration to ever apply for this purpose: its other two
-- parts (begin_service_session_close / guard_service_session_closed_v1
-- widened to exempt on an ACTIVE service_closeout_attempts row, and
-- supersede_closeout_attempt widened for incidentSafeRollover.js's own
-- auto-resolution ordering fix) are V2-orchestrator-specific and were
-- already independently superseded for the V3 path by row 58 PART 3 / row
-- 59's own transaction-local marker mechanism, which needs neither of them.
--
-- Empirically confirmed this session (staging tdikhfeinufaahagmpjz, real
-- Postgres, inside BEGIN/ROLLBACK, zero residue after): applying rows
-- 57→58→59 in sequence succeeds cleanly against the live schema, but row
-- 60's own guard then refuses with exactly `mesa_release_empty_session_
-- auto_v1 missing` — proving the chain does not complete end-to-end while
-- row 56 stays excluded, exactly as this migration's header now documents.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────
-- Extract the ONE genuinely reusable piece — mesa_release_empty_session_
-- auto_v1 itself — verbatim (identical body, identical signature, identical
-- grants) into its own V3-owned migration that depends on nothing from row
-- 56. Same name, so no JS-side caller (mesaDao.js) needs to change at all.
-- Row 60's own dependency check (`to_regprocedure(...) IS NULL`) is
-- signature-based, not migration-based — it is satisfied by this migration
-- exactly as it would have been by row 56, so row 60 itself needs no logic
-- change, only its guard's error-message text corrected to point here
-- instead of at row 56 (see that migration's own diff, same commit).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 table release refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.table_sessions') IS NULL OR to_regclass('public.workspaces') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 table release refused: table_sessions/workspaces missing — apply Mesa foundation first'; END IF;

  IF to_regprocedure('public.mesa_release_empty_session_auto_v1(uuid,uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 table release refused: mesa_release_empty_session_auto_v1 already exists — resolve drift first (already applied via this migration, or via retired row 56).'; END IF;
END $$;

-- Verbatim from row 56's PART 3 (2026-08-09_service_closeout_cross_service_
-- table_policy.sql) — identical session/covers guard clauses to the
-- human-authorized mesa_release_empty_session_v1, minus the human-actor
-- authorization block that RPC correctly requires for its real (human,
-- HTTP-reachable) caller. service_role-only; never granted to anon/
-- authenticated; never referenced by any HTTP action — the resource-policy
-- registry (src/utils/supabaseResourcePolicy.js) is the only thing standing
-- between this function and the network, exactly like every other
-- internal-only closeout RPC.
CREATE FUNCTION public.mesa_release_empty_session_auto_v1(
  p_workspace_id uuid,
  p_table_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL THEN
    RAISE EXCEPTION 'MESA_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.covers_total IS NOT NULL THEN
    RAISE EXCEPTION 'MESA_TABLE_HAS_ORDERS' USING ERRCODE='55000';
  END IF;

  UPDATE public.table_sessions SET
    status = 'closed', settled_at = v_now, closed_at = v_now,
    updated_at = v_now, updated_by = 'system'
  WHERE id = v_session.id;

  RETURN jsonb_build_object('ok', true, 'tableId', v_session.table_id, 'status', 'closed');
END
$function$;

REVOKE ALL ON FUNCTION public.mesa_release_empty_session_auto_v1(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_release_empty_session_auto_v1(uuid,uuid) TO service_role;

-- No new table, no RLS/GRANT boilerplate beyond the function grant above.
-- Does not touch begin_service_session_close, guard_service_session_closed_v1,
-- supersede_closeout_attempt, or any object row 56 also touches — those are
-- left exactly as row 58/59 already left them; this migration's only object
-- is the one function above.
COMMIT;
