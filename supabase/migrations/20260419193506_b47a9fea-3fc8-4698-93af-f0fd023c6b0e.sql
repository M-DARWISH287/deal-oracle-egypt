-- Regression logs: one row per completed search request
CREATE TABLE public.regression_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  query TEXT NOT NULL,
  store TEXT,
  stage_used TEXT,
  latency_ms INTEGER,
  intent_accuracy SMALLINT,
  expansion_quality SMALLINT,
  retrieval_health SMALLINT,
  performance SMALLINT,
  overall_score SMALLINT,
  status TEXT NOT NULL,
  bottleneck TEXT,
  key_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_regression_logs_created_at ON public.regression_logs (created_at DESC);
CREATE INDEX idx_regression_logs_status ON public.regression_logs (status);
CREATE INDEX idx_regression_logs_store ON public.regression_logs (store);

ALTER TABLE public.regression_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can read regression logs (analytics surface)
CREATE POLICY "Admins can view regression logs"
ON public.regression_logs
FOR SELECT
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- No direct client INSERT/UPDATE/DELETE — edge function uses service role and bypasses RLS

-- Retention: scheduled cleanup of rows older than 30 days
CREATE OR REPLACE FUNCTION public.cleanup_regression_logs()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.regression_logs WHERE created_at < now() - INTERVAL '30 days';
$$;

-- Schedule daily cleanup at 03:00 UTC via pg_cron (extension is available in Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SELECT cron.schedule(
  'cleanup-regression-logs-daily',
  '0 3 * * *',
  $$ SELECT public.cleanup_regression_logs(); $$
);