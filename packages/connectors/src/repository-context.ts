import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import { repositoryRuntimeSchema, type AgentCommand } from '@apbackup/contracts';
import { readSecret } from './postgresql-connection.js';
export async function readRepository(
  db: PlatformDatabase,
  org: string,
  id: string,
  revision?: number,
  allowInactive = false,
) {
  const row = (
    await db.pool.query<{
      repositoryId: string;
      destinationId: string;
      configurationRevision: number;
      kind: string;
      host: string | null;
      rootPath: string;
      configuration: unknown;
      credential_id: string;
      nativeRepositoryId: string | null;
      status: string;
    }>(
      `select r.id as "repositoryId",d.id as "destinationId",d.configuration_revision as "configurationRevision",d.kind,d.host,d.root_path as "rootPath",d.configuration,d.credential_id,r.native_repository_id as "nativeRepositoryId",d.status from repositories r join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where r.organization_id=$1 and r.id=$2 and r.engine='restic' and d.archived_at is null`,
      [org, id],
    )
  ).rows[0];
  if (
    !row ||
    (!allowInactive && row.status !== 'ativo') ||
    (revision !== undefined && row.configurationRevision !== revision)
  )
    throw new Error('Exact repository configuration unavailable');
  const credential = JSON.parse(
    await readSecret(db, org, row.credential_id, 'destination-credential'),
  ) as unknown;
  const { credential_id: omitted, status: discarded, ...configuration } = row;
  void omitted;
  void discarded;
  return repositoryRuntimeSchema.parse({ ...configuration, credential });
}
export async function resolveRepositoryCommand(db: PlatformDatabase, command: AgentCommand) {
  const op = command.operation;
  if (!('repositoryId' in op)) throw new Error('Repository command required');
  const ids =
    'repositoryIds' in op
      ? (op.repositoryIds ?? [op.repositoryId])
      : op.kind === 'repository_copy'
        ? [op.sourceRepositoryId, op.repositoryId]
        : [op.repositoryId];
  const revisions = 'repositoryRevisions' in op ? op.repositoryRevisions : undefined;
  const repositories = [];
  for (const id of [...new Set(ids)])
    repositories.push(
      await readRepository(
        db,
        command.organizationId,
        id,
        revisions?.[id],
        op.kind === 'repository_test',
      ),
    );
  let files: { name: string; sha256: string }[] = [];
  let cleanup: { executionId: string; commandId: string } | undefined;
  if (op.kind === 'repository_copy') {
    const evidence = (
      await db.pool.query<{ postgresql_evidence: unknown; docker_evidence: unknown }>(
        `select postgresql_evidence,docker_evidence from destination_results where organization_id=$1 and recovery_point_id=$2 and repository_id=$3 and native_snapshot_id=$4 and status='concluida' and removed_at is null and not retention_pending and verified_at is not null`,
        [command.organizationId, op.recoveryPointId, op.sourceRepositoryId, op.snapshotId],
      )
    ).rows[0];
    if (!evidence) throw new Error('Verified source unavailable');
    cleanup = (
      await db.pool.query<{ executionId: string; commandId: string }>(
        `select p.execution_id as "executionId",ac.id as "commandId" from recovery_points p join agent_commands ac on ac.organization_id=p.organization_id and ac.execution_id=p.execution_id where p.organization_id=$1 and p.id=$2 and not exists(select 1 from destination_results dr where dr.organization_id=p.organization_id and dr.recovery_point_id=p.id and dr.repository_id<>$3 and (dr.status<>'concluida' or dr.removed_at is not null or dr.retention_pending))`,
        [command.organizationId, op.recoveryPointId, op.repositoryId],
      )
    ).rows[0];
    if (evidence.docker_evidence) {
      const proof = z
        .object({
          sha256: z.string(),
          artifacts: z.array(z.object({ name: z.string(), sha256: z.string() })),
        })
        .parse(evidence.docker_evidence);
      files = [{ name: 'set.json', sha256: proof.sha256 }, ...proof.artifacts];
    } else
      files = [
        {
          name: 'database.dump',
          sha256: z.object({ sha256: z.string() }).parse(evidence.postgresql_evidence).sha256,
        },
      ];
  }
  if (op.kind !== 'repository_retention')
    return { repositories, files, ...(cleanup ? { cleanup } : {}) };
  // Reserve candidate rows before exposing deletion to the agent; restores/copies reject them.
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const task = (
      await client.query<{ decisions: unknown }>(
        'select decisions from repository_tasks where organization_id=$1 and execution_id=$2 for update',
        [command.organizationId, command.executionId],
      )
    ).rows[0];
    if (task?.decisions) {
      const retention = z
        .object({ forget: z.array(z.string()), protect: z.array(z.string()) })
        .parse(task.decisions);
      await client.query('commit');
      return { repositories, files, retention };
    }
    await client.query(
      'select id from repositories where organization_id=$1 and id=$2 for update',
      [command.organizationId, op.repositoryId],
    );
    await client.query(
      'select id from destination_results where organization_id=$1 and repository_id=$2 and removed_at is null for update',
      [command.organizationId, op.repositoryId],
    );
    const busy = await client.query(
      `select id from executions where organization_id=$1 and id<>$2 and status not in('aguardando','concluida','falhas_parciais','falhou','cancelada') limit 1`,
      [command.organizationId, command.executionId],
    );
    if (busy.rowCount) throw new Error('Retention requires no active or uncertain operation');
    const rows = (
      await client.query<{ native_snapshot_id: string; protect: boolean }>(
        `
      with points as(select d.id,d.native_snapshot_id,p.captured_at,p.profile_version_id,
      row_number() over(partition by p.profile_version_id order by p.captured_at desc,p.id) n,
      greatest(coalesce((select max(rp.days) from executions e join plans pl on pl.organization_id=e.organization_id and pl.id=e.plan_id join retention_policies rp on rp.organization_id=pl.organization_id and rp.id=pl.retention_policy_id where e.organization_id=p.organization_id and e.id=p.execution_id),7),7) days,
      p.protected_until,
      exists(select 1 from restore_requests rr where rr.organization_id=p.organization_id and rr.recovery_point_id=p.id and rr.status not in('concluida','falhou','cancelada')) or exists(select 1 from return_points rt where rt.organization_id=p.organization_id and rt.recovery_point_id=p.id) in_use
      from destination_results d join recovery_points p on p.organization_id=d.organization_id and p.id=d.recovery_point_id where d.organization_id=$1 and d.repository_id=$2 and d.status='concluida' and d.verified_at is not null and d.removed_at is null)
      select native_snapshot_id,(n=1 or in_use or protected_until>now() or captured_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' - days * interval '1 day') as protect from points order by captured_at limit 1000`,
        [command.organizationId, op.repositoryId],
      )
    ).rows;
    const protect = rows.filter((r) => r.protect).map((r) => r.native_snapshot_id),
      forget = rows
        .filter((r) => !r.protect)
        .map((r) => r.native_snapshot_id)
        .filter((s) => !protect.includes(s));
    await client.query(
      'update destination_results set retention_pending=true where organization_id=$1 and repository_id=$2 and native_snapshot_id=any($3::text[])',
      [command.organizationId, op.repositoryId, forget],
    );
    await client.query(
      'update repository_tasks set decisions=$3 where organization_id=$1 and execution_id=$2',
      [command.organizationId, command.executionId, JSON.stringify({ forget, protect })],
    );
    await client.query('commit');
    return { repositories, files, retention: { forget, protect } };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
