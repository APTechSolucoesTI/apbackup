import { persistReplications } from './repository-results.js';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  agentCommandSchema,
  agentResultSchema,
  manifestSchema,
  profileVersionSchema,
  canonicalJson,
  dockerSelectionSchema,
  type AgentResult,
} from '@apbackup/contracts';
import { assertTransition } from '../../../packages/engine/src/state-machine.js';
import type { createExecutionStore } from '../../../packages/db/src/repositories/jobs.js';
export async function finishPostgres(
  c: PoolClient,
  store: ReturnType<typeof createExecutionStore>,
  organizationId: string,
  executionId: string,
  current: string,
  rows: { body: unknown; result: unknown }[],
) {
  if (rows.length !== 1) return false;
  const command = agentCommandSchema.parse(rows[0]!.body),
    result = agentResultSchema.parse(rows[0]!.result),
    op = command.operation;
  const docker = op.kind === 'docker_backup' || op.kind === 'docker_restore';
  if (op.kind !== 'postgresql_backup' && op.kind !== 'postgresql_restore' && !docker) return false;
  if (result.outcome !== 'completed') return false;
  const binding = (
    await c.query<{
      database_name: string;
      schema_names: string[];
      selection: unknown;
      server_id: string;
      definition: unknown;
    }>(
      docker
        ? 'select b.selection,r.server_id,v.definition from docker_bindings b join resources r on r.organization_id=b.organization_id and r.id=b.resource_id join profile_versions v on v.organization_id=b.organization_id and v.id=b.profile_version_id where b.organization_id=$1 and b.profile_version_id=$2 and b.resource_id=$3'
        : 'select b.database_name,b.schema_names,r.server_id,v.definition from postgresql_bindings b join resources r on r.organization_id=b.organization_id and r.id=b.resource_id join profile_versions v on v.organization_id=b.organization_id and v.id=b.profile_version_id where b.organization_id=$1 and b.profile_version_id=$2 and b.resource_id=$3',
      [organizationId, command.profileVersionId, command.resourceId],
    )
  ).rows[0];
  if (!binding) throw new Error('Historical PostgreSQL binding missing');
  const event = async (
    status: 'capturando' | 'enviando' | 'verificando_destino' | 'concluida' | 'falhas_parciais',
    code: string,
  ) => {
    await c.query('update executions set status=$3 where organization_id=$1 and id=$2', [
      organizationId,
      executionId,
      status,
    ]);
    await store.append(c, { organizationId, executionId, key: code, code, status });
  };
  if (op.kind === 'postgresql_backup' || op.kind === 'docker_backup') {
    const proof = docker ? result.docker : result.postgres;
    if (
      !proof ||
      !result.artifact ||
      proof.repositoryId !== op.repositoryId ||
      (docker
        ? !result.docker ||
          canonicalJson(result.docker.selection) !==
            canonicalJson(dockerSelectionSchema.parse(binding.selection))
        : !result.postgres ||
          result.postgres.database !== binding.database_name ||
          canonicalJson(result.postgres.schemas) !== canonicalJson(binding.schema_names)) ||
      result.artifact.sha256 !== proof.sha256 ||
      result.artifact.sizeBytes !== proof.sizeBytes
    )
      throw new Error('PostgreSQL proof incomplete');
    const profile = profileVersionSchema.parse(binding.definition);
    const manifest = manifestSchema.parse({
      version: 1,
      organizationId,
      serverId: binding.server_id,
      profileId: profile.profileId,
      profileVersion: profile.version,
      adapter: profile.adapter,
      capturedAt: proof.capturedAt,
      consistency: profile.consistency,
      requiredComponentIds: [
        docker ? 'recovery-set' : 'database',
        ...(docker ? (result.docker?.artifacts.map((f) => f.name) ?? []) : []),
      ],
      components: [
        {
          id: docker ? 'recovery-set' : 'database',
          resourceId: command.resourceId,
          kind: docker ? 'files' : 'postgresql',
          artifactPath: result.artifact.path,
          sha256: proof.sha256,
          sizeBytes: Number(proof.sizeBytes),
        },
        ...(docker
          ? (result.docker?.artifacts.map((f) => ({
              id: f.name,
              resourceId: command.resourceId,
              kind: 'files' as const,
              artifactPath: `${command.executionId}/${f.name}`,
              sha256: f.sha256,
              sizeBytes: Number(f.sizeBytes),
            })) ?? [])
          : []),
      ],
      images:
        docker && result.docker?.imageId
          ? [{ reference: `docker-image:${result.docker.imageId}`, digest: result.docker.imageId }]
          : [],
      encryptedConfiguration:
        docker && result.docker?.artifacts.find((f) => f.name === 'config.enc')
          ? {
              artifactPath: `${command.executionId}/config.enc`,
              sha256: result.docker.artifacts.find((f) => f.name === 'config.enc')!.sha256,
              keyReference: `restic-repository:${proof.repositoryId}:config-scrypt-v1`,
            }
          : null,
      dependencies: [],
      restoreCapabilities: [docker ? 'files' : 'database'],
    });
    const point = randomUUID();
    await c.query(
      'update repositories set native_repository_id=$3 where organization_id=$1 and id=$2 and (native_repository_id is null or native_repository_id=$3)',
      [organizationId, proof.repositoryId, proof.nativeRepositoryId],
    );
    const repository = (
      await c.query<{ native_repository_id: string }>(
        'select native_repository_id from repositories where organization_id=$1 and id=$2',
        [organizationId, proof.repositoryId],
      )
    ).rows[0];
    if (repository?.native_repository_id !== proof.nativeRepositoryId)
      throw new Error('Restic repository identity changed');
    await c.query(
      "insert into recovery_points(id,organization_id,execution_id,server_id,profile_version_id,captured_at,status) values($1,$2,$3,$4,$5,$6,'complete')",
      [
        point,
        organizationId,
        executionId,
        binding.server_id,
        command.profileVersionId,
        proof.capturedAt,
      ],
    );
    await c.query(
      'insert into manifests(organization_id,recovery_point_id,version,sha256,body) values($1,$2,1,$3,$4)',
      [
        organizationId,
        point,
        createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
        JSON.stringify(manifest),
      ],
    );
    for (const component of manifest.components)
      await c.query(
        'insert into components(organization_id,recovery_point_id,resource_id,component_key,artifact_path,sha256,size_bytes,required) values($1,$2,$3,$4,$5,$6,$7,true)',
        [
          organizationId,
          point,
          component.resourceId,
          component.id,
          component.artifactPath,
          component.sha256,
          component.sizeBytes,
        ],
      );
    await c.query(
      docker
        ? "insert into destination_results(organization_id,recovery_point_id,repository_id,status,native_snapshot_id,size_bytes,verified_at,verification_scope,docker_evidence) values($1,$2,$3,'concluida',$4,$5,now(),'restic-read-data+recovery-set-sha256+safe-ustar',$6)"
        : "insert into destination_results(organization_id,recovery_point_id,repository_id,status,native_snapshot_id,size_bytes,verified_at,verification_scope,postgresql_evidence) values($1,$2,$3,'concluida',$4,$5,now(),'restic-read-data+restored-artifact-sha256+pg-archive-list',$6)",
      [
        organizationId,
        point,
        proof.repositoryId,
        proof.snapshotId,
        docker ? result.docker?.totalSizeBytes : proof.sizeBytes,
        JSON.stringify(proof),
      ],
    );
    if (result.replications)
      await persistReplications(c, organizationId, point, proof.repositoryId, result.replications);
    let from = current as 'verificando' | 'capturando' | 'enviando' | 'verificando_destino';
    for (const [status, code] of [
      ['capturando', docker ? 'docker_capture_verified' : 'postgresql_capture_verified'],
      ['enviando', 'restic_snapshot_stored'],
      ['verificando_destino', 'restic_artifact_verified'],
    ] as const) {
      assertTransition(from, status);
      await event(status, code);
      from = status;
    }
    assertTransition('verificando_destino', 'concluida');
  } else {
    if (
      op.kind === 'docker_restore'
        ? !result.dockerRestored || result.dockerRestored.targetName !== op.targetName
        : op.kind !== 'postgresql_restore' ||
          !result.restored ||
          result.restored.database !== op.targetDatabase ||
          canonicalJson(result.restored.schemas) !== canonicalJson(binding.schema_names) ||
          (binding.schema_names.length > 0 &&
            result.restored.tables.some((t) => !binding.schema_names.includes(t.schema)))
    )
      throw new Error('Restore evidence missing');
    assertTransition(current as 'verificando', 'concluida', 'restore');
    await c.query(
      "update restore_requests set status='concluida' where organization_id=$1 and execution_id=$2",
      [organizationId, executionId],
    );
    await c.query(
      "insert into restore_results(organization_id,request_id,status,completed_at,evidence) select organization_id,id,'concluida',now(),$3 from restore_requests where organization_id=$1 and execution_id=$2",
      [
        organizationId,
        executionId,
        JSON.stringify(docker ? result.dockerRestored : result.restored),
      ],
    );
  }
  await event(
    result.replications?.some((r) => r.status === 'falhou') ? 'falhas_parciais' : 'concluida',
    op.kind === 'docker_backup'
      ? 'docker_backup_complete'
      : op.kind === 'docker_restore'
        ? 'docker_restore_verified'
        : op.kind === 'postgresql_backup'
          ? 'postgresql_backup_complete'
          : 'postgresql_restore_verified',
  );
  await c.query('update executions set finished_at=now() where organization_id=$1 and id=$2', [
    organizationId,
    executionId,
  ]);
  await c.query(
    "update execution_steps set status='concluida',finished_at=now() where organization_id=$1 and execution_id=$2",
    [organizationId, executionId],
  );
  await c.query(
    "update attempts a set status='concluida',finished_at=now() from execution_steps s where a.organization_id=s.organization_id and a.step_id=s.id and s.organization_id=$1 and s.execution_id=$2",
    [organizationId, executionId],
  );
  await c.query(
    "update execution_jobs set state='done' where organization_id=$1 and execution_id=$2",
    [organizationId, executionId],
  );
  await c.query('delete from leases where organization_id=$1 and execution_id=$2', [
    organizationId,
    executionId,
  ]);
  return true;
}
export function validatePostgresResult(command: unknown, result: AgentResult) {
  const parsed = agentCommandSchema.parse(command);
  if (result.outcome !== 'completed') return;
  const op = parsed.operation;
  if (op.kind === 'postgresql_backup' || op.kind === 'docker_backup') {
    const expected = (op.repositoryIds ?? [op.repositoryId])
      .filter((id) => id !== op.repositoryId)
      .sort();
    const actual = (result.replications ?? []).map((r) => r.repositoryId).sort();
    if (canonicalJson(expected) !== canonicalJson(actual))
      throw new Error('Exact independent destination results required');
  }
  if (
    parsed.operation.kind === 'docker_backup' &&
    (!result.docker ||
      !result.artifact ||
      result.docker.repositoryId !== parsed.operation.repositoryId)
  )
    throw new Error('Docker backup proof required');
  if (
    parsed.operation.kind === 'docker_restore' &&
    (!result.dockerRestored || result.dockerRestored.targetName !== parsed.operation.targetName)
  )
    throw new Error('Docker restore proof required');
  if (
    parsed.operation.kind === 'postgresql_backup' &&
    (!result.postgres ||
      !result.artifact ||
      result.postgres.repositoryId !== parsed.operation.repositoryId)
  )
    throw new Error('Backup proof required');
  if (
    parsed.operation.kind === 'postgresql_restore' &&
    (!result.restored || result.restored.database !== parsed.operation.targetDatabase)
  )
    throw new Error('Restore proof required');
}
