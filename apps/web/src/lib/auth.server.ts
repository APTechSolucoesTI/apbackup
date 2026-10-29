import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import type { PlatformDatabase } from '@apbackup/db';
import { redact } from '../../../../packages/security/src/redaction.js';
import { consumeRateLimit } from '../../../../packages/security/src/rate-limit.js';

export interface AuthConfiguration {
  db: PlatformDatabase;
  baseURL: string;
  secret: string;
  production?: boolean;
}
export function createAuth(config: AuthConfiguration) {
  const origin = new URL(config.baseURL).origin;
  if (config.secret.length < 32)
    throw new Error('Authentication secret must have at least 32 characters');
  if (config.production && !origin.startsWith('https://'))
    throw new Error('HTTPS is required in production');
  const auth = betterAuth({
    appName: 'APBackup',
    baseURL: origin,
    secret: config.secret,
    database: config.db.pool,
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    user: {
      modelName: 'users',
      fields: { createdAt: 'created_at', updatedAt: 'updated_at', emailVerified: 'email_verified' },
    },
    session: {
      modelName: 'auth_sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
      cookieCache: { enabled: false },
      freshAge: 300,
      expiresIn: 28800,
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'auth_verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: config.production ?? process.env.NODE_ENV === 'production',
      ipAddress: { disableIpTracking: true },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      modelName: 'auth_rate_limits',
      fields: { lastRequest: 'last_request' },
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 5 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.path.startsWith('/two-factor/')) return;
        const session = await getAuthoritativeSessionFromCtx(ctx);
        let userId = session?.user.id;
        if (!userId) {
          // Use Better Auth's signature verifier and cookie configuration. A raw
          // cookie, an email, or a forwarded address never establishes identity.
          const cookie = ctx.context.createAuthCookie('two_factor');
          const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          if (identifier && identifier.startsWith('2fa-')) {
            const challenge = await ctx.context.internalAdapter.findVerificationValue(identifier);
            if (challenge && challenge.expiresAt > new Date()) {
              const user = await ctx.context.internalAdapter.findUserById(challenge.value);
              userId = user?.id;
            }
          }
        }
        // All factor verification routes share the user's budget, including
        // different sessions/challenges and server-side reauthentication calls.
        // Invalid anonymous traffic has a separate budget and cannot deny users.
        const action = ctx.path.startsWith('/two-factor/verify-') ? 'verify' : ctx.path;
        const subject = userId ? `user:${userId}:${action}` : 'invalid-challenge';
        if (!(await consumeRateLimit(config.db, `${origin}:mfa:${subject}`, 5)))
          throw new APIError(
            'TOO_MANY_REQUESTS',
            {
              message: 'Muitas tentativas. Aguarde um minuto.',
            },
            { 'retry-after': '60' },
          );
        if (!userId) throw new APIError('UNAUTHORIZED', { message: 'Entre para continuar.' });
      }),
    },
    plugins: [
      twoFactor({
        issuer: 'APBackup',
        backupCodeOptions: { storeBackupCodes: 'encrypted' },
        schema: {
          user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
          twoFactor: {
            modelName: 'auth_two_factors',
            fields: {
              userId: 'user_id',
              backupCodes: 'backup_codes',
              failedVerificationCount: 'failed_verification_count',
              lockedUntil: 'locked_until',
            },
          },
        },
      }),
    ],
    onAPIError: {
      onError: (error) => {
        if (!(
          error &&
          typeof error === 'object' &&
          'statusCode' in error &&
          typeof error.statusCode === 'number' &&
          error.statusCode < 500
        ))
          console.error(JSON.stringify(redact({ event: 'auth.error', error })));
      },
    },
    logger: {
      level: 'error',
      log: (level, message, ...args) => {
        if (level === 'error') console.error(JSON.stringify(redact({ level, message, args })));
      },
    },
  });
  return {
    ...auth,
    handler: async (request: Request) => {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== origin)
        return Response.json({ error: 'Origem não autorizada.' }, { status: 403 });
      if (request.method === 'POST') {
        const path = new URL(request.url).pathname;
        const personalSecurityActions = [
          '/api/auth/two-factor/disable',
          '/api/auth/two-factor/generate-backup-codes',
          '/api/auth/two-factor/get-totp-uri',
          '/api/auth/change-password',
          '/api/auth/change-email',
          '/api/auth/delete-user',
        ];
        if (personalSecurityActions.includes(path)) {
          const session = await auth.api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
          });
          if (!session) return Response.json({ error: 'Entre para continuar.' }, { status: 401 });
          const proof = await config.db.pool.query(
            `select s.id from auth_sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>now() and u.two_factor_enabled and s.reauthenticated_at between now()-interval '5 minutes' and now() and s.mfa_verified_at between now()-interval '5 minutes' and now()`,
            [session.session.id],
          );
          if (!proof.rowCount)
            return Response.json(
              { error: 'Confirme sua senha e segundo fator para continuar.' },
              { status: 403 },
            );
        }
        if (path.includes('/sign-in/')) {
          const body: unknown = await request
            .clone()
            .json()
            .catch(() => null);
          const subject =
            body && typeof body === 'object' && 'email' in body && typeof body.email === 'string'
              ? body.email.trim().toLowerCase()
              : 'global';
          if (!(await consumeRateLimit(config.db, `${origin}:${path}:${subject}`, 5)))
            return Response.json(
              { error: 'Muitas tentativas. Aguarde um minuto.' },
              { status: 429, headers: { 'retry-after': '60' } },
            );
        }
      }
      return auth.handler(request);
    },
  };
}
export type PlatformAuth = ReturnType<typeof createAuth>;
