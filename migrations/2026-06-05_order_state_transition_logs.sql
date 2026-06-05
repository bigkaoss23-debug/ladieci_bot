-- ORDER-STATE-TRANSITION-LOGS-40
-- Migration preparata per tracciare il ciclo di vita degli ordini.
-- NON applicata automaticamente da Codex.

ALTER TABLE public.ordenes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmado_at timestamptz,
  ADD COLUMN IF NOT EXISTS en_cocina_at timestamptz,
  ADD COLUMN IF NOT EXISTS listo_at timestamptz,
  ADD COLUMN IF NOT EXISTS en_entrega_at timestamptz,
  ADD COLUMN IF NOT EXISTS retirado_at timestamptz,
  ADD COLUMN IF NOT EXISTS completado_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelado_at timestamptz;

CREATE TABLE IF NOT EXISTS public.orden_estado_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_id text NOT NULL,
  numero_ordine text,
  estado_from text,
  estado_to text NOT NULL,
  event_type text NOT NULL,
  actor_type text,
  actor_id text,
  origin text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_orden_estado_logs_orden_id
  ON public.orden_estado_logs (orden_id);

CREATE INDEX IF NOT EXISTS idx_orden_estado_logs_created_at
  ON public.orden_estado_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orden_estado_logs_estado_to
  ON public.orden_estado_logs (estado_to);

COMMENT ON TABLE public.orden_estado_logs IS
  'Append-only non-PII audit log for order state transitions.';
COMMENT ON COLUMN public.orden_estado_logs.metadata IS
  'Non-PII operational metadata only. Do not store names, phones, addresses, notes, chat text, or items.';

-- RLS: nessuna policy anon aggiunta qui. La tabella e' pensata per scritture backend/API
-- e letture operative controllate, seguendo lo stile delle migration manual_giros.
