import { createFileRoute } from '@tanstack/react-router';
import { getAuthRuntime } from '@/lib/runtime.server';
const handle = ({ request }: { request: Request }) => {
  const runtime = getAuthRuntime();
  if (new URL(request.url).pathname.startsWith('/api/systems/'))
    return runtime.systemsHandler(request);
  if (new URL(request.url).pathname.startsWith('/api/dokploy/'))
    return runtime.dokployHandler(request);
  if (new URL(request.url).pathname.startsWith('/api/docker/'))
    return runtime.dockerHandler(request);
  if (new URL(request.url).pathname.startsWith('/api/postgresql/'))
    return runtime.postgresHandler(request);
  if (/^\/api\/(agents|runtime)\//.test(new URL(request.url).pathname))
    return runtime.executionHandler(request);
  if (new URL(request.url).pathname.startsWith('/api/configuration/'))
    return runtime.configurationHandler(request);
  return new URL(request.url).pathname.startsWith('/api/console/')
    ? runtime.consoleHandler(request)
    : runtime.handler(request);
};
export const Route = createFileRoute('/api/$')({
  server: { handlers: { GET: handle, POST: handle } },
});
