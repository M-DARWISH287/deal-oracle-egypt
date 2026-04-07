
-- Create search cache table
CREATE TABLE public.search_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  query TEXT NOT NULL,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '1 hour')
);

-- Index for fast query lookup
CREATE INDEX idx_search_cache_query ON public.search_cache (query);
CREATE INDEX idx_search_cache_expires ON public.search_cache (expires_at);

-- Enable RLS
ALTER TABLE public.search_cache ENABLE ROW LEVEL SECURITY;

-- Anyone can read cache
CREATE POLICY "Anyone can read search cache"
  ON public.search_cache FOR SELECT
  USING (true);
