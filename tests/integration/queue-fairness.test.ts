import { test, expect } from 'vitest';
import { runtimeFixture } from './runtime-fixture.js';
test('unknown resources park their jobs and busy reservations defer fairly while unrelated jobs progress', async () => {
  const { createExecutionStore } = await import('../../packages/db/src/repositories/jobs.js');
  const { createAgentRegistry } = await import('../../apps/agent/src/enrollment.js');
  const { coordinatorTick } = await import('../../apps/coordinator/src/main.js');
  const { dispatchJob } = await import('../../apps/coordinator/src/dispatcher.js');
  const blocked = await runtimeFixture(),
    independent = await runtimeFixture();
  const db = blocked.db;
  try {
    const registry = createAgentRegistry(db);
    for (const f of [blocked, independent])
      await registry.enroll(
        await registry.invite(f.org, f.server, new Date(Date.now() + 60000)),
        crypto.randomUUID(),
      );
    const store = createExecutionStore(db);
    const enqueue = (f: typeof blocked, key: string) =>
      store.enqueueExecution(
        f.plan,
        null,
        { kind: 'manual', idempotencyKey: key },
        { kind: 'service', organizationId: f.org },
      );
    const now = new Date();
    const a = await enqueue(blocked, 'unknown-owner');
    const first = (await store.claimJob('first', now))!;
    await dispatchJob(db, first, now);
    await db.pool.query("update agent_commands set state='unknown' where execution_id=$1", [a]);
    await db.pool.query("update execution_jobs set state='done' where execution_id=$1", [a]);
    await db.pool.query('update leases set expires_at=$2 where execution_id=$1', [
      a,
      new Date(+now - 1),
    ]);
    const b = await enqueue(blocked, 'park-me'),
      c = await enqueue(independent, 'progress');
    await coordinatorTick(db, 'worker', now);
    await coordinatorTick(db, 'worker', now);
    expect(
      (await db.pool.query('select id from agent_commands where execution_id=$1', [c])).rowCount,
    ).toBe(1);
    const parked = (
      await db.pool.query(
        'select state,retry_after,dispatch_attempts,blocked_reason from execution_jobs where execution_id=$1',
        [b],
      )
    ).rows[0];
    expect(parked.state).toBe('waiting');
    expect(parked.blocked_reason).toBe('effect_unknown');
    expect(parked.retry_after).toBeNull();
    expect(parked.dispatch_attempts).toBe(1);
    expect(
      (await db.pool.query('select id from agent_commands where execution_id=$1', [c])).rowCount,
    ).toBe(1);
    const d = await enqueue(independent, 'busy-me');
    await coordinatorTick(db, 'worker', now);
    const busy = (
      await db.pool.query(
        'select state,retry_after,dispatch_attempts,blocked_reason from execution_jobs where execution_id=$1',
        [d],
      )
    ).rows[0];
    expect(busy.state).toBe('ready');
    expect(+busy.retry_after).toBeGreaterThan(+now);
    expect(busy.blocked_reason).toBe('resource_busy');
    expect(busy.dispatch_attempts).toBe(1);
    expect(await store.claimJob('not-before-retry', now)).toBeNull();
    const events = (
      await db.pool.query(
        "select code from execution_events where execution_id=any($1::uuid[]) and code in('effect_unknown','resource_busy')",
        [[b, d]],
      )
    ).rows;
    expect(events.map((e) => e.code).sort()).toEqual(['effect_unknown', 'resource_busy']);
  } finally {
    await db.pool.query(
      "update execution_jobs set state='done' where organization_id=any($1::uuid[])",
      [[blocked.org, independent.org]],
    );
    await blocked.db.close();
    await independent.db.close();
  }
});
