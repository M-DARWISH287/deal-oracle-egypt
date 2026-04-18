DROP POLICY IF EXISTS "Anyone can insert search logs" ON public.search_logs;

CREATE POLICY "Authenticated users can insert search logs"
  ON public.search_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);