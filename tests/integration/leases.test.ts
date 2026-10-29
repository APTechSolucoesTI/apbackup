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
test('shared resource reservations serialize; release/reacquire keeps monotonically increasing fences and refuses stale owners', async () => {
  const { createExecutionStore } = await import('../../packages/db/src/repositories/jobs.js');
  const s = createExecutionStore(f.db);
  const p = { kind: 'service' as const, organizationId: f.org };
  const now = new Date();
  const id = await s.enqueueExecution(
    f.plan,
    null,
    { kind: 'manual', idempotencyKey: 'lease-1' },
    p,
  );
  const a = (await s.claimJob('a', now))!;
  expect(a.executionId).toBe(id);
  const first = await s.reserveResources(a, [f.resource], now);
  const otherId = await s.enqueueExecution(
    f.plan,
    null,
    { kind: 'manual', idempotencyKey: 'lease-2' },
    p,
  );
  const other = (await s.claimJob('b', now))!;
  expect(other.executionId).toBe(otherId);
  await expect(s.reserveResources(other, [f.resource], now)).rejects.toThrow('Resource busy');
  await expect(
    s.reserveResources({ ...a, holder: 'foreign' }, [f.resource], now),
  ).rejects.toThrow();
  await s.releaseResources(a);
  const second = await s.reserveResources(a, [f.resource], now);
  expect(BigInt(second.fencingToken)).toBeGreaterThan(BigInt(first.fencingToken));
  await expect(
    s.assertFence({ ...a, fencingToken: first.fencingToken }, [f.resource], now),
  ).rejects.toThrow();
  await s.assertFence({ ...a, fencingToken: second.fencingToken }, [f.resource], now);
  await expect(s.reserveResources(a, [crypto.randomUUID()], now)).rejects.toThrow();
});
