import { randomUUID } from 'node:crypto';
import type { PlatformDatabase } from '@apbackup/db';
import { postgresPlanSchema } from '@apbackup/contracts';
import { z } from 'zod';
import { runtimeTransaction } from '../../../../packages/db/src/repositories/jobs.js';
import { ConfigurationError } from '../../../../packages/db/src/repositories/shared.js';
export async function createResourcePlan(
  db: PlatformDatabase,
  org: string,
  v: z.infer<typeof postgresPlanSchema>,
) {
  return runtimeTransaction(db, async (c) => {
    const binding = (
      await c.query<{ server_id: string; resource_id: string }>(
        'select r.server_id,b.resource_id from profile_resources b join resources r on r.organization_id=b.organization_id and r.id=b.resource_id where b.organization_id=$1 and b.profile_version_id=$2 and r.archived_at is null',
        [org, v.profileVersionId],
      )
    ).rows[0];
    if (!binding) throw new ConfigurationError(404, 'Recurso selecionado não encontrado.');
    const destination = (
      await c.query<{ id: string }>(
        "select r.id from repositories r join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where d.organization_id=$1 and d.id=$2 and d.kind='local' and d.configuration is null and r.engine='restic' and d.status='ativo' and d.credential_id is not null and d.archived_at is null for share of d",
        [org, v.destinationId],
      )
    ).rows[0];
    if (!destination)
      throw new ConfigurationError(
        409,
        'Configure um destino local Restic ativo, com senha, antes de criar o plano.',
      );
    const retentionId = randomUUID(),
      id = randomUUID();
    await c.query(
      'insert into retention_policies(id,organization_id,name,days,evidence_days,protect_last_verified) values($1,$2,$3,7,30,true)',
      [retentionId, org, v.name],
    );
    await c.query(
      'insert into plans(id,organization_id,server_id,profile_version_id,retention_policy_id,name,enabled) values($1,$2,$3,$4,$5,$6,true)',
      [id, org, binding.server_id, v.profileVersionId, retentionId, v.name],
    );
    await c.query(
      'insert into plan_resources(organization_id,plan_id,resource_id) values($1,$2,$3)',
      [org, id, binding.resource_id],
    );
    for (const destinationId of [...new Set([v.destinationId, ...(v.destinationIds ?? [])])]) {
      const repo = (
        await c.query<{ id: string }>(
          "select r.id from repositories r join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where d.organization_id=$1 and d.id=$2 and d.status='ativo' and d.archived_at is null and r.engine='restic' and d.credential_id is not null",
          [org, destinationId],
        )
      ).rows[0];
      if (!repo)
        throw new ConfigurationError(
          409,
          'Configure todos os destinos selecionados antes de criar o plano.',
        );
      await c.query(
        'insert into plan_destinations(organization_id,plan_id,repository_id,required) values($1,$2,$3,true)',
        [org, id, repo.id],
      );
    }
    await c.query(
      'insert into schedules(organization_id,plan_id,local_time,timezone,enabled) values($1,$2,$3,$4,$5)',
      [org, id, v.localTime, v.timezone, v.scheduleEnabled],
    );
    return { id };
  });
}
