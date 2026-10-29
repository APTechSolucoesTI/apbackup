import { randomUUID } from 'node:crypto';
import type { PlatformDatabase } from '@apbackup/db';
import { agentCommandSchema, executionStatusSchema } from '@apbackup/contracts';
import { assertTransition } from '../../../packages/engine/src/state-machine.js';
import {
  createExecutionStore,
  runtimeTransaction,
  type ClaimedJob,
  ReservationBlockedError,
} from '../../../packages/db/src/repositories/jobs.js';
import { reconcileExecution } from './reconciler.js';
export async function dispatchJob(db: PlatformDatabase, job: ClaimedJob, now: Date) {
  const store = createExecutionStore(db);
  const prior = await db.pool.query(
    'select id from agent_commands where organization_id=$1 and execution_id=$2',
    [job.organizationId, job.executionId],
  );
  if (prior.rowCount) return reconcileExecution(db, job.executionId, job.organizationId);
  const retentionTask = (
    await db.pool.query(
      `select execution_id from repository_tasks where organization_id=$1 and execution_id=$2 and scope->>'kind'='repository_retention'`,
      [job.organizationId, job.executionId],
    )
  ).rowCount;
  const busySQL = `select e.id from executions e where e.organization_id=$1 and e.id<>$2 and (
    ($3 and e.status not in('concluida','falhas_parciais','falhou','cancelada') and not(e.status='aguardando' and exists(select 1 from repository_tasks t where t.organization_id=e.organization_id and t.execution_id=e.id and t.scope->>'kind'='repository_retention')))
    or exists(select 1 from agent_commands a where a.organization_id=e.organization_id and a.execution_id=e.id and a.body->'operation'->>'kind'='repository_retention' and (a.state in('queued','delivered','unknown') or a.result->>'outcome'='unknown'))) limit 1`;
  const blocked = await db.pool.query(busySQL, [
    job.organizationId,
    job.executionId,
    Boolean(retentionTask),
  ]);
  if (blocked.rowCount) throw new ReservationBlockedError('resource_busy');
  const resources = (
    await db.pool.query<{ resource_id: string; agent_id: string | null }>(
      `select pr.resource_id,(select a.id from agents a where a.organization_id=r.organization_id and a.server_id=r.server_id and a.revoked_at is null and a.identity_digest is not null order by a.created_at desc limit 1) agent_id from profile_resources pr join resources r on r.organization_id=pr.organization_id and r.id=pr.resource_id where pr.organization_id=$1 and pr.profile_version_id=$2 order by pr.resource_id`,
      [job.organizationId, job.profileVersionId],
    )
  ).rows;
  if (!resources.length || resources.some((r) => !r.agent_id)) {
    await runtimeTransaction(db, async (c) => {
      const held = await c.query(
        "select id from execution_jobs where id=$1 and holder=$2 and claim_until>$3 and state='claimed' for update",
        [job.jobId, job.holder, now],
      );
      if (!held.rowCount) throw new Error('Claim lost');
      await c.query(
        "update executions set status='exige_intervencao' where organization_id=$1 and id=$2",
        [job.organizationId, job.executionId],
      );
      await store.append(c, {
        organizationId: job.organizationId,
        executionId: job.executionId,
        key: 'agent-unavailable',
        code: 'agent_unavailable',
        status: 'exige_intervencao',
      });
      await c.query("update execution_jobs set state='done' where id=$1 and holder=$2", [
        job.jobId,
        job.holder,
      ]);
    });
    return { state: 'exige_intervencao' };
  }
  const reservation = await store.reserveResources(
    job,
    resources.map((r) => r.resource_id),
    now,
  );
  const fenced = { ...job, fencingToken: reservation.fencingToken };
  await store.assertFence(fenced, reservation.resourceIds, now);
  await runtimeTransaction(db, async (c) => {
    await c.query('select id from organizations where id=$1 for update', [job.organizationId]);
    if (
      (await c.query(busySQL, [job.organizationId, job.executionId, Boolean(retentionTask)]))
        .rowCount
    )
      throw new ReservationBlockedError('resource_busy');
    const owned = await c.query(
      "select id from execution_jobs where id=$1 and holder=$2 and claim_until>$3 and state='claimed' for update",
      [job.jobId, job.holder, now],
    );
    if (!owned.rowCount) throw new Error('Claim lost');
    const current = (
      await c.query<{ status: string }>(
        'select status from executions where organization_id=$1 and id=$2 for update',
        [job.organizationId, job.executionId],
      )
    ).rows[0]!;
    assertTransition(executionStatusSchema.parse(current.status), 'verificando');
    const pgBinding = (
      await c.query(
        'select b.resource_id from postgresql_bindings b where b.organization_id=$1 and b.profile_version_id=$2',
        [job.organizationId, job.profileVersionId],
      )
    ).rows[0];
    const execution = (
      await c.query<{ kind: string; plan_id: string | null }>(
        'select kind,plan_id from executions where organization_id=$1 and id=$2',
        [job.organizationId, job.executionId],
      )
    ).rows[0]!;
    let pgOperation: unknown;
    const dockerBinding = (
      await c.query(
        'select resource_id from docker_bindings where organization_id=$1 and profile_version_id=$2',
        [job.organizationId, job.profileVersionId],
      )
    ).rows[0];
    const repositoryTask = (
      await c.query<{ scope: unknown }>(
        'select scope from repository_tasks where organization_id=$1 and execution_id=$2',
        [job.organizationId, job.executionId],
      )
    ).rows[0];
    if (repositoryTask) pgOperation = repositoryTask.scope;
    else if (pgBinding || dockerBinding) {
      if (execution.kind === 'restore') {
        const restore = (
          await c.query<{ scope: unknown }>(
            'select scope from restore_requests where organization_id=$1 and execution_id=$2 and not production',
            [job.organizationId, job.executionId],
          )
        ).rows[0];
        if (!restore) throw new Error('Restore request unavailable');
        pgOperation = restore.scope;
      } else {
        const repositories = (
          await c.query<{
            repository_id: string;
            configuration_revision: number;
            kind: string;
            configuration: unknown;
          }>(
            "select pd.repository_id,d.configuration_revision,d.kind,d.configuration from plan_destinations pd join repositories r on r.organization_id=pd.organization_id and r.id=pd.repository_id join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where pd.organization_id=$1 and pd.plan_id=$2 and d.status='ativo' and d.archived_at is null and r.engine='restic' order by (d.kind='local' and d.configuration is null) desc,pd.created_at,pd.id",
            [job.organizationId, execution.plan_id],
          )
        ).rows;
        if (
          !repositories.length ||
          resources.length !== 1 ||
          repositories[0]!.kind !== 'local' ||
          repositories[0]!.configuration !== null
        )
          throw new Error('One database/local repository required');
        pgOperation = {
          kind: dockerBinding ? 'docker_backup' : 'postgresql_backup',
          repositoryId: repositories[0]!.repository_id,
          repositoryIds: repositories.map((r) => r.repository_id),
          repositoryRevisions: Object.fromEntries(
            repositories.map((r) => [r.repository_id, r.configuration_revision]),
          ),
        };
      }
    }
    for (const resource of resources) {
      const command = agentCommandSchema.parse({
        version: 1,
        commandId: randomUUID(),
        organizationId: job.organizationId,
        executionId: job.executionId,
        profileVersionId: job.profileVersionId,
        agentId: resource.agent_id,
        resourceId: resource.resource_id,
        fencingToken: reservation.fencingToken,
        expiresAt: new Date(+now + (pgOperation ? 3600000 : 45000)).toISOString(),
        operation: pgOperation ?? { kind: 'inspect', path: 'source' },
      });
      await c.query(
        'insert into agent_commands(id,organization_id,execution_id,agent_id,resource_id,profile_version_id,fencing_token,body,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(organization_id,execution_id,resource_id) do nothing',
        [
          command.commandId,
          job.organizationId,
          job.executionId,
          resource.agent_id,
          resource.resource_id,
          job.profileVersionId,
          reservation.fencingToken,
          JSON.stringify(command),
          command.expiresAt,
        ],
      );
    }
    await c.query(
      "insert into execution_steps(organization_id,execution_id,key,position,status,started_at) values($1,$2,'preflight',0,'verificando',$3) on conflict do nothing",
      [job.organizationId, job.executionId, now],
    );
    await c.query(
      "insert into attempts(organization_id,step_id,number,status,started_at) select organization_id,id,1,'verificando',$3 from execution_steps where organization_id=$1 and execution_id=$2 and key='preflight' on conflict do nothing",
      [job.organizationId, job.executionId, now],
    );
    await c.query(
      "update executions set status='verificando',started_at=coalesce(started_at,$3) where organization_id=$1 and id=$2",
      [job.organizationId, job.executionId, now],
    );
    await store.append(c, {
      organizationId: job.organizationId,
      executionId: job.executionId,
      key: 'dispatched',
      code: 'preflight_dispatched',
      status: 'verificando',
    });
  });
  return { state: 'waiting' };
}
