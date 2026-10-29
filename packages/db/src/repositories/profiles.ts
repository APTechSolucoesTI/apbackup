import {
  profileInputSchema,
  profileUpdateSchema,
  profileReadSchema,
  profileVersionSchema,
  systemProfileSchema,
  type ProfileInput,
} from '@apbackup/contracts';
import type { PoolClient } from 'pg';
import { createResourcesRepository } from './resources.js';
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
export function createProfilesRepository(ctx: RepositoryContext) {
  const resourceRepo = createResourcesRepository(ctx);
  async function get(id: string, client: PoolClient | typeof ctx.db.pool = ctx.db.pool) {
    const row = (
      await client.query(
        `select ${baseFields()},t.server_id as "serverId",t.external_identity as "externalIdentity",v.id as "versionId",v.version,v.definition from system_profiles t join lateral(select id,version,definition from profile_versions where organization_id=t.organization_id and profile_id=t.id order by version desc limit 1) v on true where t.organization_id=$1 and t.id=$2`,
        [ctx.organizationId, id],
      )
    ).rows[0];
    if (!row) throw new ConfigurationError(404, 'Sistema não encontrado.');
    return profileReadSchema.parse(row);
  }
  async function append(client: PoolClient, id: string, version: number, v: ProfileInput) {
    await activeReference(client, ctx, 'servers', v.serverId);
    const ids = v.resources.map((r) => r.resourceId);
    if (new Set(ids).size !== ids.length)
      throw new ConfigurationError(400, 'Selecione recursos sem repetições.');
    const dependencies = (
      await client.query<{ resourceId: string; dependsOnResourceId: string; shared: boolean }>(
        'select resource_id as "resourceId",depends_on_resource_id as "dependsOnResourceId",shared from resource_dependencies where organization_id=$1 and resource_id=any($2::uuid[]) order by resource_id,depends_on_resource_id',
        [ctx.organizationId, ids],
      )
    ).rows;
    for (const edge of dependencies)
      if (!edge.shared && !ids.includes(edge.dependsOnResourceId))
        throw new ConfigurationError(
          400,
          'Inclua as dependências obrigatórias no perfil ou identifique seu compartilhamento.',
        );
    for (const resource of v.resources) {
      const actual = await activeReference(client, ctx, 'resources', resource.resourceId);
      if (
        actual.server_id !== v.serverId &&
        !dependencies.some((d) => d.shared && d.dependsOnResourceId === resource.resourceId)
      )
        throw new ConfigurationError(
          400,
          'Recursos de outra origem precisam de dependência compartilhada explícita.',
        );
    }
    const definition = profileVersionSchema.parse({
      profileId: id,
      version,
      adapter: v.adapter,
      consistency: v.consistency,
      resources: v.resources,
      dependencies,
      restoreCapabilities: v.restoreCapabilities,
    });
    const versionId = (
      await client.query<{ id: string }>(
        'insert into profile_versions(organization_id,profile_id,version,definition) values($1,$2,$3,$4) returning id',
        [ctx.organizationId, id, version, JSON.stringify(definition)],
      )
    ).rows[0]!.id;
    for (const resource of v.resources)
      await client.query(
        'insert into profile_resources(organization_id,profile_version_id,resource_id,required) values($1,$2,$3,$4)',
        [ctx.organizationId, versionId, resource.resourceId, resource.required],
      );
  }
  async function resolveProfile(versionId: string, organizationId: string) {
    if (organizationId !== ctx.organizationId)
      throw new ConfigurationError(403, 'Acesso não autorizado.');
    const row = (
      await ctx.db.pool.query(
        `select ${baseFields()},t.server_id as "serverId",t.external_identity as "externalIdentity",v.id as "versionId",v.version,v.definition from profile_versions v join system_profiles t on t.organization_id=v.organization_id and t.id=v.profile_id where v.organization_id=$1 and v.id=$2`,
        [ctx.organizationId, versionId],
      )
    ).rows[0];
    if (!row) throw new ConfigurationError(404, 'Versão do sistema não encontrada.');
    const profile = profileReadSchema.parse(row);
    const resources = await Promise.all(
      profile.definition.resources.map((resource) => resourceRepo.get(resource.resourceId)),
    );
    return systemProfileSchema.parse({ ...profile, resourceDetails: resources });
  }
  return {
    get,
    resolveProfile,
    async create(input: unknown) {
      const v = profileInputSchema.parse(input);
      return transaction(ctx, async (client) => {
        const id = (
          await client.query<{ id: string }>(
            'insert into system_profiles(organization_id,server_id,name,external_identity) values($1,$2,$3,$4) returning id',
            [ctx.organizationId, v.serverId, v.name, v.externalIdentity],
          )
        ).rows[0]!.id;
        await append(client, id, 1, v);
        await audit(client, ctx, 'profile', id, 'create');
        return get(id, client);
      });
    },
    async update(id: string, input: unknown) {
      const v = profileUpdateSchema.parse(input);
      return transaction(ctx, async (client) => {
        await lockRecord(client, ctx, 'system_profiles', id, {
          expectedUpdatedAt: v.expectedUpdatedAt,
        });
        const old = await get(id, client);
        if (old.serverId !== v.serverId || old.externalIdentity !== v.externalIdentity)
          throw new ConfigurationError(
            409,
            'A origem e a identificação de um sistema versionado são imutáveis. Cadastre um novo sistema.',
          );
        await client.query(
          'update system_profiles set name=$3 where organization_id=$1 and id=$2',
          [ctx.organizationId, id, v.name],
        );
        await append(client, id, old.version + 1, v);
        await audit(client, ctx, 'profile', id, 'version');
        return get(id, client);
      });
    },
    archive: (id: string, input: unknown) =>
      setArchived(ctx, 'system_profiles', id, input, true, get, async (client) => {
        const used = await client.query(
          'select p.id from plans p join profile_versions v on v.organization_id=p.organization_id and v.id=p.profile_version_id where p.organization_id=$1 and v.profile_id=$2 and p.enabled and p.archived_at is null limit 1',
          [ctx.organizationId, id],
        );
        if (used.rowCount)
          throw new ConfigurationError(
            409,
            'Desabilite os planos deste sistema antes de arquivá-lo.',
          );
      }),
    restore: (id: string, input: unknown) =>
      setArchived(ctx, 'system_profiles', id, input, false, get, async (client) => {
        const old = await get(id, client);
        await activeReference(client, ctx, 'servers', old.serverId);
      }),
  };
}
