import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — declare mock fns inside the factory and expose via the module.
vi.mock('@/integrations/supabase/client', () => {
  const insertMock = vi.fn(() => ({
    then: (cb: (r: { error: null }) => void) => cb({ error: null }),
  }));
  const fromMock = vi.fn(() => ({ insert: insertMock }));
  return {
    supabase: { from: fromMock },
    __mocks: { insertMock, fromMock },
  };
});

import { logSearch } from '@/lib/analytics';
import * as supabaseModule from '@/integrations/supabase/client';

const { insertMock, fromMock } = (
  supabaseModule as unknown as { __mocks: { insertMock: ReturnType<typeof vi.fn>; fromMock: ReturnType<typeof vi.fn> } }
).__mocks;

describe('logSearch analytics', () => {
  beforeEach(() => {
    insertMock.mockClear();
    fromMock.mockClear();
  });

  it('inserts into search_logs with the correct payload', async () => {
    logSearch('test query', 5);
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
