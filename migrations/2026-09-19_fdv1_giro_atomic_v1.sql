-- migrations/2026-09-19_fdv1_giro_atomic_v1.sql
-- Paired rollback: 2026-09-19_fdv1_giro_atomic_v1.ROLLBACK.sql
--
-- FDV1 — DB-ATOMIC manual-giro mutations (closes concurrency risk B1).
--
-- WHY. PostgREST gives one HTTP request = one statement; a giro mutation is several requests, so
-- "read -> decide -> write" sequences interleave across backend PROCESSES (Railway deploy overlap, a
-- second replica). The process-local mutex in src/agents/manualGiros.js cannot see another process.
-- Recorded failure (C2b, real trace): P1 reads members [A] (<2); P2 attaches D and its own recompute
-- passes (P2 answers OK); P1 then runs UPDATE ordenes SET manual_giro_id=NULL WHERE manual_giro_id=G
-- (a WIDE predicate: it also detaches D) and dissolves the giro -> P2's "ok" was a lie.
--
-- WHAT. Eight small plpgsql functions, NO new table, NO new column, NO trigger, NO data change.
-- They reuse public.manual_giros and public.ordenes.manual_giro_id. Every mutation is ONE call =
-- ONE transaction that: takes ONE advisory lock for the whole giro domain -> reads state -> validates ->
-- mutates membership -> settles (heal / dissolve / align block offset) -> checks the post-condition ->
-- answers. A failed post-condition RAISEs, so the whole call rolls back (no partial state, no lie).
--
--   giro_lock_v1()                       the ONE lock (+ asserts READ COMMITTED)
--   giro_eligible_v1(tipo, estado)       single source of "can be a giro member" (mirror of JS SELECTABLE_STATES)
--   giro_settle_v1(giro, align)          heal links of a dissolved giro / detach ineligible / <2 members => dissolve /
--                                        null a stale anchor copy / align the block offset to the most urgent member
--   giro_create_v1(ids, by, day, require_free, block_departed)   create from >=2 orders, "move silent", IDEMPOTENT for the same
--                                        selection; the two optional guards make the Nuevo Pedido CREA GIRO decision atomic
--   giro_add_member_v1(giro, order, cap, block_departed)   add or MOVE; idempotent; atomic capacity / departed guards
--   giro_remove_member_v1(order)         detach + settle (dissolve when <2)
--   giro_dissolve_v1(giro)               detach all + dissolve (idempotent)
--   giro_reconcile_v1(align)             structural self-heal of the whole domain (idempotent)
--
-- WHY ONE LOCK (not one per giro). create and move touch 2+ giros; a single key gives one fixed order,
-- so no deadlock is possible, and the contention is irrelevant (a pizzeria issues tens of giro edits a night,
-- each a few ms). Row locks (FOR UPDATE) on the touched orders additionally serialise against writers that do
-- NOT use these functions (e.g. an estado change): the advisory lock is held until COMMIT.
--
-- WHAT IS NOT HERE (on purpose). The persisted compat copies manual_giros.anchor_order_id / entrega_ref /
-- hora_ref are derived from delivery deadlines; the truth is derived-at-read (getManualGiros). They are
-- refreshed by the backend with a guarded PATCH (dissolved_at IS NULL) and healed by reconcile. Only
-- membership / lifecycle needs atomicity, and that is all this migration touches. The only extra write is
-- "anchor copy -> NULL when the anchor left the giro", so a stored anchor can never point outside the giro.
--
-- ROLLOUT ORDER. This migration first (additive: nothing calls it yet), THEN the backend that calls it.
-- The backend fails CLOSED (503 giro_atomic_unavailable) if the functions are missing; it never falls back
-- to a non-atomic path. Rollback = redeploy the previous backend, then run the paired ROLLBACK file.
--
-- NOT APPLIED to any database by this commit/branch. Run by the operator in the SQL editor.

BEGIN;

