import {
  resourceInputSchema,
  resourceUpdateSchema,
  resourceReadSchema,
  type ResourceInput,
} from '@apbackup/contracts';
import type { PoolClient } from 'pg';
import {
  baseFields,
  transaction,
  lockRecord,
  activeReference,
  audit,
  setArchived,
  ConfigurationError,
  type RepositoryContext,
} from './shared.js';
export function createResourcesRepository(ctx: RepositoryContext) {
  async function get(id: string, client: PoolClient | typeof ctx.db.pool = ctx.db.pool) {
    const row = (
      await client.query(
        `select ${baseFields()},t.server_id as "serverId",t.external_identity as "externalIdentity",t.kind,coalesce((select jsonb_agg(jsonb_build_object('resourceId',d.resource_id,'dependsOnResourceId',d.depends_on_resource_id,'shared',d.shared)) from resource_dependencies d where d.organization_id=t.organization_id and d.resource_id=t.id),'[]'::jsonb) as dependencies from resources t where t.organization_id=$1 and t.id=$2`,
        [ctx.organizationId, id],
      )
    ).rows[0];
    if (!row) throw new ConfigurationError(404, 'Recurso não encontrado.');
    return resourceReadSchema.parse(row);
  }
  async function dependencies(client: PoolClient, id: string, v: ResourceInput) {
    const unique = new Set<string>();
    for (const dependency of v.dependencies) {
      if (unique.has(dependency.dependsOnResourceId) || dependency.dependsOnResourceId === id)
        throw new ConfigurationError(
          400,
          'As dependências devem ser únicas e não podem apontar ao próprio recurso.',
          { dependencies: 'Revise as dependências.' },
        );
      unique.add(dependency.dependsOnResourceId);
      const resource = await activeReference(
        client,
        ctx,
        'resources',
        dependency.dependsOnResourceId,
      );
      if (resource.server_id !== v.serverId && !dependency.shared)
        throw new ConfigurationError(
          400,
          'Uma dependência de outra origem deve ser marcada como compartilhada.',
        );
      const cycle = await client.query(
        'with recursive deps(id) as (select depends_on_resource_id from resource_dependencies where organization_id=$1 and resource_id=$2 union select d.depends_on_resource_id from resource_dependencies d join deps on d.resource_id=deps.id where d.organization_id=$1) select id from deps where id=$3 limit 1',
        [ctx.organizationId, dependency.dependsOnResourceId, id],
      );
      if (cycle.rowCount)
        throw new ConfigurationError(400, 'As dependências não podem formar um ciclo.');
    }
    await client.query(
      'delete from resource_dependencies where organization_id=$1 and resource_id=$2',
      [ctx.organizationId, id],
    );
    for (const d of v.dependencies)
      await client.query(
        'insert into resource_dependencies(organization_id,resource_id,depends_on_resource_id,shared) values($1,$2,$3,$4)',
        [ctx.organizationId, id, d.dependsOnResourceId, d.shared],
      );
  }
  return {
    get,
    async create(input: unknown) {
      const v = resourceInputSchema.parse(input);
      return transaction(ctx, async (client) => {
        await activeReference(client, ctx, 'servers', v.serverId);
        const id = (
          await client.query<{ id: string }>(
            'insert into resources(organization_id,server_id,name,kind,external_identity) values($1,$2,$3,$4,$5) returning id',
            [ctx.organizationId, v.serverId, v.name, v.kind, v.externalIdentity],
          )
        ).rows[0]!.id;
        await dependencies(client, id, v);
        await audit(client, ctx, 'resource', id, 'create');
        return get(id, client);
      });
    },
    async update(id: string, input: unknown) {
      const v = resourceUpdateSchema.parse(input);
      return transaction(ctx, async (client) => {
        await lockRecord(client, ctx, 'resources', id, { expectedUpdatedAt: v.expectedUpdatedAt });
        await activeReference(client, ctx, 'servers', v.serverId);
        const old = await get(id, client);
        if (
          old.serverId !== v.serverId ||
          old.kind !== v.kind ||
          old.externalIdentity !== v.externalIdentity
        ) {
          const used = await client.query(
            'select id from profile_resources where organization_id=$1 and resource_id=$2 limit 1',
            [ctx.organizationId, id],
          );
          if (used.rowCount)
            throw new ConfigurationError(
              409,
              'A identidade de um recurso usado em uma versão é imutável. Cadastre um novo recurso.',
            );
        }
        await client.query(
          'update resources set name=$3,server_id=$4,kind=$5,external_identity=$6 where organization_id=$1 and id=$2',
          [ctx.organizationId, id, v.name, v.serverId, v.kind, v.externalIdentity],
        );
        await dependencies(client, id, v);
        await audit(client, ctx, 'resource', id, 'update');
        return get(id, client);
      });
    },
    archive: (id: string, input: unknown) =>
      setArchived(ctx, 'resources', id, input, true, get, async (client) => {
        const used = await client.query(
          'select p.id from system_profiles p join lateral(select id from profile_versions where organization_id=p.organization_id and profile_id=p.id order by version desc limit 1) v on true join profile_resources r on r.organization_id=p.organization_id and r.profile_version_id=v.id where p.organization_id=$1 and p.archived_at is null and r.resource_id=$2 limit 1',
          [ctx.organizationId, id],
        );
        if (used.rowCount)
          throw new ConfigurationError(
            409,
            'Remova este recurso da versão atual ou arquive o sistema que o utiliza.',
          );
      }),
    restore: (id: string, input: unknown) =>
      setArchived(ctx, 'resources', id, input, false, get, async (client) => {
        const row = await get(id, client);
        await activeReference(client, ctx, 'servers', row.serverId);
      }),
  };
}
