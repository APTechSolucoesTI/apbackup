import { serverInputSchema, serverUpdateSchema, serverReadSchema } from '@apbackup/contracts';
import type { PoolClient } from 'pg';
import {
  baseFields,
  transaction,
  lockRecord,
  audit,
  setArchived,
  ConfigurationError,
  type RepositoryContext,
} from './shared.js';
export function createServersRepository(ctx: RepositoryContext) {
  async function get(id: string, client: PoolClient | typeof ctx.db.pool = ctx.db.pool) {
    const row = (
      await client.query(
        `select ${baseFields()},t.external_identity as "externalIdentity",t.hostname from servers t where organization_id=$1 and id=$2`,
        [ctx.organizationId, id],
      )
    ).rows[0];
    if (!row) throw new ConfigurationError(404, 'Servidor não encontrado.');
    return serverReadSchema.parse(row);
  }
  return {
    get,
    async create(input: unknown) {
      const v = serverInputSchema.parse(input);
      return transaction(ctx, async (client) => {
        const id = (
          await client.query<{ id: string }>(
            'insert into servers(organization_id,name,external_identity,hostname) values($1,$2,$3,$4) returning id',
            [ctx.organizationId, v.name, v.externalIdentity, v.hostname],
          )
        ).rows[0]!.id;
        await audit(client, ctx, 'server', id, 'create');
        return get(id, client);
      });
    },
    async update(id: string, input: unknown) {
      const v = serverUpdateSchema.parse(input);
      return transaction(ctx, async (client) => {
        await lockRecord(client, ctx, 'servers', id, { expectedUpdatedAt: v.expectedUpdatedAt });
        await client.query(
          'update servers set name=$3,external_identity=$4,hostname=$5 where organization_id=$1 and id=$2',
          [ctx.organizationId, id, v.name, v.externalIdentity, v.hostname],
        );
        await audit(client, ctx, 'server', id, 'update');
        return get(id, client);
      });
    },
    archive: (id: string, input: unknown) =>
      setArchived(ctx, 'servers', id, input, true, get, async (client) => {
        const used = await client.query(
          'select id from resources where organization_id=$1 and server_id=$2 and archived_at is null union all select id from system_profiles where organization_id=$1 and server_id=$2 and archived_at is null union all select id from plans where organization_id=$1 and server_id=$2 and archived_at is null limit 1',
          [ctx.organizationId, id],
        );
        if (used.rowCount)
          throw new ConfigurationError(
            409,
            'Arquive os recursos, sistemas e planos deste servidor antes de continuar.',
          );
      }),
    restore: (id: string, input: unknown) => setArchived(ctx, 'servers', id, input, false, get),
  };
}
