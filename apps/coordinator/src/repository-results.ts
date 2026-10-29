import type { PoolClient } from 'pg';
import {
  agentCommandSchema,
  agentResultSchema,
  canonicalJson,
  type AgentResult,
} from '@apbackup/contracts';
import type { createExecutionStore } from '../../../packages/db/src/repositories/jobs.js';
export async function persistReplications(
  c: PoolClient,
  org: string,
  point: string,
  sourceId: string,
  results: NonNullable<AgentResult['replications']>,
) {
  const source = (
    await c.query<{
      postgresql_evidence: Record<string, unknown> | null;
      docker_evidence: Record<string, unknown> | null;
      size_bytes: string;
    }>(
      `select postgresql_evidence,docker_evidence,size_bytes from destination_results where organization_id=$1 and recovery_point_id=$2 and repository_id=$3 and status='concluida' and verified_at is not null and removed_at is null`,
      [org, point, sourceId],
    )
  ).rows[0];
  if (!source) throw new Error('Capture evidence missing');
  for (const result of results) {
    const success = result.status === 'concluida';
    if (success && (!result.nativeRepositoryId || !result.snapshotId || !result.verifiedAt))
      throw new Error('Independent verification required');
    if (success) {
      const updated = await c.query(
        'update repositories set native_repository_id=$3 where organization_id=$1 and id=$2 and (native_repository_id is null or native_repository_id=$3)',
        [org, result.repositoryId, result.nativeRepositoryId],
      );
      if (!updated.rowCount) throw new Error('Target repository identity changed');
    }
    const base = source.docker_evidence ?? source.postgresql_evidence;
    const proof = success
      ? {
          ...base,
          repositoryId: result.repositoryId,
          nativeRepositoryId: result.nativeRepositoryId,
          snapshotId: result.snapshotId,
        }
      : null;
    await c.query(
      `insert into destination_results(organization_id,recovery_point_id,repository_id,status,native_snapshot_id,size_bytes,verified_at,verification_scope,postgresql_evidence,docker_evidence) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(organization_id,recovery_point_id,repository_id) do update set status=case when destination_results.status='concluida' then destination_results.status else excluded.status end,native_snapshot_id=coalesce(destination_results.native_snapshot_id,excluded.native_snapshot_id),size_bytes=coalesce(destination_results.size_bytes,excluded.size_bytes),verified_at=coalesce(destination_results.verified_at,excluded.verified_at),verification_scope=coalesce(destination_results.verification_scope,excluded.verification_scope),postgresql_evidence=coalesce(destination_results.postgresql_evidence,excluded.postgresql_evidence),docker_evidence=coalesce(destination_results.docker_evidence,excluded.docker_evidence)`,
      [
        org,
        point,
        result.repositoryId,
        result.status,
        result.snapshotId ?? null,
        success ? source.size_bytes : null,
        result.verifiedAt ?? null,
        success ? 'restic-copy+read-data+restored-component-sha256' : null,
        success && !source.docker_evidence ? JSON.stringify(proof) : null,
        success && source.docker_evidence ? JSON.stringify(proof) : null,
      ],
    );
  }
}
export async function finishRepository(
  c: PoolClient,
  store: ReturnType<typeof createExecutionStore>,
  org: string,
  executionId: string,
  rows: { body: unknown; result: unknown }[],
) {
  if (rows.length !== 1 || !rows[0]!.result) return false;
  const command = agentCommandSchema.parse(rows[0]!.body),
    result = agentResultSchema.parse(rows[0]!.result),
    op = command.operation;
  if (
    op.kind !== 'repository_copy' &&
    op.kind !== 'repository_test' &&
    op.kind !== 'repository_retention'
  )
    return false;
  if (result.outcome === 'unknown') return false;
  let completed = result.outcome === 'completed';
  if (op.kind === 'repository_copy') {
    if (
      result.replications?.length !== 1 ||
      result.replications[0]!.repositoryId !== op.repositoryId
    )
      completed = false;
    if (
      result.replications?.length === 1 &&
      result.replications[0]!.repositoryId === op.repositoryId
    )
      await persistReplications(
        c,
        org,
        op.recoveryPointId,
        op.sourceRepositoryId,
        result.replications,
      );
    completed &&= result.replications?.[0]?.status === 'concluida';
  } else if (op.kind === 'repository_test' && completed) {
    if (!result.repository || result.repository.repositoryId !== op.repositoryId)
      throw new Error('Repository test proof required');
    await c.query(
      'update repositories set native_repository_id=$3 where organization_id=$1 and id=$2 and (native_repository_id is null or native_repository_id=$3)',
      [org, op.repositoryId, result.repository.nativeRepositoryId],
    );
    const destination = (
      await c.query<{ destination_id: string }>(
        `update destinations d set status='ativo' from repositories r where r.organization_id=d.organization_id and r.destination_id=d.id and r.organization_id=$1 and r.id=$2 and d.configuration_revision=$3 returning d.id as destination_id`,
        [org, op.repositoryId, op.repositoryRevisions[op.repositoryId]],
      )
    ).rows[0];
    if (!destination) throw new Error('Destination revision changed');
    await c.query(
      `insert into connector_capabilities(organization_id,destination_id,connector_name,connector_version,configuration_revision,capabilities,assessed_at) values($1,$2,'restic','0.19.1-r4',$3,$4,now()) on conflict do nothing`,
      [
        org,
        destination.destination_id,
        op.repositoryRevisions[op.repositoryId],
        JSON.stringify({
          encrypted: true,
          platformRetention: true,
          restrictedDeletion: false,
          independentSnapshot: true,
          immutable: false,
        }),
      ],
    );
  } else if (op.kind === 'repository_retention' && completed) {
    if (!result.retention || result.retention.repositoryId !== op.repositoryId)
      throw new Error('Retention result required');
    const decision = (
      await c.query<{ decisions: { forget: string[]; protect: string[] } }>(
        'select decisions from repository_tasks where organization_id=$1 and execution_id=$2',
        [org, executionId],
      )
    ).rows[0]?.decisions;
    if (
      !decision ||
      canonicalJson(decision.forget) !== canonicalJson(result.retention.forgotten) ||
      canonicalJson(decision.protect) !== canonicalJson(result.retention.protected)
    )
      throw new Error('Exact auditable retention decision required');
    await c.query(
      'update destination_results set removed_at=now(),retention_pending=false where organization_id=$1 and repository_id=$2 and retention_pending and native_snapshot_id=any($3::text[])',
      [org, op.repositoryId, result.retention.forgotten],
    );
  }
  const state = completed ? 'concluida' : 'falhou';
  await c.query(
    'update executions set status=$3,finished_at=now() where organization_id=$1 and id=$2',
    [org, executionId, state],
  );
  await store.append(c, {
    organizationId: org,
    executionId,
    key: 'repository-finished',
    code: completed ? `${op.kind}_verified` : `${op.kind}_failed`,
    status: state,
    diagnostics: result.retention ?? { repositoryId: op.repositoryId },
  });
  await c.query(
    "update execution_jobs set state='done' where organization_id=$1 and execution_id=$2",
    [org, executionId],
  );
  await c.query('delete from leases where organization_id=$1 and execution_id=$2', [
    org,
    executionId,
  ]);
  return true;
}
