import { createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
export function createAuthHttpServer(handler: (request: Request) => Promise<Response>) {
  const nodeHandler = toNodeHandler(handler);
  return createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'same-origin');
    // The server uses the explicitly configured auth origin. Forwarded host,
    // scheme and IP headers never establish authority or rate-limit identity.
    delete request.headers['x-forwarded-host'];
    delete request.headers['x-forwarded-proto'];
    delete request.headers['x-forwarded-for'];
    if (Number(request.headers['content-length'] ?? 0) > 16384) {
      response.writeHead(413).end();
      return;
    }
    void nodeHandler(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}
