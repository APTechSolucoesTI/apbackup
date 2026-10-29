import { afterAll, beforeAll, expect, test } from 'vitest';
import { runtimeFixture } from './runtime-fixture.js';
let f: Awaited<ReturnType<typeof runtimeFixture>>;
beforeAll(async () => {
  f = await runtimeFixture();
});
afterAll(async () =>
  f
    ? f.db.pool
        .query("update execution_jobs set state='done' where organization_id=$1", [f.org])
        .then(() => f.db.close())
    : undefined,
);
test('one-use enrollment is atomic, identities are tenant-scoped and revocation rejects reconnect', async () => {
  const { createAgentRegistry } = await import('../../apps/agent/src/enrollment.js');
  const r = createAgentRegistry(f.db);
  const invitation = await r.invite(f.org, f.server, new Date(Date.now() + 60000));
  const enrolled = await r.enroll(invitation, crypto.randomUUID());
  await expect(r.enroll(invitation, crypto.randomUUID())).rejects.toThrow();
  expect((await r.authenticate(enrolled.identity)).id).toBe(enrolled.agentId);
  await r.revoke(f.org, enrolled.agentId);
  await expect(r.authenticate(enrolled.identity)).rejects.toThrow();
});