-- ── Preconditions: fail loudly instead of creating half a feature ────────────────────────────────────────
DO $guard$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.manual_giros') IS NULL THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC refused: public.manual_giros does not exist';
  END IF;
  IF to_regclass('public.ordenes') IS NULL THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC refused: public.ordenes does not exist';
  END IF;
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY[
      'manual_giros.id','manual_giros.seq','manual_giros.giro_day','manual_giros.created_at','manual_giros.created_by',
      'manual_giros.dissolved_at','manual_giros.hora_ref','manual_giros.anchor_order_id','manual_giros.entrega_ref',
      'ordenes.id','ordenes.tipo_consegna','ordenes.estado','ordenes.manual_giro_id','ordenes.ui_offset_min'
    ]) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = split_part(c, '.', 1) AND column_name = split_part(c, '.', 2));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC refused: missing columns: %', v_missing;
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC refused: roles anon/authenticated/service_role must exist (Supabase)';
  END IF;
END $guard$;

-- ── 1. the ONE lock ──────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.giro_lock_v1()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- The read -> validate -> write sequences below rely on a fresh snapshot per statement AFTER the lock is
  -- granted (READ COMMITTED). Under REPEATABLE READ / SERIALIZABLE the snapshot could predate the lock wait.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC requires READ COMMITTED (got %)', current_setting('transaction_isolation')
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('la_dieci:manual_giro:v1', 0));
END
$fn$;

-- ── 2. eligibility: single source of truth (JS mirror: SELECTABLE_STATES + DOMICILIO) ────────────────────
CREATE OR REPLACE FUNCTION public.giro_eligible_v1(p_tipo text, p_estado text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(p_tipo = 'DOMICILIO'
                  AND p_estado IN ('POR_CONFIRMAR', 'EN_COCINA', 'LISTO', 'EN_ENTREGA'), false);
$fn$;

-- ── 3. settle: convergent + idempotent; writes ONLY where a defect exists ───────────────────────────────
CREATE OR REPLACE FUNCTION public.giro_settle_v1(p_giro_id text, p_align_offsets boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_g       public.manual_giros%ROWTYPE;
  v_members text[];
  v_n       int;
  v_off     int;
  v_c       int;
  v_changed boolean := false;
BEGIN
  PERFORM public.giro_lock_v1();
  IF p_giro_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'missing_giro_id');
  END IF;

  SELECT * INTO v_g FROM public.manual_giros WHERE id = p_giro_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 404, 'error', 'giro_not_found');
  END IF;

  IF v_g.dissolved_at IS NOT NULL THEN
    -- heal: an order still linked to a dissolved giro is detached (a dissolved giro owns no members)
    UPDATE public.ordenes SET manual_giro_id = NULL WHERE manual_giro_id = p_giro_id;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    RETURN jsonb_build_object('ok', true, 'dissolved', true, 'no_op', true, 'changed', v_c > 0, 'member_ids', '[]'::jsonb);
  END IF;

  -- members that are no longer eligible (estado left the selectable set / not a delivery) leave the giro
  UPDATE public.ordenes o SET manual_giro_id = NULL
   WHERE o.manual_giro_id = p_giro_id AND NOT public.giro_eligible_v1(o.tipo_consegna, o.estado);
  GET DIAGNOSTICS v_c = ROW_COUNT;
  v_changed := v_changed OR v_c > 0;

  SELECT COALESCE(array_agg(o.id ORDER BY o.id COLLATE "C"), ARRAY[]::text[]) INTO v_members
    FROM public.ordenes o WHERE o.manual_giro_id = p_giro_id;
  v_n := COALESCE(array_length(v_members, 1), 0);

  IF v_n < 2 THEN
    -- a giro needs 2+ members: release the survivor (if any) FIRST, then close the row (same transaction)
    UPDATE public.ordenes SET manual_giro_id = NULL WHERE manual_giro_id = p_giro_id;
    UPDATE public.manual_giros SET dissolved_at = now() WHERE id = p_giro_id AND dissolved_at IS NULL;
    RETURN jsonb_build_object('ok', true, 'dissolved', true, 'changed', true, 'member_ids', '[]'::jsonb);
  END IF;

  -- a stored anchor copy must point INTO the giro (the backend re-derives the right one right after)
  IF v_g.anchor_order_id IS NOT NULL AND NOT (v_g.anchor_order_id = ANY (v_members)) THEN
    UPDATE public.manual_giros SET anchor_order_id = NULL WHERE id = p_giro_id;
    v_changed := true;
  END IF;

  -- ONE shared block offset = the most urgent (lowest) member offset. Writes only on drift.
  SELECT min(COALESCE(o.ui_offset_min, 0)) INTO v_off FROM public.ordenes o WHERE o.manual_giro_id = p_giro_id;
  IF p_align_offsets THEN
    UPDATE public.ordenes SET ui_offset_min = v_off
     WHERE manual_giro_id = p_giro_id AND COALESCE(ui_offset_min, 0) <> v_off;
    GET DIAGNOSTICS v_c = ROW_COUNT;
    v_changed := v_changed OR v_c > 0;
  END IF;

  RETURN jsonb_build_object('ok', true, 'dissolved', false, 'changed', v_changed,
                            'member_ids', to_jsonb(v_members), 'offset_min', v_off);
