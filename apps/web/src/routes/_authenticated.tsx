import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { loadConsoleSession } from '@/lib/session';
import { AppShell } from '@/components/app-shell';
import { DataState } from '@/components/data-state';
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async () => {
    const result = await loadConsoleSession();
    if (result.status === 'unauthenticated') throw redirect({ to: '/login' });
    return { identity: result };
  },
  component: Protected,
});
function Protected() {
  const { identity } = Route.useRouteContext();
  return identity.status === 'ok' ? (
    <AppShell session={identity.session}>
      <Outlet />
    </AppShell>
  ) : (
    <main className="standalone">
      <DataState
        state={identity.status === 'forbidden' ? 'forbidden' : 'error'}
        onRetry={() => window.location.reload()}
      />
      <a href="/login">Voltar ao acesso</a>
    </main>
  );
}
