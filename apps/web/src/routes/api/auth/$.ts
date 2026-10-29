import { getAuthRuntime } from '../../../lib/runtime.server.js';
import { createFileRoute } from '@tanstack/react-router';
export const GET = ({ request }: { request: Request }) => getAuthRuntime().auth.handler(request);
export const POST = GET;
export const Route = createFileRoute('/api/auth/$')({ server: { handlers: { GET, POST } } });
