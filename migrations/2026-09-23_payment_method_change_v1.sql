-- migrations/2026-09-23_payment_method_change_v1.sql
-- Paired rollback: 2026-09-23_payment_method_change_v1.ROLLBACK.sql
--
-- PAYMENT-IDEMPOTENCY — correzione ATOMICA del metodo di pagamento di un ordine RETIRADO.
--
-- WHY. La correzione esplicita (action cambiarMetodoPago) erano due richieste PostgREST: PATCH ordenes, poi
-- INSERT orden_estado_logs, con un revert HTTP compensativo se l'audit falliva. Con uno scrittore concorrente
-- il revert poteva (correttamente) rifiutarsi di sovrascrivere → "metodo cambiato + audit mancante". Per la
-- Caja non è accettabile: o cambiano ENTRAMBI (metodo + audit) o NESSUNO dei due.
--
-- WHAT. UNA funzione plpgsql, nessuna tabella, nessuna colonna, nessun trigger, nessun dato toccato.
-- Una chiamata = UNA transazione (PostgREST esegue ogni RPC in una transazione) che:
--   lock di riga (SELECT … FOR UPDATE) → valida → UPDATE ordenes (metodo_pago, cobrado=true, updated_at)
--   → INSERT orden_estado_logs (payment_method_changed, RETIRADO→RETIRADO, from/to, actor, origin, reason,
--   created_at = now() del server) → risposta tipata.
-- Qualunque errore dopo l'UPDATE (INSERT dell'audit rifiutato, vincolo, permesso, cancel) abortisce la
-- transazione: l'UPDATE viene annullato dal database stesso. Nessun revert applicativo.
--
--   Esiti tipati (mai un'eccezione per un esito di business):
--     {ok:true, noop:true}                      stesso metodo già registrato (doppio click / retry): NESSUNA scrittura, nessun audit
--     {ok:true, metodo_pago, metodo_pago_anterior, audit_id, audit_at}   cambio avvenuto: UPDATE + audit nella stessa transazione
--     {ok:false, error:'payment_method_required'}           metodo nuovo ∉ efectivo|tarjeta|bizum (mai "manual")
--     {ok:false, error:'expected_method_required'}          metodo atteso assente: senza non si può escludere una tab stale
--     {ok:false, error:'not_found' | 'payment_change_requires_retirado'}
--     {ok:false, error:'payment_method_conflict', metodo_pago_actual}   atteso ≠ corrente: nessuna modifica
--
-- CONCORRENZA. FOR UPDATE serializza con ogni altro scrittore della riga (anche la finalizzazione, che è un
-- UPDATE condizionato). In READ COMMITTED chi attende rilegge la versione committata: di due correzioni con lo
-- stesso atteso ne vince una, l'altra vede il metodo nuovo → noop (stesso target) o conflict (target diverso).
-- Sotto REPEATABLE READ / SERIALIZABLE il FOR UPDATE su una riga cambiata solleva 40001: fallimento pulito,
-- mai un partial success.
--
-- SECURITY. SECURITY INVOKER (come le giro_*_v1): gira con i privilegi di chi chiama. EXECUTE revocato a
-- PUBLIC/anon/authenticated, concesso SOLO a service_role (il backend). search_path fissato. Il ruolo
-- repartidor non raggiunge l'action: il proxy Netlify non la inoltra (REPARTIDOR_ALLOWED).
--
-- ROLLOUT ORDER. Questa migration PRIMA (additiva: nessuno la chiama), POI il backend che la chiama.
-- Il backend fallisce CHIUSO (payment_atomic_unavailable) se la funzione manca: nessun fallback non atomico.
-- Rollback = ridistribuire il backend precedente, poi eseguire il file ROLLBACK accoppiato.
--
-- NOT APPLIED to any database by this commit/branch. Run by the operator in the SQL editor.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.ordenes') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 refused: public.ordenes does not exist';
  END IF;
  IF to_regclass('public.orden_estado_logs') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 refused: public.orden_estado_logs does not exist';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ordenes'
         AND column_name IN ('id','estado','tipo_consegna','cobrado','metodo_pago','updated_at')) <> 6 THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 refused: ordenes is missing a required column';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'orden_estado_logs'
         AND column_name IN ('id','orden_id','numero_ordine','estado_from','estado_to','event_type',
                             'actor_type','actor_id','origin','created_at','metadata')) <> 11 THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 refused: orden_estado_logs is missing a required column';
  END IF;
  IF to_regprocedure('public.payment_method_change_v1(text,text,text,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 refused: function already exists (run the ROLLBACK first to re-apply)';
  END IF;
END $guard$;

CREATE FUNCTION public.payment_method_change_v1(
  p_order_id        text,
  p_new_method      text,
  p_expected_method text,
  p_actor_type      text DEFAULT 'operator',
  p_actor_id        text DEFAULT NULL,
  p_origin          text DEFAULT 'dashboard',
  p_reason          text DEFAULT 'payment_method_correction'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_new  text := lower(btrim(coalesce(p_new_method, '')));
  v_exp  text := lower(btrim(p_expected_method));
  v_o    record;
  v_prev text;
  v_log  uuid;
  v_at   timestamptz;
BEGIN
  IF v_new NOT IN ('efectivo', 'tarjeta', 'bizum') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_method_required',
      'metodo_pago_recibido', nullif(v_new, ''), 'metodos_validos', jsonb_build_array('efectivo', 'tarjeta', 'bizum'));
  END IF;
  IF p_order_id IS NULL OR p_order_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_id');
  END IF;
  IF p_expected_method IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expected_method_required');
  END IF;

  SELECT id, estado, tipo_consegna, cobrado, metodo_pago
    INTO v_o
    FROM public.ordenes
   WHERE id = p_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_o.estado IS DISTINCT FROM 'RETIRADO' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_change_requires_retirado', 'estado_actual', v_o.estado);
  END IF;

  v_prev := lower(btrim(coalesce(v_o.metodo_pago, '')));

  -- Stesso metodo (doppio click, retry, seconda correzione identica): vero no-op, nessun audit.
  IF v_prev = v_new AND v_o.cobrado IS TRUE THEN
    RETURN jsonb_build_object('ok', true, 'noop', true, 'metodo_pago', v_new);
  END IF;
  -- Tab stale: l'operatore correggeva un metodo che non è più quello registrato.
  IF v_exp IS DISTINCT FROM v_prev THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_method_conflict',
      'metodo_pago_actual', nullif(v_prev, ''), 'metodo_pago_esperado', nullif(v_exp, ''));
  END IF;

  UPDATE public.ordenes
     SET metodo_pago = v_new,
         cobrado     = true,
         updated_at  = now()
   WHERE id = p_order_id;

  INSERT INTO public.orden_estado_logs
         (orden_id, numero_ordine, estado_from, estado_to, event_type, actor_type, actor_id, origin, metadata)
  VALUES (p_order_id, p_order_id, 'RETIRADO', 'RETIRADO', 'payment_method_changed',
          coalesce(nullif(p_actor_type, ''), 'unknown'), nullif(p_actor_id, ''), coalesce(nullif(p_origin, ''), 'unknown'),
          jsonb_build_object(
            'reason',           coalesce(nullif(p_reason, ''), 'payment_method_correction'),
            'tipo_consegna',    v_o.tipo_consegna,
            'metodo_pago_from', nullif(v_prev, ''),
            'metodo_pago_to',   v_new,
            'cobrado_before',   v_o.cobrado IS TRUE))
  RETURNING id, created_at INTO v_log, v_at;

  RETURN jsonb_build_object('ok', true, 'noop', false, 'metodo_pago', v_new,
    'metodo_pago_anterior', nullif(v_prev, ''), 'audit_id', v_log, 'audit_at', v_at);
END
$fn$;

COMMENT ON FUNCTION public.payment_method_change_v1(text, text, text, text, text, text, text) IS
  'PAYMENT-IDEMPOTENCY: correzione atomica del metodo di pagamento di un ordine RETIRADO. UPDATE ordenes + INSERT orden_estado_logs(payment_method_changed) nella stessa transazione; noop se stesso metodo; conflict se atteso ≠ corrente. Solo service_role.';

REVOKE ALL ON FUNCTION public.payment_method_change_v1(text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_method_change_v1(text, text, text, text, text, text, text) TO service_role;

DO $verify$
BEGIN
  IF to_regprocedure('public.payment_method_change_v1(text,text,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 verify failed: function missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.payment_method_change_v1(text,text,text,text,text,text,text)'::regprocedure AND prosecdef) THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 verify failed: function is SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.payment_method_change_v1(text,text,text,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.payment_method_change_v1(text,text,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.payment_method_change_v1(text,text,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 verify failed: grants are not least-privilege';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