END
$fn$;

-- ── 4. create (idempotent for the same selection; "move silent" for members of other giros) ─────────────
CREATE OR REPLACE FUNCTION public.giro_create_v1(p_order_ids text[], p_created_by text DEFAULT 'pin_dashboard', p_giro_day date DEFAULT NULL,
                                                 p_require_free boolean DEFAULT false, p_block_departed boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ids   text[];
  v_found int;
  v_bad   text[];
  v_gid   text;
  v_g     public.manual_giros%ROWTYPE;
  v_act   text[];
  v_prev  text[];
  v_pid   text;
  v_day   date;
  v_seq   int;
  v_n     int;
BEGIN
  PERFORM public.giro_lock_v1();

  IF p_order_ids IS NULL OR COALESCE(array_length(p_order_ids, 1), 0) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'need_at_least_2_orders');
  END IF;
  SELECT array_agg(x ORDER BY x COLLATE "C") INTO v_ids FROM (SELECT DISTINCT x FROM unnest(p_order_ids) AS x) s;
  IF array_length(v_ids, 1) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'need_at_least_2_distinct_orders');
  END IF;

  -- row locks on the members: serialise against writers that bypass this function (e.g. an estado change)
  PERFORM 1 FROM public.ordenes WHERE id = ANY (v_ids) ORDER BY id COLLATE "C" FOR UPDATE;
  SELECT count(*) INTO v_found FROM public.ordenes WHERE id = ANY (v_ids);
  IF v_found <> array_length(v_ids, 1) THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'some_orders_not_found',
                              'expected', array_length(v_ids, 1), 'got', v_found);
  END IF;
  SELECT array_agg(o.id ORDER BY o.id COLLATE "C") INTO v_bad
    FROM public.ordenes o WHERE o.id = ANY (v_ids) AND NOT public.giro_eligible_v1(o.tipo_consegna, o.estado);
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'invalid_orders', 'details', to_jsonb(v_bad));
  END IF;

  -- IDEMPOTENCY: the same selection already forming ONE alive giro (double click / retry / lost response)
  IF (SELECT count(DISTINCT COALESCE(manual_giro_id, '')) FROM public.ordenes WHERE id = ANY (v_ids)) = 1 THEN
    SELECT manual_giro_id INTO v_gid FROM public.ordenes WHERE id = v_ids[1];
    IF v_gid IS NOT NULL THEN
      SELECT * INTO v_g FROM public.manual_giros WHERE id = v_gid;
      IF FOUND AND v_g.dissolved_at IS NULL THEN
        SELECT array_agg(o.id ORDER BY o.id COLLATE "C") INTO v_act
          FROM public.ordenes o WHERE o.manual_giro_id = v_gid AND public.giro_eligible_v1(o.tipo_consegna, o.estado);
        IF v_act @> v_ids AND v_act <@ v_ids THEN
          RETURN jsonb_build_object('ok', true, 'idempotent', true, 'moved_from', '[]'::jsonb,
            'giro', jsonb_build_object('id', v_g.id, 'seq', v_g.seq, 'giro_day', v_g.giro_day,
                                       'created_at', v_g.created_at, 'created_by', v_g.created_by,
                                       'hora_ref', v_g.hora_ref, 'anchor_order_id', v_g.anchor_order_id,
                                       'entrega_ref', v_g.entrega_ref, 'order_ids', to_jsonb(v_ids)));
        END IF;
      END IF;
    END IF;
  END IF;

  -- OPTIONAL atomic guards for the Nuevo Pedido "CREA GIRO" intent (decided HERE, with the write, never from a stale client read):
  --   p_require_free    : refuse when a member already sits in ANOTHER alive giro (the suggestion is stale; never disturb a giro)
  --   p_block_departed  : refuse when a member has already left (EN_ENTREGA)
  IF p_require_free THEN
    SELECT array_agg(o.id ORDER BY o.id COLLATE "C") INTO v_bad
      FROM public.ordenes o JOIN public.manual_giros g ON g.id = o.manual_giro_id AND g.dissolved_at IS NULL
     WHERE o.id = ANY (v_ids);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'status', 409, 'error', 'members_already_in_giro', 'details', to_jsonb(v_bad));
    END IF;
  END IF;
  IF p_block_departed AND EXISTS (SELECT 1 FROM public.ordenes o WHERE o.id = ANY (v_ids) AND o.estado = 'EN_ENTREGA') THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'error', 'members_departed');
  END IF;

  v_day := COALESCE(p_giro_day, (now() AT TIME ZONE 'Europe/Madrid')::date);
  SELECT COALESCE(max(seq), 0) + 1 INTO v_seq FROM public.manual_giros WHERE giro_day = v_day;
  v_gid := 'mg_' || to_char(v_day, 'YYMMDD') || '_' || v_seq;
  INSERT INTO public.manual_giros (id, seq, giro_day, created_by, hora_ref, anchor_order_id, entrega_ref)
  VALUES (v_gid, v_seq, v_day, p_created_by, NULL, NULL, NULL)
  RETURNING * INTO v_g;

  SELECT COALESCE(array_agg(DISTINCT o.manual_giro_id) FILTER (WHERE o.manual_giro_id IS NOT NULL), ARRAY[]::text[])
    INTO v_prev FROM public.ordenes o WHERE o.id = ANY (v_ids);

  UPDATE public.ordenes SET manual_giro_id = v_gid WHERE id = ANY (v_ids);

  FOREACH v_pid IN ARRAY v_prev LOOP
    PERFORM public.giro_settle_v1(v_pid);      -- each previous giro: dissolve if it dropped below 2
  END LOOP;
  PERFORM public.giro_settle_v1(v_gid);

  -- POST-CONDITION: the new giro is alive and holds exactly the requested, eligible orders
  SELECT count(*) INTO v_n FROM public.ordenes o
   WHERE o.manual_giro_id = v_gid AND public.giro_eligible_v1(o.tipo_consegna, o.estado);
  IF v_n <> array_length(v_ids, 1)
     OR (SELECT dissolved_at FROM public.manual_giros WHERE id = v_gid) IS NOT NULL THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC post-condition failed: create %', v_gid USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'moved_from', to_jsonb(v_prev),
    'giro', jsonb_build_object('id', v_g.id, 'seq', v_g.seq, 'giro_day', v_g.giro_day, 'created_at', v_g.created_at,
                               'created_by', v_g.created_by, 'hora_ref', NULL, 'anchor_order_id', NULL,
                               'entrega_ref', NULL, 'order_ids', to_jsonb(v_ids)));
