import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { runtimeFixture } from './runtime-fixture.js';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
import { createPostgresApi } from '../../apps/web/src/lib/postgresql.server.js';
import { readPostgresConnection } from '../../packages/connectors/src/postgresql-connection.js';
let f: Awaited<ReturnType<typeof runtimeFixture>>;
beforeAll(async () => {
  f = await runtimeFixture();
  process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.VAULT_KEY_REFERENCE = 'test-pg';
  process.env.POSTGRES_ALLOWED_HOSTS = '127.0.0.1';
});
afterAll(async () => {
  await f?.db.close();
});

test('locally provisioned Docker PostgreSQL needs no password and web discovery fails closed', async () => {
  const id = randomUUID();
  const configuration = {
    name: 'Local provisioned',
    transport: 'docker_exec',
    container: 'supabase-db',
    username: 'postgres',
  };
  await f.db.pool.query(
    "insert into connections(id,organization_id,server_id,kind,endpoint,configuration) values($1,$2,$3,'postgresql',$4,$5)",
    [id, f.org, f.server, 'docker-exec:supabase-db', JSON.stringify(configuration)],
  );
  const read = await readPostgresConnection(f.db, f.org, id);
  expect(read?.transport).toBe('docker_exec');
  expect(read?.container).toBe('supabase-db');
  expect(read?.password).toBe('');
  const principal: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    membershipId: randomUUID(),
    sessionId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const api = createPostgresApi(f.db, async () => principal, 'https://console.example.test');
  for (const [path, body] of [
    [`/connections/${id}/discover`, {}],
    ['/select', { connectionId: id, database: 'postgres' }],
    ['/connections', { ...configuration, serverId: f.server }],
  ] as const) {
    const response = await api(
      new Request(`https://console.example.test/api/postgresql${path}`, {
        method: 'POST',
        headers: { origin: 'https://console.example.test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/instalador/);
  }
});
test('API discovers before profiles, binds selected database immutably, configures real plan and denies viewer/foreign access', async () => {
  let principal: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    membershipId: randomUUID(),
    sessionId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const api = createPostgresApi(f.db, async () => principal, 'https://console.example.test');
  const call = (path: string, body?: unknown) =>
    api(
      new Request(`https://console.example.test/api/postgresql${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { origin: 'https://console.example.test', 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const source = new URL(process.env.TEST_DATABASE_URL!);
  const response = await call('/connections', {
    serverId: f.server,
    name: 'Fixture',
    host: source.hostname,
    port: Number(source.port),
    username: source.username,
    password: source.password,
    sslMode: 'disable',
  });
  expect(response.status).toBe(201);
  const connection = (await response.json()) as { id: string };
  expect(JSON.stringify(await (await call('/connections')).json())).not.toContain(source.password);
  const discovery = await call(`/connections/${connection.id}/discover`, {});
  expect(discovery.status).toBe(200);
  const databases = (await discovery.json()) as { databases: { name: string }[] };
  expect(databases.databases.map((d) => d.name)).toContain(source.pathname.slice(1));
  expect(
    (await call('/select', { connectionId: connection.id, database: 'postgres' })).status,
  ).toBe(201);
  const selected = await call('/select', {
    connectionId: connection.id,
    database: source.pathname.slice(1),
  });
  expect(selected.status).toBe(201);
  const binding = (await selected.json()) as { profileVersionId: string };
  expect(
    await (
      await call('/select', { connectionId: connection.id, database: source.pathname.slice(1) })
    ).json(),
  ).toEqual(
    await (
      await call('/select', { connectionId: connection.id, database: source.pathname.slice(1) })
    ).json(),
  );
  const secret = (
    await f.db.pool.query('select ciphertext from secret_references where organization_id=$1', [
      f.org,
    ])
  ).rows;
  expect(JSON.stringify(secret)).not.toContain(source.password);
  expect(
    (
      await f.db.pool.query(
        'select connection_id,database_name from postgresql_bindings where organization_id=$1 and profile_version_id=$2',
        [f.org, binding.profileVersionId],
      )
    ).rows[0]?.connection_id,
  ).toBe(connection.id);
  principal = { ...principal, role: 'viewer' };
  expect(
    (await call('/select', { connectionId: connection.id, database: source.pathname.slice(1) }))
      .status,
  ).toBe(403);
  principal = { ...principal, role: 'administrator', organizationId: randomUUID() };
  expect((await call(`/connections/${connection.id}/discover`, {})).status).toBe(404);
});
