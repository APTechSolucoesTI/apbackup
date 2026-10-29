import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runtimeFixture } from './runtime-fixture.js';
import { createExecutionStore } from '../../packages/db/src/repositories/jobs.js';
import { dispatchJob } from '../../apps/coordinator/src/dispatcher.js';
import { createAgentRegistry } from '../../apps/agent/src/enrollment.js';
for (const obstacle of ['unknown', 'newer-fence', 'unrelated-unknown'] as const)
  test(`reclaim never adopts reservation with ${obstacle}`, async () => {
    const f = await runtimeFixture();
    try {
      const registry = createAgentRegistry(f.db);
      await registry.enroll(
        await registry.invite(f.org, f.server, new Date(Date.now() + 60000)),
        randomUUID(),
      );
      const store = createExecutionStore(f.db),
        id = await store.enqueueExecution(
          f.plan,
          null,
          { kind: 'manual', idempotencyKey: obstacle },
          { kind: 'service', organizationId: f.org },
        );
      const job = (await store.claimJob('before', new Date()))!;
      await dispatchJob(f.db, job, new Date());
      const before = (
        await f.db.pool.query('select holder from leases where execution_id=$1', [id])
      ).rows[0]!.holder;
      if (obstacle === 'unknown')
        await f.db.pool.query("update agent_commands set state='unknown' where execution_id=$1", [
          id,
        ]);
      if (obstacle === 'newer-fence')
        await f.db.pool.query(
          'update resource_fences set highest=highest+1 where organization_id=$1',
          [f.org],
        );
      if (obstacle === 'unrelated-unknown') {
        const other = await store.enqueueExecution(
          f.plan,
          null,
          { kind: 'manual', idempotencyKey: 'other' },
          { kind: 'service', organizationId: f.org },
        );
        await f.db.pool.query("update execution_jobs set state='done' where execution_id=$1", [
          other,
        ]);
        await f.db.pool.query(
          "insert into agent_commands(id,organization_id,execution_id,agent_id,resource_id,profile_version_id,fencing_token,body,state,expires_at) select $1,organization_id,$2,agent_id,resource_id,profile_version_id,fencing_token,body,'unknown',expires_at from agent_commands where execution_id=$3",
          [randomUUID(), other, id],
        );
      }
      await f.db.pool.query(
        "update execution_jobs set claim_until=now()-interval '1 second' where execution_id=$1",
        [id],
      );
      const reclaimed = (await store.claimJob('after', new Date()))!;
      expect(reclaimed.executionId).toBe(id);
      expect(reclaimed.holder).not.toBe(before);
      expect(
        (await f.db.pool.query('select holder from leases where execution_id=$1', [id])).rows[0]
          ?.holder,
      ).toBe(before);
    } finally {
      await f.db.pool.query("update execution_jobs set state='done' where organization_id=$1", [
        f.org,
      ]);
      await f.db.close();
    }
  });
