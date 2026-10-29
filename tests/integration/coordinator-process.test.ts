import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeFixture } from './runtime-fixture.js';
let f: Awaited<ReturnType<typeof runtimeFixture>>;
const children: ChildProcess[] = [];
beforeAll(async () => {
  f = await runtimeFixture();
});
afterAll(async () => {
  for (const c of children)
    if (c.exitCode === null && !c.killed) {
      c.kill('SIGKILL');
      await new Promise((r) => c.once('exit', r));
    }
  if (f) {
    await f.db.pool.query("update execution_jobs set state='done' where organization_id=$1", [
      f.org,
    ]);
    await f.db.close();
  }
});
test('actual coordinator process can die after dispatch and restart without a second command', async () => {
  const { createExecutionStore } = await import('../../packages/db/src/repositories/jobs.js');
  const { createAgentRegistry } = await import('../../apps/agent/src/enrollment.js');
  const store = createExecutionStore(f.db);
  const registry = createAgentRegistry(f.db);
  await registry.enroll(
    await registry.invite(f.org, f.server, new Date(Date.now() + 60000)),
    crypto.randomUUID(),
  );
  const executionId = await store.enqueueExecution(
    f.plan,
    null,
    { kind: 'manual', idempotencyKey: 'process-restart' },
    { kind: 'service', organizationId: f.org },
  );
  const launch = () => {
    const c = spawn(process.execPath, ['--import', 'tsx', 'apps/coordinator/src/main.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        COORDINATOR_SCHEDULES: 'disabled',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(c);
    return c;
  };
  async function until(predicate: () => Promise<boolean>) {
    for (let n = 0; n < 200; n++) {
      if (await predicate()) return;
      await delay(25);
    }
    throw new Error('Coordinator did not make durable progress');
  }
  const first = launch();
  await until(async () =>
    Boolean(
      (await f.db.pool.query('select id from agent_commands where execution_id=$1', [executionId]))
        .rowCount,
    ),
  );
  const before = (
    await f.db.pool.query('select id from agent_commands where execution_id=$1', [executionId])
  ).rows[0].id;
  const old = (
    await f.db.pool.query('select worker_id from execution_jobs where execution_id=$1', [
      executionId,
    ])
  ).rows[0].worker_id;
  first.kill('SIGKILL');
  await new Promise((r) => first.once('exit', r));
  await f.db.pool.query(
    "update execution_jobs set claim_until=now()-interval '1 second' where execution_id=$1",
    [executionId],
  );
  const second = launch();
  await until(
    async () =>
      (
        await f.db.pool.query('select worker_id from execution_jobs where execution_id=$1', [
          executionId,
        ])
      ).rows[0].worker_id !== old,
  );
  const commands = (
    await f.db.pool.query('select id from agent_commands where execution_id=$1', [executionId])
  ).rows;
  expect(commands.map((c) => c.id)).toEqual([before]);
  expect(
    (await f.db.pool.query('select status from executions where id=$1', [executionId])).rows[0]
      .status,
  ).toBe('verificando');
  second.kill('SIGTERM');
  await new Promise((r) => second.once('exit', r));
});
