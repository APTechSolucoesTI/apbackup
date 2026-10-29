import type { PlatformDatabase } from '@apbackup/db';
import type { PlatformAuth } from './auth.server.js';
import { z } from 'zod';
import { createSessionService } from './session.server.js';
import { AccessError, authorize } from '../../../../packages/security/src/authorization.js';
import { consumeRateLimit } from '../../../../packages/security/src/rate-limit.js';
const reauthentication = z
  .object({
    password: z.string().min(1).max(128),
    code: z.string().min(1).max(16).optional(),
    recoveryCode: z.string().min(1).max(32).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode));
const permission = z.enum(['read', 'backup', 'restore', 'secrets', 'configure']);
export function createAuthApi(auth: PlatformAuth, db: PlatformDatabase) {
  const sessions = createSessionService(auth, db);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    try {
      if (path.startsWith('/api/auth/')) return await auth.handler(request);
      if (
        request.method === 'POST' &&
        request.headers.get('origin') !== new URL(auth.options.baseURL as string).origin
      )
        throw new AccessError(403);
      const principal = await sessions.requireSession(request);
      if (path === '/api/session' && request.method === 'GET')
        return Response.json(principal, { headers: { 'cache-control': 'no-store' } });
      if (path.startsWith('/api/permissions/') && request.method === 'GET') {
        authorize(principal, permission.parse(path.slice('/api/permissions/'.length)), {
          organizationId: principal.organizationId,
        });
        return Response.json({ allowed: true }, { headers: { 'cache-control': 'no-store' } });
      }
      if (path === '/api/reauthenticate' && request.method === 'POST') {
        if (!(await consumeRateLimit(db, `reauth:${principal.userId}`, 5)))
          throw new AccessError(429, 'Muitas tentativas. Aguarde um minuto.');
        const body = reauthentication.parse(await request.json());
        // Verify both factors against the authoritative session. Never accept a
        // timestamp, role, user ID or organization supplied by a caller as proof.
        const mfa = (
          await db.pool.query<{ two_factor_enabled: boolean }>(
            'select two_factor_enabled from users where id=$1',
            [principal.userId],
          )
        ).rows[0];
        if (!mfa?.two_factor_enabled)
          throw new AccessError(403, 'Configure seu segundo fator antes de continuar.');
        try {
          await auth.api.verifyPassword({
            headers: request.headers,
            body: { password: body.password },
          });
          if (body.code)
            await auth.api.verifyTOTP({ headers: request.headers, body: { code: body.code } });
          else
            await auth.api.verifyBackupCode({
              headers: request.headers,
              body: { code: body.recoveryCode!, disableSession: true },
            });
        } catch {
          throw new AccessError(403, 'Senha ou segundo fator inválido.');
        }
        const updated = await db.pool.query(
          'update auth_sessions set reauthenticated_at=now(),mfa_verified_at=now() where id=$1 and expires_at>now() returning id',
          [principal.sessionId],
        );
        if (!updated.rowCount) throw new AccessError(401);
        return Response.json(
          { verified: true, validForSeconds: 300 },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      return Response.json({ error: 'Página não encontrada.' }, { status: 404 });
    } catch (error) {
      if (error instanceof AccessError)
        return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json({ error: 'Verifique os dados informados.' }, { status: 400 });
      console.error('A operação de autenticação falhou.');
      return Response.json(
        { error: 'Não foi possível concluir. Tente novamente.' },
        { status: 500 },
      );
    }
  };
}
