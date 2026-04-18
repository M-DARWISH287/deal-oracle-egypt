import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase client BEFORE importing the module under test.
const insertMock = vi.fn(() => ({
  then: (cb: (r: { error: null }) => void) => cb({ error: null }),
}));
const fromMock = vi.fn(() => ({ insert: insertMock }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

import { logSearch } from '@/lib/analytics';

describe('logSearch analytics', () => {
  beforeEach(() => {
    insertMock.mockClear();
    fromMock.mockClear();
  });

  it('inserts into search_logs with the correct payload', async () => {
    logSearch('test query', 5);
    // queueMicrotask schedules — flush
    await Promise.resolve();
    expect(fromMock).toHaveBeenCalledWith('search_logs');
    expect(insertMock).toHaveBeenCalledWith({
      query: 'test query',
      results_count: 5,
    });
  });

  it('trims whitespace and clamps negative counts to 0', async () => {
    logSearch('  iphone 15  ', -3);
    await Promise.resolve();
    expect(insertMock).toHaveBeenCalledWith({
      query: 'iphone 15',
      results_count: 0,
    });
  });

  it('does not insert for empty queries', async () => {
    logSearch('   ', 10);
    await Promise.resolve();
    expect(insertMock).not.toHaveBeenCalled();
  });
});
