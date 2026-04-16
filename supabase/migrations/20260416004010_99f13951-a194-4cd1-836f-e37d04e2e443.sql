
-- Delete duplicate cache entries, keep only the latest per query
DELETE FROM public.search_cache a
USING public.search_cache b
WHERE a.query = b.query
  AND a.created_at < b.created_at;

-- Now add the unique constraint
ALTER TABLE public.search_cache ADD CONSTRAINT search_cache_query_unique UNIQUE (query);
