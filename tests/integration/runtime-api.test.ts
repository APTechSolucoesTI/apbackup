import { beforeAll, afterAll, expect, test } from 'vitest';
import { runtimeFixture } from './runtime-fixture.js';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
let f: Awaited<ReturnType<typeof runtimeFixture>>;
beforeAll(async () => {
  f = await runtimeFixture();
});
afterAll(async () => {
  if (f) {
    await f.db.pool.query("update execution_jobs set state='done' where organization_id=$1", [
      f.org,
    ]);
    await f.db.close();
  }
});
test('runtime HTTP binds authenticated organization and permissions; agent poll/result requires non-revoked bearer identity', async () => {
  const { createRuntimeApi } = await import('../../apps/web/src/lib/execution.server.js');
  let actor: SessionPrincipal = {
    organizationId: f.org,
    userId: crypto.randomUUID(),
    membershipId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const api = createRuntimeApi(f.db, async () => actor, 'https://console.example.test');
  const call = (path: string, body: unknown, identity?: string) =>
    api(
      new Request(`https://console.example.test${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://console.example.test',
          ...(identity ? { authorization: `Bearer ${identity}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const invitation = await call('/api/agents/invitations', { serverId: f.server });
  expect(invitation.status).toBe(200);
  const { enrollment } = await invitation.json();
  const registered = await call('/api/agents/enroll', {
    enrollment,
    externalIdentity: crypto.randomUUID(),
  });
  expect(registered.status).toBe(200);
  const agent = await registered.json();
  expect(
    (await call('/api/agents/enroll', { enrollment, externalIdentity: crypto.randomUUID() }))
      .status,
  ).toBe(401);
  expect((await call('/api/agents/poll', {})).status).toBe(401);
  expect((await call('/api/agents/poll', {}, agent.identity)).status).toBe(200);
  actor = { ...actor, role: 'viewer' };
  expect(
    (await call('/api/runtime/execute', { planId: f.plan, idempotencyKey: 'http' })).status,
  ).toBe(403);
  actor = { ...actor, role: 'administrator' };
  const queued = await call('/api/runtime/execute', { planId: f.plan, idempotencyKey: 'http' });
  expect(queued.status).toBe(200);
  const { executionId } = await queued.json();
  expect(executionId).toBeTruthy();
  const { createExecutionStore } = await import('../../packages/db/src/repositories/jobs.js');
  const { dispatchJob } = await import('../../apps/coordinator/src/dispatcher.js');
  const store = createExecutionStore(f.db);
  const job = (await store.claimJob('api-test', new Date()))!;
  await dispatchJob(f.db, job, new Date());
  const polled = await call('/api/agents/poll', {}, agent.identity);
  const { commands } = await polled.json();
  expect(commands).toHaveLength(1);
  const command = commands[0];
  expect(command.executionId).toBe(executionId);
  expect(typeof command.fencingToken).toBe('string');
  expect(await (await call('/api/agents/authorize', command, agent.identity)).json()).toEqual({
    allowed: true,
  });
  expect(
    await (
      await call(
        '/api/agents/authorize',
        { ...command, operation: { kind: 'service_pause', unit: 'test.service' } },
        agent.identity,
      )
    ).json(),
  ).toEqual({ allowed: false });
  await f.db.pool.query(
    "update leases set expires_at=now()-interval '1 second' where execution_id=$1",
    [executionId],
  );
  expect(await (await call('/api/agents/authorize', command, agent.identity)).json()).toEqual({
    allowed: false,
  });
  expect((await call(`/api/agents/${agent.agentId}/revoke`, {})).status).toBe(200);
  expect((await call('/api/agents/poll', {}, agent.identity)).status).toBe(401);
  expect(
    (
      await call('/api/runtime/execute', {
        planId: f.plan,
        idempotencyKey: 'http',
        organizationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400);
});
