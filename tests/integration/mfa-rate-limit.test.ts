import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createDatabase, migrate } from '@apbackup/db';
import { createAuth } from '../../apps/web/src/lib/auth.server.js';
import { createAuthHttpServer } from '../../apps/web/src/http.server.js';
import { bootstrapAdmin } from '../../packages/security/src/administration.js';

const databaseURL = process.env.TEST_DATABASE_URL;
if (
  !databaseURL ||
  new URL(databaseURL).hostname !== '127.0.0.1' ||
  !/^apbackup_test_[a-f0-9]+$/.test(new URL(databaseURL).pathname.slice(1))
)
  throw new Error('Disposable loopback PostgreSQL required');
const db = createDatabase(databaseURL);
const origin = 'http://localhost:4311';
let auth: ReturnType<typeof createAuth>;
let server: ReturnType<typeof createAuthHttpServer>;
let url: string;
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
function post(path: string, body: unknown, cookie = '') {
  return fetch(`${url}/api/auth/${path}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      cookie,
      'x-forwarded-for': randomUUID(),
    },
    body: JSON.stringify(body),
  });
}
async function enrolledUser() {
  const email = `mfa-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString('base64url');
  await bootstrapAdmin(db, {
    email,
    password,
    name: 'MFA limit test',
    organizationName: randomUUID(),
  });
  const login = await post('sign-in/email', { email, password });
  expect(login.status).toBe(200);
  let cookie = cookies(login);
  const enable = await post('two-factor/enable', { password }, cookie);
  expect(enable.status).toBe(200);
  const enrollment = (await enable.json()) as { totpURI: string; backupCodes: string[] };
  const secret = new URL(enrollment.totpURI).searchParams.get('secret')!;
  const verify = await post('two-factor/verify-totp', { code: totp(secret) }, cookie);
  expect(verify.status).toBe(200);
  cookie = cookies(verify) || cookie;
  return { email, password, cookie, secret, backupCodes: enrollment.backupCodes };
}
beforeAll(async () => {
  await migrate(db);
  auth = createAuth({ db, baseURL: origin, secret: randomBytes(48).toString('base64url') });
  server = createAuthHttpServer(auth.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await db.close();
});
beforeEach(async () => {
  // Advance the limiter window between isolated scenarios without delaying tests.
  await db.pool.query('update auth_rate_limits set last_request=0');
});

test('extraneous email and forwarded identity cannot split an authenticated MFA budget', async () => {
  const user = await enrolledUser();
  // Enrollment used the first of five verification attempts in this minute.
  for (let attempt = 0; attempt < 4; attempt++)
    expect(
      (
        await post(
          'two-factor/verify-totp',
          { code: 'invalid', email: `${randomUUID()}@example.test` },
          user.cookie,
        )
      ).status,
    ).toBe(401);
  expect(
    (
      await post(
        'two-factor/verify-totp',
        { code: totp(user.secret), email: `${randomUUID()}@example.test` },
        user.cookie,
      )
    ).status,
  ).toBe(429);
  expect(
    (await post('two-factor/verify-backup-code', { code: user.backupCodes[0] }, user.cookie))
      .status,
  ).toBe(429);
});

test('a verified login challenge uses the same user budget despite extraneous email changes', async () => {
  const user = await enrolledUser();
  const login = await post('sign-in/email', { email: user.email, password: user.password });
  expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
  const challengeCookie = cookies(login);
  for (let attempt = 0; attempt < 4; attempt++)
    expect(
      (
        await post(
          'two-factor/verify-totp',
          { code: 'invalid', email: `${randomUUID()}@example.test` },
          challengeCookie,
        )
      ).status,
    ).toBe(401);
  expect(
    (
      await post(
        'two-factor/verify-totp',
        { code: totp(user.secret), email: `${randomUUID()}@example.test` },
        challengeCookie,
      )
    ).status,
  ).toBe(429);
  expect(
    (await post('two-factor/verify-totp', { code: totp(user.secret) }, user.cookie)).status,
  ).toBe(429);
});

test('anonymous exhaustion cannot deny an unrelated legitimate session or signed login challenge', async () => {
  const sessionUser = await enrolledUser();
  const challengeUser = await enrolledUser();
  const login = await post('sign-in/email', {
    email: challengeUser.email,
    password: challengeUser.password,
  });
  expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
  let anonymousStatus = 0;
  for (let attempt = 0; attempt < 6; attempt++)
    anonymousStatus = (await post('two-factor/verify-totp', { code: 'invalid' })).status;
  expect(anonymousStatus).toBe(429);
  expect(
    (await post('two-factor/verify-totp', { code: totp(sessionUser.secret) }, sessionUser.cookie))
      .status,
  ).toBe(200);
  expect(
    (await post('two-factor/verify-totp', { code: totp(challengeUser.secret) }, cookies(login)))
      .status,
  ).toBe(200);
});

test('independent legitimate users keep separate MFA budgets', async () => {
  const first = await enrolledUser();
  const second = await enrolledUser();
  for (let attempt = 0; attempt < 4; attempt++)
    expect((await post('two-factor/verify-totp', { code: 'invalid' }, first.cookie)).status).toBe(
      401,
    );
  expect(
    (await post('two-factor/verify-totp', { code: totp(first.secret) }, first.cookie)).status,
  ).toBe(429);
  expect(
    (await post('two-factor/verify-totp', { code: totp(second.secret) }, second.cookie)).status,
  ).toBe(200);
});

test('forged, expired and consumed challenge cookies cannot charge a legitimate user budget', async () => {
  const user = await enrolledUser();
  const login = await post('sign-in/email', { email: user.email, password: user.password });
  const challengeCookie = cookies(login);
  const challenge = (
    await db.pool.query<{ identifier: string }>(
      "select identifier from auth_verifications where value=(select id::text from users where email=$1) and identifier like '2fa-%'",
      [user.email],
    )
  ).rows[0]!;
  const forgedCookie = challengeCookie.replace(
    /(two_factor=)[^;]+/,
    `$1${encodeURIComponent(`${challenge.identifier}.forged`)}`,
  );
  expect(forgedCookie).not.toBe(challengeCookie);
  for (let attempt = 0; attempt < 6; attempt++)
    expect(
      (await post('two-factor/verify-totp', { code: 'invalid', email: user.email }, forgedCookie))
        .status,
    ).not.toBe(200);
  expect(
    (await post('two-factor/verify-totp', { code: totp(user.secret) }, user.cookie)).status,
  ).toBe(200);
  await db.pool.query(
    "update auth_verifications set expires_at=now()-interval '1 second' where identifier=$1",
    [challenge.identifier],
  );
  for (let attempt = 0; attempt < 6; attempt++)
    expect(
      (await post('two-factor/verify-totp', { code: totp(user.secret) }, challengeCookie)).status,
    ).not.toBe(200);
  expect(
    (await post('two-factor/verify-totp', { code: totp(user.secret) }, user.cookie)).status,
  ).toBe(200);
  const fresh = await post('sign-in/email', { email: user.email, password: user.password });
  expect(
    (await post('two-factor/verify-totp', { code: totp(user.secret) }, cookies(fresh))).status,
  ).toBe(200);
  for (let attempt = 0; attempt < 6; attempt++)
    expect(
      (await post('two-factor/verify-totp', { code: totp(user.secret) }, cookies(fresh))).status,
    ).not.toBe(200);
  expect(
    (await post('two-factor/verify-totp', { code: totp(user.secret) }, user.cookie)).status,
  ).toBe(200);
});
