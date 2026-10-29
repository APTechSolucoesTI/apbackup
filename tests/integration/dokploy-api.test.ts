import { beforeAll, afterAll, test, expect } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { runtimeFixture } from './runtime-fixture.js';
import { createDokployApi } from '../../apps/web/src/lib/dokploy.server.js';
import { reconcileDokployNative } from '../../packages/connectors/src/dokploy-connection.js';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
let f: Awaited<ReturnType<typeof runtimeFixture>>, endpoint: string;
const secret = 'fixture-private-provider-key',
  calls: string[] = [];
let nativeProduced = false,
  nativeRuns = 0;
const provider = createServer((req, res) => {
  calls.push(req.url!);
  expect(req.headers['x-api-key']).toBe(secret);
  res.setHeader('content-type', 'application/json');
  const route = new URL(req.url!, 'http://localhost').pathname;
  const fixtures: Record<string, unknown> = {
    '/api/settings.getDokployVersion': '0.29.13',
    '/api/project.all': [
      {
        projectId: 'p1',
        name: 'Actual project',
        env: 'SECRET_SHOULD_NOT_ESCAPE',
        environments: [
          {
            environmentId: 'env1',
            name: 'production',
            applications: [{ applicationId: 'app1', name: 'Frontend' }],
            compose: [{ composeId: 'compose1', name: 'Mail' }],
            postgres: [{ postgresId: 'pg1', name: 'Shared DB' }],
          },
        ],
      },
    ],
    '/api/application.one': {
      applicationId: 'app1',
      appName: 'apbling-api-gmhp0o',
      name: 'Frontend',
      env: 'PASSWORD=private',
      mounts: [{ mountId: 'mount1', type: 'volume', volumeName: 'files', mountPath: '/files' }],
    },
    '/api/compose.one': {
      composeId: 'compose1',
      appName: 'mail-production',
      name: 'Mail',
      env: 'SECRET=private',
      mounts: [],
    },
    '/api/postgres.one': {
      postgresId: 'pg1',
      appName: 'shared-pg',
      name: 'Shared DB',
      databasePassword: 'super-secret',
      mounts: [],
      backups: [],
    },
    '/api/volumeBackups.list': [
      {
        volumeBackupId: 'native1',
        name: 'Owned files S3',
        destinationId: 's3-1',
        prefix: 'daily',
        enabled: true,
        cronExpression: '0 3 * * *',
        volumeName: 'files',
        turnOff: false,
      },
    ],
    '/api/volumeBackups.one': {
      volumeBackupId: 'native1',
      applicationId: 'app1',
      appName: 'native-volume',
      application: { appName: 'apbling-api-gmhp0o', serverId: null },
      destinationId: 's3-1',
      prefix: 'daily',
    },
    '/api/backup.listBackupFiles': nativeProduced
      ? [
          {
            Path: 'apbling-api-gmhp0o/daily/fixture.tar.gz',
            Name: 'fixture.tar.gz',
            Size: 1234,
            IsDir: false,
          },
        ]
      : [],
    '/api/volumeBackups.runManually': true,
  };
  if (!(route in fixtures)) {
    res.statusCode = 404;
    res.end('{}');
    return;
  }
  if (route === '/api/volumeBackups.runManually') {
    nativeProduced = true;
    nativeRuns++;
  }
  res.end(JSON.stringify(fixtures[route]));
});
beforeAll(async () => {
  f = await runtimeFixture();
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const address = provider.address();
  endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  process.env.DOKPLOY_ALLOWED_ORIGINS = endpoint;
  process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.VAULT_KEY_REFERENCE = 'dokploy-test';
});
afterAll(async () => {
  await new Promise<void>((r) => provider.close(() => r()));
  await f?.db.close();
});
test('actual public API contract is projected, encrypted, tenant scoped and read-only on discovery', async () => {
  let actor: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    sessionId: randomUUID(),
    membershipId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const api = createDokployApi(f.db, async () => actor, 'https://console.test'),
    call = (path: string, body?: unknown) =>
      api(
        new Request('https://console.test/api/dokploy' + path, {
          method: body ? 'POST' : 'GET',
          headers: { origin: 'https://console.test' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
  const saved = await call('/connections', {
    serverId: f.server,
    name: 'Provider',
    endpoint,
    apiKey: secret,
  });
  expect(saved.status).toBe(201);
  const connection = (await saved.json()) as { id: string };
  const discovered = await call(`/connections/${connection.id}/discover`, {});
  expect(discovered.status).toBe(200);
  const text = await discovered.text();
  expect(text).toContain('apbling-api-gmhp0o');
  for (const privateValue of [secret, 'PASSWORD', 'super-secret', 'SECRET_SHOULD_NOT_ESCAPE'])
    expect(text).not.toContain(privateValue);
  expect(
    JSON.stringify(
      (
        await f.db.pool.query('select ciphertext from secret_references where organization_id=$1', [
          f.org,
        ])
      ).rows,
    ),
  ).not.toContain(secret);
  expect(calls.every((c) => !c.includes('restore') && !c.includes('deploy'))).toBe(true);
  const configuration = await call('/native/configurations', {
    connectionId: connection.id,
    resourceId: 'app1',
    resourceType: 'application',
  });
  expect(configuration.status).toBe(200);
  expect(await configuration.json()).toMatchObject({
    items: [{ id: 'native1', enabled: true, schedule: '0 3 * * *' }],
  });
  const selection = {
    connectionId: connection.id,
    kind: 'volume',
    configurationId: 'native1',
    resourceId: 'app1',
    resourceType: 'application',
    idempotencyKey: randomUUID(),
  };
  const started = await call('/native/run', selection);
  expect(started.status).toBe(202);
  expect((await (await call('/native/runs')).json()).items[0].status).toBe('accepted');
  await reconcileDokployNative(f.db);
  expect((await (await call('/native/runs')).json()).items[0]).toMatchObject({
    status: 'artifact_observed',
    artifacts: [{ path: 'apbling-api-gmhp0o/daily/fixture.tar.gz', sizeBytes: '1234' }],
  });
  expect(
    (await f.db.pool.query('select id from recovery_points where organization_id=$1', [f.org]))
      .rowCount,
  ).toBe(0);
  expect((await call('/native/run', selection)).status).toBe(200);
  expect(nativeRuns).toBe(1);
  actor = { ...actor, role: 'viewer' };
  expect((await call(`/connections/${connection.id}/discover`, {})).status).toBe(403);
  actor = { ...actor, role: 'administrator', organizationId: randomUUID() };
  expect((await call(`/connections/${connection.id}/discover`, {})).status).toBe(404);
});
