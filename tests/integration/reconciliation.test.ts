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
test('append-only sequenced events deduplicate retries and project credential-bearing input safely', async () => {
  const { createExecutionStore } = await import('../../packages/db/src/repositories/jobs.js');
  const s = createExecutionStore(f.db);
  const id = await s.enqueueExecution(
    f.plan,
    null,
    { kind: 'manual', idempotencyKey: 'events' },
    { kind: 'service', organizationId: f.org },
  );
  const event = {
    organizationId: f.org,
    executionId: id,
    key: 'agent:1',
    code: 'agent_result',
    status: 'verificando' as const,
    diagnostics: { authorization: 'Bearer example-secret', password: 'example-secret' },
  };
  const a = await s.appendEvent(event);
  const b = await s.appendEvent(event);
  expect(a).toBe(b);
  const rows = (
    await f.db.pool.query(
      'select sequence,details,message from execution_events where execution_id=$1 order by sequence',
      [id],
    )
  ).rows;
  expect(rows.map((r) => r.sequence)).toEqual(['1', '2']);
  expect(JSON.stringify(rows)).not.toContain('example-secret');
  await expect(
    f.db.pool.query("update execution_events set code='tampered' where execution_id=$1", [id]),
  ).rejects.toThrow();
});
test('restart reconciles an outstanding command without new dispatch; repeated/out-of-order results cannot invent completion', async () => {
  const { createExecutionStore } = await import('../../packages/db/src/repositories/jobs.js');
  const { dispatchJob } = await import('../../apps/coordinator/src/dispatcher.js');
  const { reconcileExecution, acceptAgentResult } =
    await import('../../apps/coordinator/src/reconciler.js');
  const { createAgentRegistry } = await import('../../apps/agent/src/enrollment.js');
  const registry = createAgentRegistry(f.db);
  const agent = await registry.enroll(
    await registry.invite(f.org, f.server, new Date(Date.now() + 60000)),
    crypto.randomUUID(),
  );
  const store = createExecutionStore(f.db);
  const executionId = await store.enqueueExecution(
    f.plan,
    null,
    { kind: 'manual', idempotencyKey: 'restart' },
    { kind: 'service', organizationId: f.org },
  );
  // Prior test's queued execution is not a candidate for this scenario.
  await f.db.pool.query(
    "update execution_jobs set state='done' where execution_id<>$1 and organization_id=$2",
    [executionId, f.org],
  );
  const now = new Date();
  const job = (await store.claimJob('first', now))!;
  await dispatchJob(f.db, job, now);
  const command = (
    await f.db.pool.query('select body from agent_commands where execution_id=$1', [executionId])
  ).rows[0].body;
  await f.db.pool.query("update agent_commands set state='delivered' where execution_id=$1", [
    executionId,
  ]);
  expect((await reconcileExecution(f.db, executionId, f.org)).state).toBe('waiting');
  await f.db.pool.query(
    "update execution_jobs set claim_until=now()-interval '1 second',state='claimed' where execution_id=$1",
    [executionId],
  );
  const reclaimed = (await store.claimJob('restarted', new Date()))!;
  await dispatchJob(f.db, reclaimed, new Date());
  expect(
    (await f.db.pool.query('select id from agent_commands where execution_id=$1', [executionId]))
      .rows,
  ).toHaveLength(1);
  await expect(
    acceptAgentResult(f.db, agent.agentId, f.org, {
      commandId: command.commandId,
      sequence: 2,
      outcome: 'completed',
      code: 'ok',
    }),
  ).rejects.toThrow();
  const result = { commandId: command.commandId, sequence: 1, outcome: 'completed', code: 'ok' };
  await acceptAgentResult(f.db, agent.agentId, f.org, result);
  await acceptAgentResult(f.db, agent.agentId, f.org, result);
  expect((await reconcileExecution(f.db, executionId, f.org)).state).toBe('exige_intervencao');
  expect(
    (await f.db.pool.query('select status from executions where id=$1', [executionId])).rows[0]
      .status,
  ).not.toBe('concluida');
});
