import { createServerFn } from '@tanstack/react-start';
import { sessionSchema } from './client-api';
export const loadConsoleSession = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ getRequest }, { getAuthRuntime }] = await Promise.all([
    import('@tanstack/react-start/server'),
    import('./runtime.server'),
  ]);
  const request = getRequest();
  const response = await getAuthRuntime().consoleHandler(
    new Request(new URL('/api/console/session', request.url), { headers: request.headers }),
  );
  if (response.status === 401) return { status: 'unauthenticated' as const };
  if (response.status === 403) return { status: 'forbidden' as const };
  if (!response.ok) return { status: 'error' as const };
  return { status: 'ok' as const, session: sessionSchema.parse(await response.json()) };
});