END
$fn$;

-- ── 5. add / MOVE one order (idempotent; capacity + departed guards are atomic) ─────────────────────────
CREATE OR REPLACE FUNCTION public.giro_add_member_v1(p_giro_id text, p_order_id text, p_max_members integer DEFAULT NULL, p_block_departed boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_g    public.manual_giros%ROWTYPE;
  v_o    public.ordenes%ROWTYPE;
  v_prev text;
  v_pr   jsonb;
  v_act  int;
BEGIN
  PERFORM public.giro_lock_v1();
  IF p_giro_id IS NULL OR p_order_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'missing_args');
  END IF;

  SELECT * INTO v_g FROM public.manual_giros WHERE id = p_giro_id FOR UPDATE;
  IF NOT FOUND OR v_g.dissolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 404, 'error', 'giro_not_found_or_dissolved');
  END IF;
  SELECT * INTO v_o FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 404, 'error', 'order_not_found');
  END IF;
  IF NOT public.giro_eligible_v1(v_o.tipo_consegna, v_o.estado) THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'order_not_eligible');
  END IF;

  IF v_o.manual_giro_id = p_giro_id THEN            -- retry / replay: already a member
    PERFORM public.giro_settle_v1(p_giro_id);
    RETURN jsonb_build_object('ok', true, 'no_op', true, 'moved_from', NULL);
  END IF;

  IF p_block_departed AND EXISTS (SELECT 1 FROM public.ordenes o
        WHERE o.manual_giro_id = p_giro_id AND o.estado = 'EN_ENTREGA'
          AND public.giro_eligible_v1(o.tipo_consegna, o.estado)) THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'error', 'giro_departed');
  END IF;
  SELECT count(*) INTO v_act FROM public.ordenes o
   WHERE o.manual_giro_id = p_giro_id AND public.giro_eligible_v1(o.tipo_consegna, o.estado);
  IF v_act < 1 THEN                                  -- the giro lost its members: joining it would make a 1-member giro
    RETURN jsonb_build_object('ok', false, 'status', 409, 'error', 'giro_changed_during_add');
  END IF;
  IF p_max_members IS NOT NULL AND v_act + 1 > p_max_members THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'error', 'giro_full', 'max', p_max_members);
  END IF;

  v_prev := v_o.manual_giro_id;
  UPDATE public.ordenes SET manual_giro_id = p_giro_id WHERE id = p_order_id;
  IF v_prev IS NOT NULL THEN
    v_pr := public.giro_settle_v1(v_prev);           -- "move silent": the previous giro is settled in the SAME transaction
  END IF;
  PERFORM public.giro_settle_v1(p_giro_id);

  -- POST-CONDITION: the order is an eligible member of an alive giro
  IF NOT EXISTS (SELECT 1 FROM public.ordenes o JOIN public.manual_giros g ON g.id = o.manual_giro_id
                  WHERE o.id = p_order_id AND o.manual_giro_id = p_giro_id AND g.dissolved_at IS NULL
                    AND public.giro_eligible_v1(o.tipo_consegna, o.estado)) THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC post-condition failed: add % -> %', p_order_id, p_giro_id USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'moved_from', v_prev,
    'auto_dissolved_prev', COALESCE((v_pr->>'dissolved')::boolean AND NOT COALESCE((v_pr->>'no_op')::boolean, false), false));
