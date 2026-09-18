
CREATE TABLE public.fixture_ledger_control (singleton boolean PRIMARY KEY DEFAULT true, mode text NOT NULL DEFAULT 'ok');
INSERT INTO public.fixture_ledger_control (singleton, mode) VALUES (true, 'ok');

CREATE FUNCTION public._ledger_write_payment(
  p_order_id text, p_method text, p_amount numeric, p_actor text, p_role text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_mode text;
  v_id   bigint;
BEGIN
  SELECT mode INTO v_mode FROM public.fixture_ledger_control WHERE singleton = true;
  IF v_mode = 'refuse' THEN
    RAISE EXCEPTION 'PAYMENT_DIGEST_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'legacy' THEN
    RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.order_financial_events (order_id, kind, amount)
  VALUES (p_order_id, 'payment_' || p_method, 10)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('event_id', v_id, 'method', p_method, 'actor', p_actor, 'role', p_role,
                            'idem_scope_key', p_idem_scope_key);
END;
$function$;
