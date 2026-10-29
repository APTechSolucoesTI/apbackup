import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createDatabase, migrate } from '@apbackup/db';
import { createAuth } from '../../apps/web/src/lib/auth.server.js';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== '127.0.0.1' ||
  !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1))
)
  throw new Error('Disposable loopback database required');
const databaseURL = url;
function run(input: unknown, recover = false) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../../scripts/bootstrap-admin.ts', import.meta.url)),
        '--stdin',
        ...(recover ? ['--recover'] : []),
      ],
      { env: { ...process.env, DATABASE_URL: databaseURL } },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
    child.stdin.end(JSON.stringify(input));
  });
}
test('local administrative CLI provisions idempotently, preserves existing viewer identity and recovers without exposing credentials', async () => {
  const db = createDatabase(databaseURL);
  const password = randomBytes(24).toString('base64url');
  const email = `cli-${randomUUID()}@example.test`;
  try {
    await migrate(db);
    const first = await run({ email, password });
    expect(first.code).toBe(0);
    expect(first.output).not.toContain(password);
    expect(first.output).not.toContain(databaseURL);
    expect((await run({ email, password: randomBytes(24).toString('base64url') })).code).toBe(0);
    const auth = createAuth({
      db,
      baseURL: 'http://localhost:4999',
      secret: randomBytes(48).toString('base64url'),
    });
    const login = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const recovery = await run({ email, password: randomBytes(24).toString('base64url') }, true);
    expect(recovery.code).toBe(0);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    const viewerEmail = `viewer-${randomUUID()}@example.test`;
    const viewer = (
      await db.pool.query<{ id: string }>(
        'insert into users(name,email) values($1,$2) returning id',
        ['Viewer', viewerEmail],
      )
    ).rows[0]!;
    expect((await run({ email: viewerEmail, password })).code).toBe(1);
    expect((await run({ email: viewerEmail, password }, true)).code).toBe(1);
    expect(
      (await db.pool.query('select id from organization_memberships where user_id=$1', [viewer.id]))
        .rowCount,
    ).toBe(0);
  } finally {
    await db.close();
  }
});
