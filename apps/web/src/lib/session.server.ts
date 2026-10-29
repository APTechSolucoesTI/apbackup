import type { PlatformDatabase } from '@apbackup/db';
import type { PlatformAuth } from './auth.server.js';
import {
  AccessError,
  type Role,
  type SessionPrincipal,
} from '../../../../packages/security/src/authorization.js';
import { z } from 'zod';

export async function requireSession(request: Request): Promise<SessionPrincipal> {
  const { getAuthRuntime } = await import('./runtime.server.js');
  return getAuthRuntime().sessions.requireSession(request);
}

export function createSessionService(auth: PlatformAuth, db: PlatformDatabase) {
  return {
    async requireSession(request: Request): Promise<SessionPrincipal> {
      const session = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true },
      });
      if (!session) throw new AccessError(401, 'Entre para continuar.');
      const organizationId = request.headers.get('x-organization-id');
      if (organizationId) z.uuid().parse(organizationId);
      const result = await db.pool.query<{
        id: string;
        organization_id: string;
        role: Role;
        reauthenticated_at: Date | null;
        mfa_verified_at: Date | null;
      }>(
        `select m.id,m.organization_id,m.role,s.reauthenticated_at,case when u.two_factor_enabled then s.mfa_verified_at else null end as mfa_verified_at from organization_memberships m join auth_sessions s on s.user_id=m.user_id join users u on u.id=m.user_id where s.id=$1 and s.expires_at>now() and m.revoked_at is null and ($2::uuid is null or m.organization_id=$2::uuid) order by m.created_at,m.id limit 1`,
        [session.session.id, organizationId || null],
      );
      const membership = result.rows[0];
      if (!membership) throw new AccessError(403);
      return {
        userId: session.user.id,
        sessionId: session.session.id,
        organizationId: membership.organization_id,
        membershipId: membership.id,
        role: membership.role,
        reauthenticatedAt: membership.reauthenticated_at,
        mfaVerifiedAt: membership.mfa_verified_at,
      };
    },
  };
}
