import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { createDatabase, migrate } from '@apbackup/db';
import { createAuth } from '../../apps/web/src/lib/auth.server.js';
import { createSessionService } from '../../apps/web/src/lib/session.server.js';
import { bootstrapAdmin, recoverAccess } from '../../packages/security/src/administration.js';
import { createAuthApi } from '../../apps/web/src/lib/api.server.js';
import { createHmac } from 'node:crypto';
import { createAuthHttpServer } from '../../apps/web/src/http.server.js';

const testURL = process.env.TEST_DATABASE_URL;
if (
  !testURL ||
  !['127.0.0.1', '[::1]'].includes(new URL(testURL).hostname) ||
  !/^apbackup_test_[a-f0-9]+$/.test(new URL(testURL).pathname.slice(1))
)
  throw new Error('Disposable loopback PostgreSQL required');
const db = createDatabase(testURL);
const baseURL = 'http://localhost:4311';
const password = randomBytes(24).toString('base64url');
const email = `admin-${randomUUID()}@example.test`;
let auth: ReturnType<typeof createAuth>;
let sessions: ReturnType<typeof createSessionService>;
let organizationId: string;
let userId: string;
let cookie = '';
function capture(response: Response) {
  if (response.headers.getSetCookie().length)
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
}
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase()]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0'))
    .join('');
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
function request(path: string, body?: unknown, currentCookie = cookie, origin = baseURL) {
  return new Request(`${baseURL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      cookie: currentCookie,
      'x-organization-id': organizationId ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  await migrate(db);
  auth = createAuth({ db, baseURL, secret: randomBytes(48).toString('base64url') });
  sessions = createSessionService(auth, db);
  const admin = await bootstrapAdmin(db, {
    email,
    password,
    name: 'Local administrator',
    organizationName: `Organization ${randomUUID()}`,
  });
  organizationId = admin.organizationId;
  userId = admin.userId;
});
afterAll(() => db.close());
test('bootstrap is idempotent without changing existing credentials; public registration is disabled', async () => {
  const result = await bootstrapAdmin(db, {
    email,
    password: randomBytes(24).toString('base64url'),
    name: 'Ignored',
    organizationName: 'Ignored',
  });
  expect(result.userId).toBe(userId);
  expect(result.organizationId).toBe(organizationId);
  const registration = await auth.handler(
    request(
      '/api/auth/sign-up/email',
      { email: 'intruder@example.test', password, name: 'Intruder' },
      '',
    ),
  );
  expect(registration.status).toBe(400);
});
test('requires a real session and rejects credentials from an untrusted origin', async () => {
  await expect(
    sessions.requireSession(request('/api/session', undefined, '')),
  ).rejects.toMatchObject({ status: 401 });
  expect(
    (
      await auth.handler(
        request('/api/auth/sign-in/email', { email, password }, '', 'https://evil.example'),
      )
    ).status,
  ).toBe(403);
});
test('logs in with HttpOnly cookies and loads same-org membership from PostgreSQL', async () => {
  const response = await auth.handler(request('/api/auth/sign-in/email', { email, password }, ''));
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const principal = await sessions.requireSession(request('/api/session'));
  expect(principal).toMatchObject({
    userId,
    organizationId,
    role: 'administrator',
    reauthenticatedAt: null,
  });
  await expect(
    sessions.requireSession(
      new Request(`${baseURL}/api/session`, {
        headers: { cookie, 'x-organization-id': randomUUID() },
      }),
    ),
  ).rejects.toMatchObject({ status: 403 });
});
test('revoked membership invalidates access immediately while preserving history', async () => {
  await db.pool.query('update organization_memberships set revoked_at=now() where user_id=$1', [
    userId,
  ]);
  await expect(sessions.requireSession(request('/api/session'))).rejects.toMatchObject({
    status: 403,
  });
  expect(
    (await db.pool.query('select id from organization_memberships where user_id=$1', [userId]))
      .rowCount,
  ).toBe(1);
  await db.pool.query('update organization_memberships set revoked_at=null where user_id=$1', [
    userId,
  ]);
});
test('requires verified TOTP enrollment and password plus MFA reauthentication for sensitive HTTP operations', async () => {
  const api = createAuthApi(auth, db);
  expect((await api(request('/api/permissions/restore'))).status).toBe(403);
  const enable = await api(request('/api/auth/two-factor/enable', { password }));
  expect(enable.status).toBe(200);
  const enrollment = (await enable.json()) as { totpURI: string; backupCodes: string[] };
  expect(enrollment.backupCodes).toHaveLength(10);
  expect(
    (await db.pool.query('select two_factor_enabled from users where id=$1', [userId])).rows[0]
      ?.two_factor_enabled,
  ).toBe(false);
  const factor = (
    await db.pool.query('select secret,backup_codes from auth_two_factors where user_id=$1', [
      userId,
    ])
  ).rows[0] as { secret: string; backup_codes: string };
  const secret = new URL(enrollment.totpURI).searchParams.get('secret')!;
  expect(factor.secret).not.toContain(secret);
  expect(factor.backup_codes).not.toContain(enrollment.backupCodes[0]);
  expect(
    (await api(request('/api/auth/two-factor/verify-totp', { code: 'bad-code' }))).status,
  ).toBe(401);
  const verification = await api(
    request('/api/auth/two-factor/verify-totp', { code: totp(secret) }),
  );
  expect(verification.status).toBe(200);
  capture(verification);
  expect((await api(request('/api/permissions/restore'))).status).toBe(403);
  expect(
    (await api(request('/api/reauthenticate', { password: 'wrong-password', code: totp(secret) })))
      .status,
  ).toBe(403);
  expect((await api(request('/api/reauthenticate', { password, code: 'bad-code' }))).status).toBe(
    403,
  );
  const proof = await api(request('/api/reauthenticate', { password, code: totp(secret) }));
  expect(proof.status).toBe(200);
  capture(proof);
  expect((await api(request('/api/permissions/restore'))).status).toBe(200);
  await db.pool.query('update users set two_factor_enabled=false where id=$1', [userId]);
  expect((await api(request('/api/permissions/restore'))).status).toBe(403);
  await db.pool.query('update users set two_factor_enabled=true where id=$1', [userId]);
  await db.pool.query(
    "update auth_sessions set reauthenticated_at=now()-interval '301 seconds' where user_id=$1",
    [userId],
  );
  // Simulate the matching cooldown; server-side MFA checks now share the same
  // authoritative verification budget as public factor-verification routes.
  await db.pool.query('update auth_rate_limits set last_request=0');
  expect((await api(request('/api/permissions/restore'))).status).toBe(403);
  expect(
    (
      await api(
        request('/api/reauthenticate', { password, recoveryCode: enrollment.backupCodes[0] }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await api(
        request('/api/reauthenticate', { password, recoveryCode: enrollment.backupCodes[0] }),
      )
    ).status,
  ).toBe(403);
  // Local recovery clears MFA and sessions so the subsequent login test remains independent of the authenticator.
  const challenged = await api(request('/api/auth/sign-in/email', { email, password }, ''));
  expect(challenged.status).toBe(200);
  expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
  capture(challenged);
  await expect(sessions.requireSession(request('/api/session'))).rejects.toMatchObject({
    status: 401,
  });
  const completed = await api(request('/api/auth/two-factor/verify-totp', { code: totp(secret) }));
  expect(completed.status).toBe(200);
  capture(completed);
  expect(await sessions.requireSession(request('/api/session'))).toMatchObject({
    userId,
    reauthenticatedAt: null,
  });
  expect((await api(request('/api/auth/two-factor/disable', { password }))).status).toBe(403);
  expect(
    (await api(request('/api/auth/two-factor/generate-backup-codes', { password }))).status,
  ).toBe(403);
  await recoverAccess(db, { email, password });
  const login = await api(request('/api/auth/sign-in/email', { email, password }, ''));
  capture(login);
});
test('uses secure production cookies and applies server-side rate limiting', async () => {
  const production = createAuth({
    db,
    baseURL: 'https://backup.example.test',
    secret: randomBytes(48).toString('base64url'),
    production: true,
  });
  const response = await production.handler(
    new Request('https://backup.example.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'https://backup.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('Secure');
  let status = 0;
  for (let attempt = 0; attempt < 7; attempt++)
    status = (
      await production.handler(
        new Request('https://backup.example.test/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            origin: 'https://backup.example.test',
            'content-type': 'application/json',
            'x-forwarded-for': 'spoofed',
          },
          body: JSON.stringify({ email, password: 'wrong-password' }),
        }),
      )
    ).status;
  expect(status).toBe(429);
});
test('serves authenticated HTTP and enforces live roles, tenant boundaries and server revocation', async () => {
  const server = createAuthHttpServer(createAuthApi(auth, db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { cookie, 'x-organization-id': organizationId };
  try {
    expect((await fetch(`${url}/api/session`)).status).toBe(401);
    expect((await fetch(`${url}/api/session`, { headers })).status).toBe(200);
    await db.pool.query("update organization_memberships set role='viewer' where user_id=$1", [
      userId,
    ]);
    expect((await fetch(`${url}/api/permissions/backup`, { headers })).status).toBe(403);
    await db.pool.query(
      "update organization_memberships set role='backup_operator' where user_id=$1",
      [userId],
    );
    expect((await fetch(`${url}/api/permissions/backup`, { headers })).status).toBe(200);
    expect((await fetch(`${url}/api/permissions/restore`, { headers })).status).toBe(403);
    expect(
      (
        await fetch(`${url}/api/session`, {
          headers: { ...headers, 'x-organization-id': randomUUID() },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/session`, {
          headers: { ...headers, 'x-organization-id': 'invalid' },
        })
      ).status,
    ).toBe(400);
    await db.pool.query('delete from auth_sessions where user_id=$1', [userId]);
    expect((await fetch(`${url}/api/session`, { headers })).status).toBe(401);
  } finally {
    await db.pool.query(
      "update organization_memberships set role='administrator' where user_id=$1",
      [userId],
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const login = await auth.handler(request('/api/auth/sign-in/email', { email, password }, ''));
    capture(login);
  }
});
test('logout revokes the cookie server-side and local recovery invalidates all sessions', async () => {
  expect((await auth.handler(request('/api/auth/sign-out', {}))).status).toBe(200);
  await expect(sessions.requireSession(request('/api/session'))).rejects.toMatchObject({
    status: 401,
  });
  const response = await auth.handler(request('/api/auth/sign-in/email', { email, password }, ''));
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  await recoverAccess(db, { email, password: randomBytes(24).toString('base64url') });
  await expect(sessions.requireSession(request('/api/session'))).rejects.toMatchObject({
    status: 401,
  });
});
