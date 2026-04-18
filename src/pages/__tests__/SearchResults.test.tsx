import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/dom';
import { MemoryRouter } from 'react-router-dom';
import SearchResults from '@/pages/SearchResults';

// Mock language
vi.mock('@/i18n/LanguageContext', () => ({
  useLanguage: () => ({
    lang: 'ar',
    t: (k: string) => k,
  }),
}));

// Mock auth — no user
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

// Mock region (used by RegionSwitcher)
vi.mock('@/i18n/RegionContext', () => ({
  useRegion: () => ({ region: 'EG', setRegion: () => {} }),
}));

// Mock api: searchStore resolves with 0 products so we hit the empty state
vi.mock('@/lib/api', async () => {
  return {
    searchStore: vi.fn(async () => ({ success: true, products: [], cached: false })),
    groupProducts: (raws: unknown[]) => raws,
    clientFilterWithFallback: () => ({ strict: [], relaxed: [] }),
    getRelevantStores: () => ['Amazon Egypt', 'Noon'],
  };
});

describe('SearchResults empty state', () => {
  it('renders the elegant empty state when no products are returned', async () => {
    render(
      <MemoryRouter initialEntries={['/search?q=zzz-no-match']}>
        <SearchResults />
      </MemoryRouter>,
    );

    // Wait for async store searches to settle
    const empty = await screen.findByTestId('empty-state', {}, { timeout: 3000 });
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/لم نتمكن من العثور على عروض/);
  });
});
