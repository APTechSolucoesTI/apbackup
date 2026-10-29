import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uuidSchema, agentCommandSchema, canonicalJson } from '@apbackup/contracts';
import type { PlatformDatabase } from '@apbackup/db';
import type { SessionPrincipal } from '../../../../packages/security/src/authorization.js';
import { authorize } from '../../../../packages/security/src/authorization.js';
import {
  runtimeTransaction,
  createExecutionStore,
} from '../../../../packages/db/src/repositories/jobs.js';
export async function repositoryApi(
  db: PlatformDatabase,
  principal: SessionPrincipal,
  path: string,
  request: Request,
  input: unknown,
) {
  const org = principal.organizationId;
  const match = /^\/api\/runtime\/points\/([^/]+)\/destinations$/.exec(path);
  if (match && request.method === 'GET') {
    authorize(principal, 'read', principal);
    const id = uuidSchema.parse(match[1]);
    const point = (
      await db.pool.query<{ capturedAt: Date }>(
        'select captured_at as "capturedAt" from recovery_points where organization_id=$1 and id=$2',
        [org, id],
      )
    ).rows[0];
    if (!point) throw new Error('Point unavailable');
    const items = (
      await db.pool.query(
        `select d.repository_id as "repositoryId",s.name,case when d.removed_at is not null then 'expirado' when d.retention_pending then 'retencao_pendente' else d.status::text end status,d.verified_at as "verifiedAt",d.native_snapshot_id as "snapshotId" from destination_results d join repositories r on r.organization_id=d.organization_id and r.id=d.repository_id join destinations s on s.organization_id=r.organization_id and s.id=r.destination_id where d.organization_id=$1 and d.recovery_point_id=$2 order by s.name`,
        [org, id],
      )
    ).rows;
    return Response.json({ ...point, items });
  }
  if (
    !['/api/runtime/replicate', '/api/runtime/retention', '/api/runtime/test-destination'].includes(
      path,
    ) ||
    request.method !== 'POST'
  )
    return null;
  authorize(principal, path.endsWith('test-destination') ? 'configure' : 'backup', principal);
  const copy = path.endsWith('/replicate'),
    test = path.endsWith('test-destination');
  const v = z
    .strictObject({
      repositoryId: uuidSchema.optional(),
      destinationId: uuidSchema.optional(),
      recoveryPointId: uuidSchema.optional(),
      profileVersionId: uuidSchema.optional(),
      idempotencyKey: z.string().min(1).max(160),
    })
    .parse(input);
  if (copy && (!v.repositoryId || !v.recoveryPointId || v.destinationId || v.profileVersionId))
    throw new Error('Copy requires one captured point and destination repository');
  if (test && (!v.destinationId || !v.profileVersionId || v.repositoryId || v.recoveryPointId))
    throw new Error('Test requires destination and single-resource agent profile');
  if (!copy && !test && (!v.repositoryId || v.destinationId || v.recoveryPointId))
    throw new Error('Retention requires one repository');
  const executionId = await runtimeTransaction(db, async (c) => {
    const repository = (
      await c.query<{ id: string; configuration_revision: number }>(
        `select r.id,d.configuration_revision from repositories r join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where r.organization_id=$1 and (($2::uuid is not null and r.id=$2) or ($3::uuid is not null and d.id=$3)) and r.engine='restic' and d.credential_id is not null and d.archived_at is null and ($4 or d.status='ativo') for share of d`,
        [org, v.repositoryId ?? null, v.destinationId ?? null, test],
      )
    ).rows[0];
    if (!repository) throw new Error('Configured destination required');
    let profileVersionId = v.profileVersionId,
      source:
        | { repository_id: string; native_snapshot_id: string; configuration_revision: number }
        | undefined;
    if (copy) {
      const point = (
        await c.query<{ profile_version_id: string }>(
          `select p.profile_version_id from recovery_points p join executions e on e.organization_id=p.organization_id and e.id=p.execution_id join plan_destinations pd on pd.organization_id=e.organization_id and pd.plan_id=e.plan_id and pd.repository_id=$3 where p.organization_id=$1 and p.id=$2 and p.status='complete' for share of p`,
          [org, v.recoveryPointId ?? null, repository.id],
        )
      ).rows[0];
      if (!point) throw new Error('Destination must belong to captured plan');
      profileVersionId = point.profile_version_id;
      source = (
        await c.query<{
          repository_id: string;
          native_snapshot_id: string;
          configuration_revision: number;
        }>(
          `select dr.repository_id,dr.native_snapshot_id,d.configuration_revision from destination_results dr join repositories r on r.organization_id=dr.organization_id and r.id=dr.repository_id join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where dr.organization_id=$1 and dr.recovery_point_id=$2 and dr.status='concluida' and dr.verified_at is not null and dr.removed_at is null and not dr.retention_pending and d.kind='local' and d.configuration is null and d.status='ativo' and dr.repository_id<>$3 order by (dr.repository_id::text=(select ac.body->'operation'->>'repositoryId' from recovery_points p join agent_commands ac on ac.organization_id=p.organization_id and ac.execution_id=p.execution_id where p.organization_id=dr.organization_id and p.id=dr.recovery_point_id limit 1)) desc,dr.created_at,dr.repository_id limit 1 for share of dr`,
          [org, v.recoveryPointId, repository.id],
        )
      ).rows[0];
      if (!source) throw new Error('Available finalized local source required');
    } else if (!profileVersionId) {
      profileVersionId = (
        await c.query<{ profile_version_id: string }>(
          `select p.profile_version_id from recovery_points p join destination_results d on d.organization_id=p.organization_id and d.recovery_point_id=p.id where p.organization_id=$1 and d.repository_id=$2 order by p.captured_at desc limit 1`,
          [org, repository.id],
        )
      ).rows[0]?.profile_version_id;
    }
    if (
      !profileVersionId ||
      !(
        await c.query('select id from profile_versions where organization_id=$1 and id=$2', [
          org,
          profileVersionId,
        ])
      ).rowCount
    )
      throw new Error('Selected profile required');
    if (
      Number(
        (
          await c.query<{ n: string }>(
            'select count(*)::text n from profile_resources where organization_id=$1 and profile_version_id=$2',
            [org, profileVersionId],
          )
        ).rows[0]?.n,
      ) !== 1
    )
      throw new Error('One resource per selected agent profile required');
    const revisions: Record<string, number> = {
      [repository.id]: repository.configuration_revision,
    };
    if (source) revisions[source.repository_id] = source.configuration_revision;
    const scope = agentCommandSchema.shape.operation.parse(
      copy
        ? {
            kind: 'repository_copy',
            repositoryId: repository.id,
            recoveryPointId: v.recoveryPointId,
            sourceRepositoryId: source!.repository_id,
            snapshotId: source!.native_snapshot_id,
            repositoryRevisions: revisions,
          }
        : {
            kind: test ? 'repository_test' : 'repository_retention',
            repositoryId: repository.id,
            repositoryRevisions: revisions,
          },
    );
    const key = `repository:${path.split('/').at(-1)}:${v.idempotencyKey}`;
    const previous = (
      await c.query<{ id: string; scope: unknown }>(
        `select e.id,t.scope from executions e join repository_tasks t on t.organization_id=e.organization_id and t.execution_id=e.id where e.organization_id=$1 and e.idempotency_key=$2`,
        [org, key],
      )
    ).rows[0];
    if (previous) {
      if (canonicalJson(previous.scope) !== canonicalJson(scope))
        throw new Error('Idempotency conflict');
      return previous.id;
    }
    const id = randomUUID();
    await c.query(
      'insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1,$2,$3,$4,$5)',
      [id, org, test ? 'verify' : copy ? 'backup' : 'retention', key, profileVersionId],
    );
    await c.query(
      'insert into repository_tasks(organization_id,execution_id,scope) values($1,$2,$3)',
      [org, id, JSON.stringify(scope)],
    );
    await c.query('insert into execution_jobs(organization_id,execution_id) values($1,$2)', [
      org,
      id,
    ]);
    await createExecutionStore(db).append(c, {
      organizationId: org,
      executionId: id,
      key: 'enqueued',
      code: test ? 'destination_test_queued' : copy ? 'replication_queued' : 'retention_queued',
      status: 'aguardando',
    });
    return id;
  });
  return Response.json({ executionId });
}
