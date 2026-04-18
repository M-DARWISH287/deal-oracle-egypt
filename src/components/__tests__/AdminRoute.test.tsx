import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { screen } from '@testing-library/dom';
import { MemoryRouter } from 'react-router-dom';

// Hoisted mock state
const mockState: { user: { id: string } | null; isAdminRow: boolean } = {
  user: null,
  isAdminRow: false,
};

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockState.user, loading: false }),
}));

vi.mock('@/integrations/supabase/client', () => {
  const maybeSingle = vi.fn(async () =>
    mockState.isAdminRow ? { data: { role: 'admin' }, error: null } : { data: null, error: null }
  );
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle,
  };
  return {
    supabase: {
      from: vi.fn(() => builder),
    },
  };
});

import { AdminRoute } from '@/components/AdminRoute';

function Protected() {
  return <div data-testid="admin-content">SECRET ADMIN AREA</div>;
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/admin/dashboard']}>
      <AdminRoute>
        <Protected />
      </AdminRoute>
    </MemoryRouter>
  );
}

describe('AdminRoute protection', () => {
  beforeEach(() => {
    mockState.user = null;
    mockState.isAdminRow = false;
  });

  it('hides admin content from unauthenticated users (renders 404 fallback)', async () => {
    renderRoute();
    await waitFor(() => {
      expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
    });
    expect(screen.getByText('404')).toBeInTheDocument();
  });

  it('hides admin content from authenticated non-admin users', async () => {
    mockState.user = { id: 'user-123' };
    mockState.isAdminRow = false;
    renderRoute();
    await waitFor(() => {
      expect(screen.getByText('404')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
  });

  it('renders admin content for users with the admin role', async () => {
    mockState.user = { id: 'admin-1' };
    mockState.isAdminRow = true;
    renderRoute();
    await waitFor(() => {
      expect(screen.getByTestId('admin-content')).toBeInTheDocument();
    });
    expect(screen.queryByText('404')).not.toBeInTheDocument();
  });
});
