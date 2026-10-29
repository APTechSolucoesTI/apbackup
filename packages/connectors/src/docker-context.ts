import { readRepository } from './repository-context.js';
import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import { dockerRuntimeSchema, type AgentCommand } from '@apbackup/contracts';
import { readSecret } from './postgresql-connection.js';
export async function resolveDockerCommand(db: PlatformDatabase, command: AgentCommand) {
  const op = command.operation;
  if (op.kind !== 'docker_backup' && op.kind !== 'docker_restore')
    throw new Error('Not a Docker command');
  const row = (
    await db.pool.query<{ selection: unknown; root_path: string; credential_id: string }>(
      `select b.selection,d.root_path,d.credential_id from docker_bindings b join repositories r on r.organization_id=b.organization_id and r.id=$4 join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where b.organization_id=$1 and b.profile_version_id=$2 and b.resource_id=$3 and r.engine='restic' and d.status='ativo' and d.archived_at is null`,
      [command.organizationId, command.profileVersionId, command.resourceId, op.repositoryId],
    )
  ).rows[0];
  if (!row) throw new Error('Historical Docker binding unavailable');
  const secret = z
    .object({ secret: z.string().min(1) })
    .parse(
      JSON.parse(
        await readSecret(db, command.organizationId, row.credential_id, 'destination-credential'),
      ),
    );
  let configurationPassword = secret.secret;
  if (op.kind === 'docker_restore') {
    const original = (
      await db.pool.query<{ key: string }>(
        "select m.body->'encryptedConfiguration'->>'keyReference' as key from manifests m where m.organization_id=$1 and m.recovery_point_id=$2",
        [command.organizationId, op.recoveryPointId],
      )
    ).rows[0]?.key;
    if (original) {
      const id = z
        .string()
        .regex(/^restic-repository:([a-f0-9-]{36}):config-scrypt-v1$/)
        .parse(original)
        .split(':')[1]!;
      const key = (
        await db.pool.query<{ credential_id: string }>(
          'select d.credential_id from repositories r join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where r.organization_id=$1 and r.id=$2',
          [command.organizationId, id],
        )
      ).rows[0];
      if (!key) throw new Error('Historical configuration key unavailable');
      configurationPassword = z
        .object({ secret: z.string().min(1) })
        .parse(
          JSON.parse(
            await readSecret(
              db,
              command.organizationId,
              key.credential_id,
              'destination-credential',
            ),
          ),
        ).secret;
    }
  }
  return dockerRuntimeSchema.parse({
    selection: row.selection,
    repositoryPath: /[^A-Za-z0-9_-]/.test(row.root_path) ? op.repositoryId : row.root_path,
    repositoryPassword: secret.secret,
    configurationPassword,
    repository: await readRepository(
      db,
      command.organizationId,
      op.repositoryId,
      op.kind === 'docker_backup' ? op.repositoryRevisions?.[op.repositoryId] : undefined,
    ),
  });
}
