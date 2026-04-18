import { supabase } from '@/integrations/supabase/client';

/**
 * Fire-and-forget search analytics logger.
 * Inserts into `search_logs`. Never throws — analytics must never break the UI.
 */
export function logSearch(query: string, resultsCount: number): void {
  const trimmed = query.trim();
  if (!trimmed) return;

  // Schedule after paint so the UI is never blocked.
  const fire = () => {
    supabase
      .from('search_logs')
      .insert({ query: trimmed, results_count: Math.max(0, Math.floor(resultsCount)) })
      .then(({ error }) => {
        if (error) {
          // Swallow — analytics failure must not surface to users.
          // eslint-disable-next-line no-console
          console.warn('[analytics] search log insert failed:', error.message);
        }
      });
  };

  if (typeof queueMicrotask === 'function') {
    queueMicrotask(fire);
  } else {
    setTimeout(fire, 0);
  }
}
