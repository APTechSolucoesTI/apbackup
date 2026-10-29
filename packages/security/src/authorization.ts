import type { Role } from '@apbackup/contracts';
export type { Role } from '@apbackup/contracts';
export type Permission = 'read' | 'backup' | 'restore' | 'secrets' | 'configure';
export interface SessionPrincipal {
  userId: string;
  sessionId: string;
  organizationId: string;
  membershipId: string;
  role: Role;
  reauthenticatedAt: Date | null;
  mfaVerifiedAt: Date | null;
}
export class AccessError extends Error {
  constructor(
    public readonly status: 401 | 403 | 429,
    message = 'Acesso não autorizado.',
  ) {
    super(message);
  }
}
const permissions: Record<Role, readonly Permission[]> = {
  administrator: ['read', 'backup', 'restore', 'secrets', 'configure'],
  backup_operator: ['read', 'backup'],
  restore_operator: ['read', 'restore'],
  viewer: ['read'],
};
export function authorize(
  principal: SessionPrincipal,
  permission: Permission,
  resource: { organizationId: string },
): void {
  if (
    principal.organizationId !== resource.organizationId ||
    !permissions[principal.role].includes(permission)
  )
    throw new AccessError(403);
  if (['restore', 'secrets', 'configure'].includes(permission)) {
    const fresh = (date: Date | null) =>
      date !== null && Date.now() - date.getTime() <= 300_000 && date.getTime() <= Date.now();
    if (!fresh(principal.reauthenticatedAt) || !fresh(principal.mfaVerifiedAt))
      throw new AccessError(403, 'Confirme sua senha e segundo fator para continuar.');
  }
}
