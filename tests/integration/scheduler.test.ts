import { afterAll, beforeAll, expect, test } from 'vitest';
import { runtimeFixture } from './runtime-fixture.js';
import { randomUUID } from 'node:crypto';
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
test('concurrent schedulers enqueue only latest Brasília occurrence after days offline; manual retries are idempotent', async () => {
  const { createExecutionStore } = await import('../../packages/db/src/repositories/jobs.js');
  const { scheduleDue } = await import('../../apps/coordinator/src/scheduler.js');
  const store = createExecutionStore(f.db);
  const now = new Date('2026-10-29T06:01:00Z');
  await f.db.pool.query('update schedules set enabled=true where organization_id=$1', [f.org]);
  await Promise.all([scheduleDue(f.db, now), scheduleDue(f.db, now)]);
  const rows = await f.db.pool.query('select * from executions where organization_id=$1', [f.org]);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].scheduled_for.toISOString()).toBe('2026-10-29T06:00:00.000Z');
  expect(rows.rows[0].profile_version_id).toBe(f.version);
  const principal = { kind: 'service' as const, organizationId: f.org };
  const ids = await Promise.all([
    store.enqueueExecution(f.plan, null, { kind: 'manual', idempotencyKey: 'retry' }, principal),
    store.enqueueExecution(f.plan, null, { kind: 'manual', idempotencyKey: 'retry' }, principal),
  ]);
  expect(ids[0]).toBe(ids[1]);
  const claims = await Promise.all([
    store.claimJob('worker-a', now),
    store.claimJob('worker-b', now),
  ]);
  expect(new Set(claims.map((c) => c?.executionId)).size).toBe(2);
  await f.db.pool.query('update schedules set enabled=false where organization_id=$1', [f.org]);
});

test('daily retention is automatic and idempotent; active operations defer the same job without publishing a command or duplicating next day', async () => {
  const { scheduleRepositoryRetention } = await import('../../apps/coordinator/src/scheduler.js');
  const { coordinatorTick } = await import('../../apps/coordinator/src/coordinator.js');
  const { createAgentRegistry } = await import('../../apps/agent/src/enrollment.js');
  await f.db.pool.query("update execution_jobs set state='done' where organization_id=$1", [f.org]);
  await f.db.pool.query("update executions set status='concluida' where organization_id=$1", [
    f.org,
  ]);
  await f.db.pool.query('update schedules set enabled=true where organization_id=$1', [f.org]);
  const destination = randomUUID(),
    repository = randomUUID(),
    backup = randomUUID();
  await f.db.pool.query(
    "insert into destinations(id,organization_id,name,kind,root_path,status) values($1,$2,'Automatic retention fixture','local','retention_fixture','aguardando_configuracao')",
    [destination, f.org],
  );
  await f.db.pool.query(
    "insert into repositories(id,organization_id,destination_id,external_identity,engine,native_repository_id) values($1::uuid,$2,$3,$1::text,'restic',$4)",
    [repository, f.org, destination, 'a'.repeat(64)],
  );
  // The fixture has no secret: mark active only with a scoped encrypted-reference placeholder.
  const credential = randomUUID();
  await f.db.pool.query(
    "insert into secret_references(id,organization_id,name,ciphertext,key_reference,algorithm,version) values($1::uuid,$2,$1::text,'fixture','fixture','aes-256-gcm',1)",
    [credential, f.org],
  );
  await f.db.pool.query("update destinations set status='ativo',credential_id=$2 where id=$1", [
    destination,
    credential,
  ]);
  await f.db.pool.query(
    'insert into plan_destinations(organization_id,plan_id,repository_id) values($1,$2,$3)',
    [f.org, f.plan, repository],
  );
  await f.db.pool.query(
    "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id,plan_id,scheduled_for,status) values($1::uuid,$2,'backup',$1::text,$3,$4,'2026-10-29T06:00:01Z','concluida')",
    [backup, f.org, f.version, f.plan],
  );
  const now = new Date('2026-10-29T06:02:00Z');
  const counts = await Promise.all([
    scheduleRepositoryRetention(f.db, now),
    scheduleRepositoryRetention(f.db, now),
  ]);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  const task = (
    await f.db.pool.query<{ id: string }>(
      "select id from executions where organization_id=$1 and kind='retention'",
      [f.org],
    )
  ).rows[0]!;
  const registry = createAgentRegistry(f.db);
  await registry.enroll(
    await registry.invite(f.org, f.server, new Date(Date.now() + 60000)),
    randomUUID(),
  );
  const active = randomUUID();
  await f.db.pool.query(
    "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id,status) values($1::uuid,$2,'backup',$1::text,$3,'verificando')",
    [active, f.org, f.version],
  );
  await coordinatorTick(f.db, 'retention-fixture', now);
  expect(
    (
      await f.db.pool.query(
        'select state,blocked_reason from execution_jobs where execution_id=$1',
        [task.id],
      )
    ).rows[0],
  ).toMatchObject({ state: 'ready', blocked_reason: 'resource_busy' });
  expect(
    (await f.db.pool.query('select id from agent_commands where execution_id=$1', [task.id]))
      .rowCount,
  ).toBe(0);
  await f.db.pool.query("update executions set scheduled_for='2026-10-30T06:00:00Z' where id=$1", [
    backup,
  ]);
  expect(await scheduleRepositoryRetention(f.db, new Date('2026-10-30T06:02:00Z'))).toBe(0);
  await f.db.pool.query("update executions set status='concluida' where id=$1", [active]);
  await coordinatorTick(f.db, 'retention-fixture', new Date(+now + 61000));
  expect(
    (await f.db.pool.query('select id from agent_commands where execution_id=$1', [task.id]))
      .rowCount,
  ).toBe(1);
  expect(await scheduleRepositoryRetention(f.db, now)).toBe(0);
});

test('retention remains eligible when a 23:30 UTC backup completes after midnight and after coordinator downtime', async () => {
  const { scheduleRepositoryRetention } = await import('../../apps/coordinator/src/scheduler.js');
  await f.db.pool.query(
    "update executions set status=case when kind='retention' then 'concluida'::execution_status else 'verificando'::execution_status end where organization_id=$1",
    [f.org],
  );
  const backup = (
    await f.db.pool.query<{ id: string }>(
      'select id from executions where organization_id=$1 and plan_id=$2 and scheduled_for is not null order by created_at limit 1',
      [f.org, f.plan],
    )
  ).rows[0]!;
  await f.db.pool.query(
    "update executions set scheduled_for='2026-10-31T23:30:00Z',finished_at=null where id=$1",
    [backup.id],
  );
  const afterMidnight = new Date('2026-11-01T00:15:00Z');
  expect(await scheduleRepositoryRetention(f.db, afterMidnight)).toBe(0);
  await f.db.pool.query(
    "update executions set status='concluida',finished_at='2026-11-01T00:15:00Z' where id=$1",
    [backup.id],
  );
  expect(await scheduleRepositoryRetention(f.db, afterMidnight)).toBe(1);
  expect(await scheduleRepositoryRetention(f.db, afterMidnight)).toBe(0);
  await f.db.pool.query(
    "update executions set status='concluida' where organization_id=$1 and kind='retention'",
    [f.org],
  );
  await f.db.pool.query('update schedules set enabled=false where organization_id=$1', [f.org]);
  expect(await scheduleRepositoryRetention(f.db, new Date('2026-11-04T12:00:00Z'))).toBe(0);
  await f.db.pool.query('update schedules set enabled=true where organization_id=$1', [f.org]);
  expect(await scheduleRepositoryRetention(f.db, new Date('2026-11-04T12:00:00Z'))).toBe(1);
});
