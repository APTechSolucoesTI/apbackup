import { expect, test } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { runtimeFixture } from './runtime-fixture.js';
import { createDockerApi } from '../../apps/web/src/lib/docker.server.js';
import { createRuntimeApi } from '../../apps/web/src/lib/execution.server.js';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
test('agent catalogs are scoped, selected resources immutable and viewer/foreign selections denied', async () => {
  const f = await runtimeFixture();
  process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.VAULT_KEY_REFERENCE = 'docker-test';
  let actor: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    membershipId: randomUUID(),
    sessionId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const base = 'https://console.example.test',
    api = createDockerApi(f.db, async () => actor, base),
    runtime = createRuntimeApi(f.db, async () => actor, base);
  const call = (path: string, value?: unknown, identity?: string) =>
    (path.startsWith('/api/docker') ? api : runtime)(
      new Request(base + path, {
        method: value ? 'POST' : 'GET',
        headers: {
          origin: base,
          'content-type': 'application/json',
          ...(identity ? { authorization: `Bearer ${identity}` } : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      }),
    );
  try {
    const invite = (await (
      await call('/api/agents/invitations', { serverId: f.server })
    ).json()) as { enrollment: string };
    const agent = (await (
      await call('/api/agents/enroll', {
        enrollment: invite.enrollment,
        externalIdentity: randomUUID(),
      })
    ).json()) as { identity: string };
    expect(
      (
        await call(
          '/api/agents/docker-catalog',
          {
            capturedAt: new Date().toISOString(),
            containers: [],
            services: [],
            directories: [{ name: 'attachments' }],
            volumes: [{ name: 'emails', owners: [], databaseHint: false }],
          },
          agent.identity,
        )
      ).status,
    ).toBe(200);
    expect((await call(`/api/docker/catalog?serverId=${f.server}`)).status).toBe(200);
    const selected = await call('/api/docker/select', {
      serverId: f.server,
      kind: 'volume',
      identity: 'emails',
    });
    expect(selected.status).toBe(201);
    const binding = (await selected.json()) as { profileVersionId: string };
    expect(
      await (
        await call('/api/docker/select', { serverId: f.server, kind: 'volume', identity: 'emails' })
      ).json(),
    ).toEqual(binding);
    await expect(
      f.db.pool.query('update docker_bindings set selection=selection where organization_id=$1', [
        f.org,
      ]),
    ).rejects.toThrow(/immutable/);
    actor = { ...actor, role: 'viewer' };
    expect(
      (await call('/api/docker/select', { serverId: f.server, kind: 'volume', identity: 'emails' }))
        .status,
    ).toBe(403);
    actor = { ...actor, role: 'administrator', organizationId: randomUUID() };
    expect((await call(`/api/docker/catalog?serverId=${f.server}`)).status).toBe(409);
  } finally {
    await f.db.close();
  }
});
