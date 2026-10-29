import {
  planInputSchema,
  planUpdateSchema,
  planReadSchema,
  profileReadSchema,
  connectorCapabilitiesSchema,
  type PlanInput,
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
export function createPlansRepository(ctx: RepositoryContext) {
  async function get(id: string, client: PoolClient | typeof ctx.db.pool = ctx.db.pool) {
    const row = (
      await client.query(
        `select ${baseFields()},t.server_id as "serverId",t.profile_version_id as "profileVersionId",t.enabled,jsonb_build_object('days',r.days,'evidenceDays',r.evidence_days,'protectLastVerified',r.protect_last_verified) as retention,jsonb_build_object('localTime',to_char(s.local_time,'HH24:MI'),'timezone',s.timezone,'enabled',s.enabled) as schedule,coalesce((select jsonb_agg(jsonb_build_object('destinationId',rep.destination_id,'repositoryId',pd.repository_id,'required',pd.required) order by pd.created_at,pd.id) from plan_destinations pd join repositories rep on rep.organization_id=pd.organization_id and rep.id=pd.repository_id where pd.organization_id=t.organization_id and pd.plan_id=t.id),'[]'::jsonb) as destinations from plans t join retention_policies r on r.organization_id=t.organization_id and r.id=t.retention_policy_id join schedules s on s.organization_id=t.organization_id and s.plan_id=t.id where t.organization_id=$1 and t.id=$2`,
        [ctx.organizationId, id],
      )
    ).rows[0];
    if (!row)
      throw new ConfigurationError(404, 'Plano não encontrado ou ainda sem configuração completa.');
    return planReadSchema.parse(row);
  }
  async function prepare(client: PoolClient, v: PlanInput) {
    const profileRow = (
      await client.query(
        `select ${baseFields('p')},p.server_id as "serverId",p.external_identity as "externalIdentity",pv.id as "versionId",pv.version,pv.definition from profile_versions pv join system_profiles p on p.organization_id=pv.organization_id and p.id=pv.profile_id where pv.organization_id=$1 and pv.id=$2 and p.archived_at is null for share of p,pv`,
        [ctx.organizationId, v.profileVersionId],
      )
    ).rows[0];
    if (!profileRow)
      throw new ConfigurationError(
        404,
        'A versão do sistema não foi encontrada ou está arquivada.',
      );
    const profile = profileReadSchema.parse(profileRow);
    await activeReference(client, ctx, 'servers', profile.serverId);
    for (const resource of profile.definition.resources)
      await activeReference(client, ctx, 'resources', resource.resourceId);
    const ids = new Set<string>(),
      repositories: { repositoryId: string; destinationId: string; required: boolean }[] = [];
    if (!v.destinations.some((d) => d.required))
      throw new ConfigurationError(400, 'Selecione pelo menos um destino obrigatório.', {
        destinations: 'Defina um destino obrigatório.',
      });
    for (const selected of v.destinations) {
      if (ids.has(selected.destinationId))
        throw new ConfigurationError(400, 'Não repita destinos no plano.');
      ids.add(selected.destinationId);
      await activeReference(client, ctx, 'destinations', selected.destinationId);
      const actual = (
        await client.query<{
          repositoryId: string;
          engine: string | null;
          status: string;
          root_path: string | null;
          credential_id: string | null;
          capabilities: unknown;
        }>(
          `select r.id as "repositoryId",r.engine,d.status,d.root_path,d.credential_id,(select c.capabilities from connector_capabilities c where c.organization_id=d.organization_id and c.destination_id=d.id and c.configuration_revision=d.configuration_revision order by c.assessed_at desc,c.id desc limit 1) as capabilities from destinations d join lateral(select id,engine from repositories where organization_id=d.organization_id and destination_id=d.id order by created_at,id limit 1) r on true where d.organization_id=$1 and d.id=$2 for share of d`,
          [ctx.organizationId, selected.destinationId],
        )
      ).rows[0];
      if (!actual) throw new ConfigurationError(404, 'Repositório do destino não encontrado.');
      if (v.enabled && selected.required) {
        if (
          actual.status !== 'ativo' ||
          !actual.engine ||
          !actual.root_path ||
          !actual.credential_id
        )
          throw new ConfigurationError(
            409,
            'Um destino obrigatório aguarda configuração. Salve o plano desabilitado.',
            { enabled: 'Configure todos os destinos obrigatórios.' },
          );
        const assessed = connectorCapabilitiesSchema.safeParse(actual.capabilities);
        if (!assessed.success || !assessed.data.encrypted || !assessed.data.platformRetention)
          throw new ConfigurationError(
            409,
            'O conector ainda não comprovou criptografia e retenção controlada pela plataforma na configuração atual. Salve o plano desabilitado.',
            { enabled: 'Aguardando avaliação real do conector.' },
          );
      }
      repositories.push({ repositoryId: actual.repositoryId, ...selected });
    }
    return { profile, repositories };
  }
  async function links(
    client: PoolClient,
    id: string,
    v: PlanInput,
    prepared: Awaited<ReturnType<typeof prepare>>,
    retentionId: string,
  ) {
    await client.query('delete from plan_resources where organization_id=$1 and plan_id=$2', [
      ctx.organizationId,
      id,
    ]);
    await client.query('delete from plan_destinations where organization_id=$1 and plan_id=$2', [
      ctx.organizationId,
      id,
    ]);
    for (const resource of prepared.profile.definition.resources)
      await client.query(
        'insert into plan_resources(organization_id,plan_id,resource_id) values($1,$2,$3)',
        [ctx.organizationId, id, resource.resourceId],
      );
    for (const destination of prepared.repositories)
      await client.query(
        'insert into plan_destinations(organization_id,plan_id,repository_id,required) values($1,$2,$3,$4)',
        [ctx.organizationId, id, destination.repositoryId, destination.required],
      );
    await client.query(
      'update retention_policies set days=$3,evidence_days=$4,protect_last_verified=true where organization_id=$1 and id=$2',
      [ctx.organizationId, retentionId, v.retention.days, v.retention.evidenceDays],
    );
    await client.query('delete from schedules where organization_id=$1 and plan_id=$2', [
      ctx.organizationId,
      id,
    ]);
    await client.query(
      'insert into schedules(organization_id,plan_id,local_time,timezone,enabled) values($1,$2,$3,$4,$5)',
      [ctx.organizationId, id, v.schedule.localTime, v.schedule.timezone, v.enabled],
    );
  }
  return {
    get,
    async create(input: unknown) {
      const v = planInputSchema.parse(input);
      return transaction(ctx, async (client) => {
        const prepared = await prepare(client, v);
        const retentionId = (
          await client.query<{ id: string }>(
            'insert into retention_policies(organization_id,name,days,evidence_days,protect_last_verified) values($1,$2,$3,$4,true) returning id',
            [ctx.organizationId, v.name, v.retention.days, v.retention.evidenceDays],
          )
        ).rows[0]!.id;
        const id = (
          await client.query<{ id: string }>(
            'insert into plans(organization_id,server_id,profile_version_id,retention_policy_id,name,enabled) values($1,$2,$3,$4,$5,$6) returning id',
            [
              ctx.organizationId,
              prepared.profile.serverId,
              v.profileVersionId,
              retentionId,
              v.name,
              v.enabled,
            ],
          )
        ).rows[0]!.id;
        await links(client, id, v, prepared, retentionId);
        await audit(client, ctx, 'plan', id, 'create');
        return get(id, client);
      });
    },
    async update(id: string, input: unknown) {
      const v = planUpdateSchema.parse(input);
      return transaction(ctx, async (client) => {
        await lockRecord(client, ctx, 'plans', id, { expectedUpdatedAt: v.expectedUpdatedAt });
        const prepared = await prepare(client, v);
        const retention = (
          await client.query<{ retention_policy_id: string }>(
            'select retention_policy_id from plans where organization_id=$1 and id=$2',
            [ctx.organizationId, id],
          )
        ).rows[0]!;
        await client.query(
          'update plans set name=$3,server_id=$4,profile_version_id=$5,enabled=$6 where organization_id=$1 and id=$2',
          [
            ctx.organizationId,
            id,
            v.name,
            prepared.profile.serverId,
            v.profileVersionId,
            v.enabled,
          ],
        );
        await links(client, id, v, prepared, retention.retention_policy_id);
        await audit(client, ctx, 'plan', id, 'update');
        return get(id, client);
      });
    },
    archive: (id: string, input: unknown) => setArchived(ctx, 'plans', id, input, true, get),
    restore: (id: string, input: unknown) =>
      setArchived(ctx, 'plans', id, input, false, get, async (client) => {
        const row = await get(id, client);
        await activeReference(client, ctx, 'servers', row.serverId);
      }),
  };
}