END
$fn$;

-- ── 6. remove one member ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.giro_remove_member_v1(p_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_o    public.ordenes%ROWTYPE;
  v_prev text;
  v_r    jsonb;
BEGIN
  PERFORM public.giro_lock_v1();
  IF p_order_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'missing_order_id');
  END IF;
  SELECT * INTO v_o FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 404, 'error', 'order_not_found');
  END IF;
  IF v_o.manual_giro_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'no_op', true, 'auto_dissolved', false);
  END IF;

  v_prev := v_o.manual_giro_id;
  UPDATE public.ordenes SET manual_giro_id = NULL WHERE id = p_order_id AND manual_giro_id = v_prev;   -- conditional: only the membership we read
  v_r := public.giro_settle_v1(v_prev);

  IF EXISTS (SELECT 1 FROM public.ordenes WHERE id = p_order_id AND manual_giro_id IS NOT NULL) THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC post-condition failed: remove %', p_order_id USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('ok', true, 'giro_id', v_prev,
    'auto_dissolved', COALESCE((v_r->>'dissolved')::boolean AND NOT COALESCE((v_r->>'no_op')::boolean, false), false));
END
$fn$;

-- ── 7. dissolve ──────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.giro_dissolve_v1(p_giro_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
BEGIN
  PERFORM public.giro_lock_v1();
  IF p_giro_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 400, 'error', 'missing_giro_id');
  END IF;
  UPDATE public.ordenes SET manual_giro_id = NULL WHERE manual_giro_id = p_giro_id;
  UPDATE public.manual_giros SET dissolved_at = now() WHERE id = p_giro_id AND dissolved_at IS NULL;
  IF EXISTS (SELECT 1 FROM public.ordenes WHERE manual_giro_id = p_giro_id) THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC post-condition failed: dissolve %', p_giro_id USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('ok', true);
END
$fn$;

