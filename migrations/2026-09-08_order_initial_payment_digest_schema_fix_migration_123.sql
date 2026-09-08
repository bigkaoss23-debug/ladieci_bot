-- migrations/2026-09-08_order_initial_payment_digest_schema_fix_migration_123.sql
-- ORDER_INITIAL_PAYMENT DIGEST SCHEMA QUALIFICATION — fixes the SQLSTATE 42883
-- that broke EVERY creation-time "ya pagado" order the moment migration 122
-- went live.
--
-- FORENSIC ROOT CAUSE (FORENSIC_YA_PAGADO_CREATION_FAILURE_M122_2026-09-08.md,
-- read-only audit, 2026-09-08). A live authenticated STAGING test — fresh
-- login, Servicio/Banco/Retiro, Pagado=true, Efectivo — failed with
-- "No se pudo confirmar el pedido." and rolled back atomically (proven: zero
-- new order/obligation/payment/service/business-day rows anywhere). The
-- INSERT into `ordenes` came back from PostgREST as HTTP 404, which on a
-- table INSERT can only be produced by SQLSTATE 42883 (undefined_function)
-- or 42P01 (undefined_table) — never by any of this codebase's own `RAISE
-- ... P0001` gates (those map to 400), which by itself already eliminated
-- ORDER_INTAKE_CLOSED and every INITIAL_PAYMENT_*/ORDER_PAYMENT_* refusal as
-- the cause. Read-only catalog proof pinned the exact object: migration 122
-- (`2026-09-07_check_centric_universal_cash_v1_migration_122.sql`, line
-- 1245) left `order_initial_payment_v1()` with
-- `SET search_path TO 'public', 'pg_temp'` — inherited verbatim from N-3
-- (`2026-08-24_n3_canonical_initial_payment.sql`), where it was correct
-- because that version called no extension function — while introducing, at
-- line 1308, the function's first-ever bare call to `digest(...)`.
-- `pgcrypto` on this Supabase project installs `digest(text,text)` ONLY in
-- schema `extensions` (confirmed live: no `public.digest` overload exists),
-- so under this function's own search_path the call cannot resolve.
-- Independently confirmed by name-resolution proof under both search_paths
-- (`to_regprocedure('digest(text,text)')` returns NULL under
-- `public, pg_temp`, resolves under `public, extensions, pg_temp`), and by a
-- full-schema sweep proving `order_initial_payment_v1` is the ONLY function
-- in `public` calling digest/crypt/hmac/gen_random_bytes without
-- `extensions` on its own search_path — migration 122's three sibling
-- writers it created in the same file (`order_post_payment_v1`,
-- `order_post_refund_v1`) and the one Mesa function it touched
-- (`mesa_post_refund_v1`) all correctly carry `public, extensions, pg_temp`.
-- The contrast is the proof this was an oversight on one function, not a
-- deliberate design choice.
--
-- OWNER DECISION, FROZEN — do NOT fix this by widening
-- `order_initial_payment_v1`'s search_path to include `extensions`. Make the
-- cryptographic dependency explicit and schema-qualified at the call site
-- instead, independent of ambient search_path resolution:
--
--   BEFORE:  v_request_hash := encode(digest(...), 'hex');
--   AFTER:   v_request_hash := encode(extensions.digest(...), 'hex');
--
-- `order_initial_payment_v1`'s `SET search_path TO 'public', 'pg_temp'`
-- stays EXACTLY as migration 122 left it — this migration does not touch it.
--
-- SCOPE — ONE function, ONE line changed. Every declaration, guard,
-- validation order, the deterministic `pay-order-<id>` client_request_id,
-- the request-hash's semantic input material (`concat_ws('|',
-- 'initial_payment_at_creation', NEW.id, NEW.order_uid::text, v_method)`),
-- its `encode(..., 'hex')` output encoding, the canonical
-- `order_post_payment_v1(...)` call and its arguments, the
-- `initial_payment_intent` clearing UPDATE, and every existing comment are
-- reproduced byte-identical to the currently-installed migration-122 body
-- below. Only function-resolution authority changes; the request-hash
-- ALGORITHM (sha256) and its VALUE for identical input are unchanged —
-- `extensions.digest` and the unqualified `digest` that resolved to it
-- before this defect are the exact same compiled C function
-- (`pgcrypto.so`'s `digest(bytea,text)`/`digest(text,text)`), never
-- redefined or aliased anywhere in this database.
--
-- WHAT THIS MIGRATION DOES NOT DO (frozen non-goals):
--   * Does NOT modify migration 122's forward or rollback file. Both are
--     APPLIED and historically immutable; this migration is the sole
--     correction vehicle.
--   * Does NOT touch `order_post_payment_v1`, `order_post_refund_v1`,
--     `order_apply_commercial_adjustment_v1`, `mesa_post_refund_v1`, or any
--     other Mesa payment function — all already carry `extensions` on their
--     own search_path and are unaffected by this defect.
--   * Does NOT add `extensions` to any role or database-level search_path.
--   * Does NOT change any table, column, constraint, index, grant, or
--     privilege. No DDL beyond the one `CREATE OR REPLACE FUNCTION` below.
--     No DML, no backfill.
--   * Does NOT touch the paid-at-creation trigger
--     (`ordenes_paid_at_creation_payment_v1`) itself — only the function
--     body it points to.
--   * Does NOT resolve `MANUAL_ORDER_INTAKE_BUSINESS_DAY_AUTHORITY_V1` (the
--     unrelated 08:00 order-intake hardcode debt from the same forensic
--     audit, which explains an EARLIER, separate 07:19 failure, not this
--     one) or any of the other debts the forensic report recorded
--     separately (OBSERVABILITY_SUPABASE_ERROR_BODY_V1,
--     ORDER_CREATION_ERROR_DETAIL_LOST_V1,
--     FINANCIAL_LEDGER_SERVICE_ROLE_PRIVILEGE_HARDENING_REVIEW,
--     RIDER_LEGACY_PAYMENT_FAST_FOLLOW,
--     SERVICIO_DEAD_ONCAMBIAPAGO_CANONICAL_CONFLICT).
--
-- STAGING ONLY. NOT APPLIED IN THIS COMMIT (NO PUSH / NO DEPLOY / NO STAGING
-- DB APPLY). Ledger stays 122 until a separate promotion authorization.
-- Function body uses $function$...$function$; DO blocks use named tags
-- ($guard$ / $resolve$ / $post$), never a bare $$ — house style, see
-- migrations 121/122.

BEGIN;

-- ── PRE-CONDITION: refuse on drift / if already applied ──────────────────────
DO $guard$
DECLARE
  v_def text;
  v_search_path text;
BEGIN
  -- A/B. order_initial_payment_v1 must exist and be a trigger function.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='order_initial_payment_v1'
       AND p.prorettype = 'trigger'::regtype
  ) THEN
    RAISE EXCEPTION 'M123 refused: public.order_initial_payment_v1() missing or not a trigger function -- resolve drift first';
  END IF;

  -- C. search_path must be EXACTLY the expected pre-fix (M122) epoch -- a
  -- byte-exact array_to_string comparison, not a LIKE, so an unexpected
  -- third search_path entry refuses rather than silently passing.
  SELECT array_to_string(p.proconfig, ',') INTO v_search_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';
  IF v_search_path IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION 'M123 refused: order_initial_payment_v1 search_path is not the expected M122 epoch (found: %) -- resolve drift first', v_search_path;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';

  -- D. the canonical writer call must already be present -- proves M122's
  -- repoint (legacy order_mark_paid -> order_post_payment_v1) already landed
  -- and this migration is a narrow schema-qualification fix on top of it,
  -- not a re-run of M122 itself. Comment-safe: anchored to the exact
  -- executable CALL STATEMENT shape (see M122's own fast-follow comment on
  -- why a bare name search is unsound in both directions), not a name
  -- mention that a comment could also produce.
  IF position('PERFORM public.order_post_payment_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 refused: order_initial_payment_v1 does not call order_post_payment_v1 -- apply migration 122 first';
  END IF;

  -- E. the exact unqualified request-hash assignment this migration owns
  -- correcting must be present. Anchored to the assignment statement itself
  -- (`v_request_hash := encode(digest(`), not a bare `digest(` substring,
  -- which this same function's own comments never contain today but a
  -- future comment edit could -- same comment-safety discipline as D.
  IF position('v_request_hash := encode(digest(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 refused: order_initial_payment_v1 does not contain the unqualified digest() request-hash assignment -- resolve drift first';
  END IF;

  -- F. must not already be fixed.
  IF position('extensions.digest(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M123 refused: order_initial_payment_v1 already calls extensions.digest -- already applied?';
  END IF;

  -- G. the paid-at-creation trigger must still be live and still target this
  -- exact function -- by OID IDENTITY (tgfoid), never by pg_get_triggerdef's
  -- RENDERED text, which M122's own history proved is search_path-dependent
  -- (a bare function name in the rendered EXECUTE FUNCTION clause renders
  -- differently depending on the CHECKING session's own search_path, not
  -- the trigger's or function's -- see migration 122's ROBUSTNESS
  -- FAST-FOLLOW comment for the live, both-ways proof of that).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='ordenes'
      AND t.tgname='ordenes_paid_at_creation_payment_v1' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A')
      AND t.tgfoid = 'public.order_initial_payment_v1()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'M123 refused: ordenes_paid_at_creation_payment_v1 is missing, disabled/replica-only, or no longer targets order_initial_payment_v1';
  END IF;

  -- H. ledger baseline is 122, not yet 123 -- checked only if the ledger
  -- table exists (it is this project's own append-only record, not a
  -- Supabase-CLI table this migration can assume in every environment).
  IF to_regclass('public.ladieci_schema_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 122) THEN
      RAISE EXCEPTION 'M123 refused: ladieci_schema_migrations has no apply_order=122 row -- baseline is not 122';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 123) THEN
      RAISE EXCEPTION 'M123 refused: ladieci_schema_migrations already has an apply_order=123 row -- already applied?';
    END IF;
  END IF;

  -- Snapshot identity/scope for the post-condition. The function's OID must
  -- survive CREATE OR REPLACE unchanged (same name + same 0-arg signature
  -- never reallocates it) -- proves a body edit, not a drop+recreate under a
  -- different identity. The public-schema function count and `ordenes` row
  -- count prove this migration touches exactly one function body and writes
  -- no data.
  PERFORM set_config('ladieci.m123_fn_oid',
    (SELECT p.oid::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='order_initial_payment_v1'), false);
  PERFORM set_config('ladieci.m123_public_fn_count',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'), false);
  PERFORM set_config('ladieci.m123_ordenes_count',
    (SELECT count(*)::text FROM public.ordenes), false);
END $guard$;

-- ── SEARCH_PATH INDEPENDENCE PROOF — read-only, transaction-local only ───────
-- `extensions.digest(text,text)` must exist for the schema-qualified call
-- below to resolve at all, independent of `order_initial_payment_v1`'s own
-- search_path (which this migration leaves at `public, pg_temp`). Proven
-- under BOTH conceptual search_path states in the same transaction via
-- `SET LOCAL` -- scoped to this transaction only, reverting automatically at
-- COMMIT regardless of outcome; never touches the role/database default.
DO $resolve$
DECLARE
  v_oid_excl regprocedure;
  v_oid_incl regprocedure;
BEGIN
  IF to_regprocedure('extensions.digest(text,text)') IS NULL THEN
    RAISE EXCEPTION 'M123 refused: extensions.digest(text,text) does not exist -- pgcrypto not installed in schema extensions';
  END IF;

  -- State 1: search_path EXCLUDING extensions -- this function's own path,
  -- and the exact path under which the forensic 42883 occurred. The
  -- UNQUALIFIED name must NOT resolve here (reproducing the defect this
  -- migration fixes); the schema-qualified one is captured for comparison.
  SET LOCAL search_path TO 'public', 'pg_temp';
  IF to_regprocedure('digest(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'M123 refused: digest(text,text) unexpectedly resolves under search_path=public,pg_temp -- environment does not reproduce the forensic defect, resolve drift first';
  END IF;
  v_oid_excl := to_regprocedure('extensions.digest(text,text)');

  -- State 2: search_path INCLUDING extensions (the ambient-resolution path
  -- the OWNER explicitly rejected using as the fix -- see this file's
  -- header). Captured only to prove the schema-qualified reference is
  -- identical either way, i.e. genuinely independent of search_path.
  SET LOCAL search_path TO 'public', 'extensions', 'pg_temp';
  v_oid_incl := to_regprocedure('extensions.digest(text,text)');

  IF v_oid_excl IS NULL OR v_oid_excl IS DISTINCT FROM v_oid_incl THEN
    RAISE EXCEPTION 'M123 refused: extensions.digest(text,text) resolves inconsistently across search_path states (% vs %) -- expected the identical function either way', v_oid_excl, v_oid_incl;
  END IF;

  -- SET LOCAL is transaction-scoped by definition: no RESET is needed for it
  -- not to persist past COMMIT, but restored explicitly here anyway so every
  -- statement for the remainder of this migration runs under the session's
  -- ordinary search_path, not this proof's temporary ones.
  RESET search_path;
END $resolve$;

-- ── THE FIX — schema-qualify the ONE call site, nothing else. Everything
-- below this line, including every comment, is byte-identical to the
-- currently-installed migration-122 body except the single digest(...) ->
-- extensions.digest(...) substitution in the request-hash assignment.
CREATE OR REPLACE FUNCTION public.order_initial_payment_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := NEW.initial_payment_intent;
  v_method text;
  v_actor  text;
  v_sid_hash text;
  v_workspace_id uuid;
  v_client_request_id text;
  v_request_hash text;
BEGIN
  -- Defence in depth: the trigger is already WHEN-scoped to a non-null intent.
  IF v_intent IS NULL THEN
    RETURN NEW;
  END IF;

  -- Mesa settles through its own payment hub (payment_transactions /
  -- payment_allocations / mesa_post_payment_v1). A table order must never take a
  -- second, parallel payment here. The frontend already forbids it; this refuses
  -- it at the boundary rather than trusting that.
  IF NEW.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s table_session=%s', NEW.id, NEW.table_session_id);
  END IF;

  -- The whole point of N-3: legacy-paid authority must NOT precede the canonical
  -- payment. If either flag arrived true, someone is still trying to declare money
  -- with a boolean -- refuse rather than paper over it.
  IF NEW.ya_pagado IS TRUE OR NEW.cobrado IS TRUE THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_LEGACY_FLAG_PRESENT' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s ya_pagado=%s cobrado=%s', NEW.id, NEW.ya_pagado, NEW.cobrado);
  END IF;

  v_method   := lower(btrim(COALESCE(v_intent->>'method', '')));
  v_actor    := btrim(COALESCE(v_intent->>'actor', ''));
  v_sid_hash := lower(btrim(COALESCE(v_intent->>'sid_hash', '')));

  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_METHOD_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s method=%s', NEW.id, v_method);
  END IF;
  IF v_actor = '' OR v_sid_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_CONTEXT_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s actor_present=%s sid_hash_valid=%s',
                      NEW.id, (v_actor <> ''), (v_sid_hash ~ '^[0-9a-f]{64}$'));
  END IF;

  SELECT oe.workspace_id INTO v_workspace_id
    FROM public.order_entities oe WHERE oe.order_uid = NEW.order_uid;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_WORKSPACE_UNRESOLVED' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s order_uid=%s', NEW.id, NEW.order_uid);
  END IF;

  -- SAME deterministic per-order key the legacy path always used -- this is what
  -- makes a replayed order-creation request replay instead of double-paying
  -- (§9/§22 of the brief): payment_transactions_idempotency_uq is (workspace_id,
  -- client_request_id), so this key now plays exactly the role
  -- registerOperatorPayment.js's idem_scope_key played for _ledger_write_payment.
  v_client_request_id := 'pay-order-' || regexp_replace(NEW.id, '[^A-Za-z0-9_-]', '', 'g');
  v_request_hash := encode(extensions.digest(concat_ws('|', 'initial_payment_at_creation', NEW.id,
    NEW.order_uid::text, v_method), 'sha256'), 'hex');

  -- THE canonical check-centric payment writer -- same authority, server-derived
  -- amount, digest, and legacy mirrors as the operator collection path (§R of the
  -- audit). mode='full': a creation-time "ya pagado" always settles the order's
  -- FULL obligation, exactly like _ledger_write_payment/order_mark_paid did.
  PERFORM public.order_post_payment_v1(
    v_workspace_id, v_actor, v_sid_hash, NEW.order_uid, v_method, 'full', NULL,
    v_client_request_id, v_request_hash,
    jsonb_build_object('source', 'initial_payment_at_creation'), false);

  -- The intent has done its one job. Clearing it here keeps the column NULL at
  -- rest; this UPDATE touches no economic column, so neither N-5's guard nor
  -- N-2's revision trigger fires.
  UPDATE public.ordenes SET initial_payment_intent = NULL WHERE id = NEW.id;

  RETURN NEW;
END;
$function$;

-- ── POST-CONDITION ────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def text;
BEGIN
  -- A/OID-identity. Same function, same OID -- CREATE OR REPLACE on an
  -- unchanged name/0-arg signature never reallocates it; a changed OID here
  -- would mean this was a drop+recreate, not the intended in-place body edit.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='order_initial_payment_v1'
       AND p.oid::text = current_setting('ladieci.m123_fn_oid', true)
  ) THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 OID changed -- expected an in-place CREATE OR REPLACE';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';

  -- C. search_path remains EXACTLY the M122 epoch -- this migration does not
  -- widen it; the fix is the explicit qualification below, not ambient scope.
  IF (SELECT array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='order_initial_payment_v1')
     IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 search_path changed -- must stay public, pg_temp';
  END IF;

  -- D. the schema-qualified call is present at the exact assignment site.
  IF position('v_request_hash := encode(extensions.digest(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 does not call extensions.digest at the request-hash assignment';
  END IF;

  -- E. the unqualified call is gone from that assignment. Safe as a
  -- complementary check: "encode(extensions.digest(" cannot itself contain
  -- the substring "encode(digest(" (the "extensions." token sits between
  -- them), so this cannot false-negative against the fixed body.
  IF position('v_request_hash := encode(digest(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 still contains the unqualified digest() request-hash assignment';
  END IF;

  -- F. canonical writer call unchanged.
  IF position('PERFORM public.order_post_payment_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 no longer calls order_post_payment_v1';
  END IF;

  -- G. legacy writer absent (never reintroduced by this fix).
  IF position('PERFORM public.order_mark_paid(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 must not call order_mark_paid';
  END IF;

  -- Request-hash semantic input material unchanged (§10 of the brief): the
  -- same three-part concat_ws under 'initial_payment_at_creation', keyed on
  -- NEW.id / NEW.order_uid::text / v_method, still feeds the digest call.
  IF position('concat_ws(''|'', ''initial_payment_at_creation'', NEW.id,' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: request-hash input material changed -- concat_ws prefix/order_id missing';
  END IF;
  IF position('NEW.order_uid::text, v_method), ''sha256''), ''hex'');' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: request-hash input material or output encoding changed';
  END IF;

  -- Deterministic client_request_id key unchanged -- a replayed
  -- order-creation request must still replay, never double-charge.
  IF position('pay-order-' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 lost the deterministic pay-order-<id> key';
  END IF;

  -- Every existing N-3/M122 refusal gate still present.
  IF position('INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER' IN v_def) = 0
     OR position('INITIAL_PAYMENT_LEGACY_FLAG_PRESENT' IN v_def) = 0
     OR position('INITIAL_PAYMENT_METHOD_INVALID' IN v_def) = 0
     OR position('INITIAL_PAYMENT_CONTEXT_INVALID' IN v_def) = 0
     OR position('INITIAL_PAYMENT_WORKSPACE_UNRESOLVED' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 post-condition failed: order_initial_payment_v1 lost an existing guard';
  END IF;

  -- H. the paid-at-creation trigger remains installed, enabled, and targets
  -- this exact (identity-preserved) function -- by OID, not rendered text.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='ordenes'
      AND t.tgname='ordenes_paid_at_creation_payment_v1' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A')
      AND t.tgfoid = 'public.order_initial_payment_v1()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'M123 post-condition failed: ordenes_paid_at_creation_payment_v1 missing, disabled, or retargeted';
  END IF;

  -- I. no unrelated object change: exactly the same number of functions in
  -- `public` (this migration creates/drops none, only replaces one body),
  -- and zero rows written anywhere.
  IF (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
     IS DISTINCT FROM current_setting('ladieci.m123_public_fn_count', true) THEN
    RAISE EXCEPTION 'M123 post-condition failed: number of functions in public schema changed -- scope must be exactly one function body edit';
  END IF;
  IF (SELECT count(*)::text FROM public.ordenes) IS DISTINCT FROM current_setting('ladieci.m123_ordenes_count', true) THEN
    RAISE EXCEPTION 'M123 post-condition failed: ordenes row count changed -- this migration must write no data';
  END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-122: registered as a separate statement at apply time -- apply_order
-- 123, kind 'ddl', checksum = this file's sha256, applied_by = the
-- introducing commit (committed BEFORE this migration is applied). NOT
-- APPLIED in this commit -- ledger stays 122.

COMMIT;
