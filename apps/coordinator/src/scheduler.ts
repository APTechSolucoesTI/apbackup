import type { PlatformDatabase } from '@apbackup/db';
import { randomUUID } from 'node:crypto';
import {
  createExecutionStore,
  runtimeTransaction,
} from '../../../packages/db/src/repositories/jobs.js';
export async function scheduleDue(db: PlatformDatabase, now: Date) {
  const store = createExecutionStore(db);
  const count = await runtimeTransaction(db, async (c) => {
    // PostgreSQL's IANA timezone database computes the latest local occurrence including DST.
    const rows = (
      await c.query<{ id: string; plan_id: string; organization_id: string; due: Date }>(
        `select s.id,s.plan_id,s.organization_id,case when ((($1::timestamptz at time zone s.timezone)::date+s.local_time) at time zone s.timezone)<=$1 then ((($1::timestamptz at time zone s.timezone)::date+s.local_time) at time zone s.timezone) else (((($1::timestamptz at time zone s.timezone)::date-1)+s.local_time) at time zone s.timezone) end due from schedules s join plans p on p.organization_id=s.organization_id and p.id=s.plan_id where s.enabled and p.enabled and p.archived_at is null for update of s skip locked`,
        [now],
      )
    ).rows;
    let count = 0;
    for (const r of rows) {
      const cursor = (
        await c.query<{ last_scheduled_at: Date | null }>(
          'select last_scheduled_at from schedules where id=$1',
          [r.id],
        )
      ).rows[0]!.last_scheduled_at;
      if (cursor && +cursor >= +r.due) continue;
      await store.enqueue(
        c,
        r.plan_id,
        r.due,
        { kind: 'schedule' },
        { kind: 'service', organizationId: r.organization_id },
      );
      await c.query('update schedules set last_scheduled_at=$2 where id=$1', [r.id, r.due]);
      count++;
    }
    return count;
  });
  await scheduleRepositoryRetention(db, now);
  return count;
}
export async function scheduleRepositoryRetention(db: PlatformDatabase, now: Date) {
  return runtimeTransaction(db, async (c) => {
    const rows = (
      await c.query<{
        organization_id: string;
        repository_id: string;
        profile_version_id: string;
        configuration_revision: number;
      }>(
        `select distinct on(r.organization_id,r.id) r.organization_id,r.id as repository_id,p.profile_version_id,d.configuration_revision from plans p join schedules s on s.organization_id=p.organization_id and s.plan_id=p.id join plan_destinations pd on pd.organization_id=p.organization_id and pd.plan_id=p.id join repositories r on r.organization_id=pd.organization_id and r.id=pd.repository_id join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where p.enabled and p.archived_at is null and s.enabled and d.status='ativo' and d.archived_at is null and r.engine='restic' and r.native_repository_id is not null and exists(select 1 from executions e where e.organization_id=p.organization_id and e.plan_id=p.id and e.scheduled_for is not null and e.status in('concluida','falhas_parciais')) order by r.organization_id,r.id,p.id`,
      )
    ).rows;
    let count = 0;
    for (const row of rows) {
      await c.query('select id from organizations where id=$1 for update', [row.organization_id]);
      await c.query('select id from repositories where organization_id=$1 and id=$2 for update', [
        row.organization_id,
        row.repository_id,
      ]);
      const current = (
        await c.query<{ configuration_revision: number }>(
          `select d.configuration_revision from destinations d join repositories r on r.organization_id=d.organization_id and r.destination_id=d.id where r.organization_id=$1 and r.id=$2 and d.status='ativo' and d.archived_at is null for share of d`,
          [row.organization_id, row.repository_id],
        )
      ).rows[0];
      if (!current) continue;
      const pending = await c.query(
        `select t.execution_id from repository_tasks t join executions e on e.organization_id=t.organization_id and e.id=t.execution_id where t.organization_id=$1 and t.scope->>'kind'='repository_retention' and t.scope->>'repositoryId'=$2 and (e.status not in('concluida','falhou','falhas_parciais','cancelada') or exists(select 1 from destination_results d where d.organization_id=t.organization_id and d.repository_id=$2::uuid and d.retention_pending)) limit 1`,
        [row.organization_id, row.repository_id],
      );
      if (pending.rowCount) continue;
      const id = randomUUID(),
        key = `retention:auto:${row.repository_id}:${now.toISOString().slice(0, 10)}`;
      const inserted = await c.query(
        "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1,$2,'retention',$3,$4) on conflict(organization_id,idempotency_key) do nothing returning id",
        [id, row.organization_id, key, row.profile_version_id],
      );
      if (!inserted.rowCount) continue;
      const scope = {
        kind: 'repository_retention',
        repositoryId: row.repository_id,
        repositoryRevisions: { [row.repository_id]: current.configuration_revision },
      };
      await c.query(
        'insert into repository_tasks(organization_id,execution_id,scope) values($1,$2,$3)',
        [row.organization_id, id, JSON.stringify(scope)],
      );
      await c.query('insert into execution_jobs(organization_id,execution_id) values($1,$2)', [
        row.organization_id,
        id,
      ]);
      await createExecutionStore(db).append(c, {
        organizationId: row.organization_id,
        executionId: id,
        key: 'enqueued',
        code: 'automatic_retention_queued',
        status: 'aguardando',
      });
      count++;
    }
    return count;
  });
}