-- ── 8. reconcile: structural self-heal of the whole domain (idempotent; safe at boot) ───────────────────
CREATE OR REPLACE FUNCTION public.giro_reconcile_v1(p_align_offsets boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_orph int := 0;
  v_id   text;
  v_r    jsonb;
  v_rec  text[] := ARRAY[]::text[];
BEGIN
  PERFORM public.giro_lock_v1();
  -- links to a dissolved / missing giro
  UPDATE public.ordenes o SET manual_giro_id = NULL
   WHERE o.manual_giro_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.manual_giros g WHERE g.id = o.manual_giro_id AND g.dissolved_at IS NULL);
  GET DIAGNOSTICS v_orph = ROW_COUNT;
  -- every alive giro: settle writes only where a defect exists, so a healthy giro is never rewritten
  FOR v_id IN SELECT g.id FROM public.manual_giros g WHERE g.dissolved_at IS NULL ORDER BY g.id COLLATE "C" LOOP
    v_r := public.giro_settle_v1(v_id, p_align_offsets);
    IF COALESCE((v_r->>'changed')::boolean, false) THEN
      v_rec := v_rec || v_id;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'detached_orphans', v_orph, 'recomputed', to_jsonb(v_rec));
END
$fn$;

-- ── documentation in the catalog ─────────────────────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.giro_lock_v1() IS 'FDV1: the single advisory lock of the manual-giro domain (xact-scoped) + READ COMMITTED assertion.';
COMMENT ON FUNCTION public.giro_eligible_v1(text, text) IS 'FDV1: DOMICILIO in POR_CONFIRMAR/EN_COCINA/LISTO/EN_ENTREGA (mirror of manualGiros.js SELECTABLE_STATES).';
COMMENT ON FUNCTION public.giro_settle_v1(text, boolean) IS 'FDV1: heal / dissolve(<2) / align block offset / null stale anchor copy. Convergent, idempotent.';
COMMENT ON FUNCTION public.giro_create_v1(text[], text, date, boolean, boolean) IS 'FDV1: atomic create; idempotent for the same selection; move-silent for members of other giros; optional atomic guards (p_require_free = CREA GIRO intent must not disturb an existing giro; p_block_departed).';
COMMENT ON FUNCTION public.giro_add_member_v1(text, text, integer, boolean) IS 'FDV1: atomic add/move of one order; optional capacity + departed guards; idempotent.';
COMMENT ON FUNCTION public.giro_remove_member_v1(text) IS 'FDV1: atomic detach + settle (dissolves the giro below 2 members).';
COMMENT ON FUNCTION public.giro_dissolve_v1(text) IS 'FDV1: atomic detach-all + dissolve; idempotent.';
COMMENT ON FUNCTION public.giro_reconcile_v1(boolean) IS 'FDV1: structural self-heal (orphan links, <2 members, ineligible members, stale anchor copy, block offset). Idempotent; safe at boot with align=false.';

-- ── grants: least privilege. The backend uses service_role; anon/authenticated must NOT mutate giros ─────
REVOKE ALL ON FUNCTION public.giro_lock_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.giro_eligible_v1(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.giro_settle_v1(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.giro_create_v1(text[], text, date, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.giro_add_member_v1(text, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.giro_remove_member_v1(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.giro_dissolve_v1(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.giro_reconcile_v1(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.giro_lock_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_eligible_v1(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_settle_v1(text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_create_v1(text[], text, date, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_add_member_v1(text, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_remove_member_v1(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_dissolve_v1(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_reconcile_v1(boolean) TO service_role;

-- ── self-verification: the migration refuses to commit a wrong state ────────────────────────────────────
DO $verify$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('giro_lock_v1','giro_eligible_v1','giro_settle_v1','giro_create_v1',
                                                'giro_add_member_v1','giro_remove_member_v1','giro_dissolve_v1','giro_reconcile_v1');
  IF v_n <> 8 THEN RAISE EXCEPTION 'FDV1_GIRO_ATOMIC verify failed: expected 8 functions, found %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname LIKE 'giro\_%\_v1' AND p.prosecdef) THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC verify failed: a function is SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.giro_add_member_v1(text,text,integer,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.giro_create_v1(text[],text,date,boolean,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.giro_reconcile_v1(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC verify failed: grants are not least-privilege';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
