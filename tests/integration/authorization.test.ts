import { test, expect } from 'vitest';
import { authorize, type SessionPrincipal } from '../../packages/security/src/authorization.js';

const principal: SessionPrincipal = {
  userId: 'user',
  sessionId: 'session',
  organizationId: 'org',
  membershipId: 'membership',
  role: 'viewer',
  reauthenticatedAt: new Date(),
  mfaVerifiedAt: new Date(),
};
test('denies viewer backup, operator restore and every cross-organization request', () => {
  expect(() => authorize(principal, 'read', { organizationId: 'org' })).not.toThrow();
  expect(() => authorize(principal, 'backup', { organizationId: 'org' })).toThrowError(
    expect.objectContaining({ status: 403 }),
  );
  expect(() =>
    authorize({ ...principal, role: 'backup_operator' }, 'restore', { organizationId: 'org' }),
  ).toThrowError(expect.objectContaining({ status: 403 }));
  expect(() =>
    authorize({ ...principal, role: 'administrator' }, 'read', { organizationId: 'other' }),
  ).toThrowError(expect.objectContaining({ status: 403 }));
});
test('requires recent password and MFA proof within five minutes for sensitive actions', () => {
  const admin = { ...principal, role: 'administrator' as const };
  expect(() => authorize(admin, 'restore', { organizationId: 'org' })).not.toThrow();
  expect(() =>
    authorize({ ...admin, reauthenticatedAt: new Date(Date.now() - 301000) }, 'restore', {
      organizationId: 'org',
    }),
  ).toThrowError(expect.objectContaining({ status: 403 }));
  expect(() =>
    authorize({ ...admin, mfaVerifiedAt: null }, 'secrets', { organizationId: 'org' }),
  ).toThrowError(expect.objectContaining({ status: 403 }));
});
