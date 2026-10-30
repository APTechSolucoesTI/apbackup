import { createResourcePlan } from './resource-plan.server.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import {
  postgresConnectionInputSchema,
  postgresConnectionSchema,
  postgresSelectionSchema,
  postgresPlanSchema,
  postgresSourceDatabaseSchema,
  profileVersionSchema,
  uuidSchema,
} from '@apbackup/contracts';
import { runtimeTransaction } from '../../../../packages/db/src/repositories/jobs.js';
import { encryptSecret } from '../../../../packages/security/src/vault.js';
import {
  authorize,
  AccessError,
  type SessionPrincipal,
} from '../../../../packages/security/src/authorization.js';
import { ConfigurationError } from '../../../../packages/db/src/repositories/shared.js';
import {
  readPostgresConnection,
  postgresClient,
  assertApprovedPostgresHost,
} from '../../../../packages/connectors/src/postgresql-connection.js';
import {
  discoverPostgresSchemas,
  inspectPostgresSchemaScope,
} from '../../../../packages/connectors/src/postgresql-schemas.js';
export function createPostgresApi(
  db: PlatformDatabase,
  requireSession: (request: Request) => Promise<SessionPrincipal>,
  baseURL: string,
) {
  return async (request: Request) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const actor = await requireSession(request),
        org = actor.organizationId,
        url = new URL(request.url),
        path = url.pathname.replace('/api/postgresql', '');
      authorize(actor, request.method === 'GET' ? 'read' : 'configure', actor);
      if (request.method !== 'GET' && request.headers.get('origin') !== new URL(baseURL).origin)
        throw new AccessError(403);
      const input = async () => {
        const text = await request.text();
        if (Buffer.byteLength(text) > 16384)
          throw new ConfigurationError(400, 'Formulário muito grande.');
        return JSON.parse(text || '{}') as unknown;
      };
      if (path === '/connections' && request.method === 'GET') {
        const rows = (
          await db.pool.query(
            'select id,server_id as "serverId",configuration from connections where organization_id=$1 and kind=\'postgresql\' order by created_at desc',
            [org],
          )
        ).rows;
        return Response.json(
          {
            items: rows.map((row) =>
              postgresConnectionSchema.parse({
                ...row.configuration,
                id: row.id,
                serverId: row.serverId,
              }),
            ),
          },
          { headers },
        );
      }
      if (path === '/connections' && request.method === 'POST') {
        const v = postgresConnectionInputSchema.parse(await input());
        if (v.transport === 'docker_exec')
          throw new ConfigurationError(
            409,
            'Conexões Docker locais são configuradas pelo instalador administrativo no servidor do agente. A descoberta pela aplicação web não executa Docker.',
          );
        try {
          assertApprovedPostgresHost(v.host);
        } catch {
          throw new ConfigurationError(
            400,
            'O host precisa estar na lista de origens aprovadas pelo administrador.',
          );
        }
        if (v.sslMode === 'disable' && !['127.0.0.1', 'localhost'].includes(v.host))
          throw new ConfigurationError(400, 'Use TLS para conexões fora deste computador.');
        const id = randomUUID(),
          reference = randomUUID(),
          { password, ...configuration } = v;
        const envelope = encryptSecret(password, {
          organizationId: org,
          reference,
          purpose: 'postgresql-connection',
        });
        await runtimeTransaction(db, async (c) => {
          if (
            !(
              await c.query(
                'select id from servers where organization_id=$1 and id=$2 and archived_at is null',
                [org, v.serverId],
              )
            ).rowCount
          )
            throw new ConfigurationError(404, 'Servidor não encontrado.');
          await c.query(
            'insert into secret_references(id,organization_id,name,ciphertext,key_reference,algorithm,version) values($1,$2,$3,$4,$5,$6,$7)',
            [
              reference,
              org,
              `postgresql:${id}`,
              JSON.stringify(envelope),
              envelope.keyReference,
              envelope.algorithm,
              envelope.version,
            ],
          );
          await c.query(
            "insert into connections(id,organization_id,server_id,kind,endpoint,secret_reference_id,configuration) values($1,$2,$3,'postgresql',$4,$5,$6)",
            [id, org, v.serverId, `${v.host}:${v.port}`, reference, JSON.stringify(configuration)],
          );
        });
        return Response.json(postgresConnectionSchema.parse({ ...configuration, id }), {
          status: 201,
          headers,
        });
      }
      async function discover(id: string) {
        const config = await readPostgresConnection(db, org, uuidSchema.parse(id));
        if (!config) throw new ConfigurationError(404, 'Conexão não encontrada.');
        if (config.transport === 'docker_exec')
          throw new ConfigurationError(
            409,
            'A descoberta Docker local deve ser validada no servidor pelo instalador administrativo; o servidor web não acessa o socket Docker do agente.',
          );
        assertApprovedPostgresHost(config.host);
        const client = postgresClient(config, 'postgres');
        try {
          await client.connect();
          const version = (
            await client.query<{ version: string }>(
              "select current_setting('server_version_num') as version",
            )
          ).rows[0]!.version;
          if (Math.floor(Number(version) / 10000) !== 17)
            throw new ConfigurationError(
              409,
              'Este agente suporta PostgreSQL 17. Configure um runtime compatível antes de continuar.',
            );
          const rows = (
            await client.query<{ name: string }>(
              "select datname as name from pg_database where not datistemplate and datallowconn and has_database_privilege(current_user,oid,'CONNECT') order by datname",
            )
          ).rows;
          return {
            config,
            databases: rows.filter((r) => postgresSourceDatabaseSchema.safeParse(r.name).success),
            serverMajor: 17,
          };
        } catch (error) {
          if (error instanceof ConfigurationError) throw error;
          throw new ConfigurationError(
            409,
            'Não foi possível conectar. Verifique acesso, senha, certificado e permissões.',
          );
        } finally {
          await client.end().catch(() => {});
        }
      }
      const discovery = /^\/connections\/([^/]+)\/discover$/.exec(path);
      if (discovery && request.method === 'POST') {
        z.strictObject({}).parse(await input());
        const result = await discover(discovery[1]!);
        return Response.json(
          { databases: result.databases, serverMajor: result.serverMajor },
          { headers },
        );
      }
      const schemaDiscovery = /^\/connections\/([^/]+)\/schemas$/.exec(path);
      if (schemaDiscovery && request.method === 'POST') {
        const v = z.strictObject({ database: postgresSourceDatabaseSchema }).parse(await input());
        const found = await discover(schemaDiscovery[1]!);
        if (!found.databases.some((d) => d.name === v.database))
          throw new ConfigurationError(404, 'Banco não acessível.');
        const client = postgresClient(found.config, v.database);
        try {
          await client.connect();
          return Response.json(
            {
              schemas: await discoverPostgresSchemas(client),
              limitation:
                'Dependências de auth/storage/vault, extensões e papéis exigem revisão manual. SQL dinâmico e integrações externas não são inferidos.',
            },
            { headers },
          );
        } finally {
          await client.end().catch(() => {});
        }
      }
      if (path === '/select' && request.method === 'POST') {
        const v = postgresSelectionSchema.parse(await input()),
          found = await discover(v.connectionId);
        if (!found.databases.some((d) => d.name === v.database))
          throw new ConfigurationError(404, 'Banco não acessível nesta conexão.');
        if (v.schemas.length) {
          const client = postgresClient(found.config, v.database);
          try {
            await client.connect();
            const scope = await inspectPostgresSchemaScope(client, v.schemas);
            if (!scope.isolated)
              throw new ConfigurationError(
                409,
                `Dependências fora do escopo: ${scope.dependencies.slice(0, 5).join('; ')}. Reconstrua e valide essas dependências manualmente.`,
              );
          } finally {
            await client.end().catch(() => {});
          }
        }
        const result = await runtimeTransaction(db, async (c) => {
          await c.query(
            'select id from connections where organization_id=$1 and id=$2 for update',
            [org, v.connectionId],
          );
          const existing = (
            await c.query(
              'select profile_version_id as "profileVersionId",resource_id as "resourceId" from postgresql_bindings where organization_id=$1 and connection_id=$2 and database_name=$3 and schema_names=$4',
              [org, v.connectionId, v.database, v.schemas],
            )
          ).rows[0];
          if (existing) return existing;
          const resourceId = randomUUID(),
            profileId = randomUUID(),
            profileVersionId = randomUUID();
          await c.query(
            "insert into resources(id,organization_id,server_id,kind,name,external_identity) values($1,$2,$3,'postgresql',$4,$5)",
            [
              resourceId,
              org,
              found.config.serverId,
              v.schemas.length ? `${v.database} · ${v.schemas.join(', ')}` : v.database,
              `postgresql:${v.connectionId}:${v.database}:${v.schemas.join(',')}`,
            ],
          );
          await c.query(
            'insert into system_profiles(id,organization_id,server_id,name,external_identity) values($1,$2,$3,$4,$5)',
            [profileId, org, found.config.serverId, v.database, `database:${resourceId}`],
          );
          const definition = profileVersionSchema.parse({
            profileId,
            version: 1,
            adapter: { name: 'postgresql', version: '1.0.0' },
            consistency: 'transactional',
            resources: [{ resourceId, required: true }],
            dependencies: [],
            restoreCapabilities: ['database'],
          });
          await c.query(
            'insert into profile_versions(id,organization_id,profile_id,version,definition) values($1,$2,$3,1,$4)',
            [profileVersionId, org, profileId, JSON.stringify(definition)],
          );
          await c.query(
            'insert into profile_resources(organization_id,profile_version_id,resource_id,required) values($1,$2,$3,true)',
            [org, profileVersionId, resourceId],
          );
          await c.query(
            'insert into postgresql_bindings(organization_id,profile_version_id,resource_id,connection_id,database_name,schema_names) values($1,$2,$3,$4,$5,$6)',
            [org, profileVersionId, resourceId, v.connectionId, v.database, v.schemas],
          );
          return { profileVersionId, resourceId };
        });
        return Response.json(result, { status: 201, headers });
      }
      if (path === '/plans' && request.method === 'POST') {
        const v = postgresPlanSchema.parse(await input());
        if (
          !(
            await db.pool.query(
              'select 1 from postgresql_bindings where organization_id=$1 and profile_version_id=$2',
              [org, v.profileVersionId],
            )
          ).rowCount
        )
          throw new ConfigurationError(404, 'Banco não encontrado.');
        return Response.json(await createResourcePlan(db, org, v), { status: 201, headers });
      }
      if (path === '/overview' && request.method === 'GET') {
        const profileVersionId = uuidSchema
          .optional()
          .parse(new URL(request.url).searchParams.get('profileVersionId') ?? undefined);
        const plans = (
          await db.pool.query(
            `select p.id,p.name,b.database_name as database,p.enabled,s.enabled as "scheduleEnabled",to_char(s.local_time,'HH24:MI') as "localTime",s.timezone,(select jsonb_build_object('id',e.id,'status',e.status) from executions e where e.organization_id=p.organization_id and e.plan_id=p.id order by e.created_at desc,e.id limit 1) as latest from plans p join postgresql_bindings b on b.organization_id=p.organization_id and b.profile_version_id=p.profile_version_id join schedules s on s.organization_id=p.organization_id and s.plan_id=p.id where p.organization_id=$1 and ($2::uuid is null or p.profile_version_id=$2) and p.archived_at is null order by p.created_at desc limit 100`,
            [org, profileVersionId ?? null],
          )
        ).rows;
        const points = (
          await db.pool.query(
            `select p.id,b.database_name as database,p.captured_at as "capturedAt",d.native_snapshot_id as "snapshotId",d.verification_scope as verification,coalesce((d.postgresql_evidence->>'requiresCompatibleCluster')::boolean,false) as "requiresCompatibleCluster" from recovery_points p join postgresql_bindings b on b.organization_id=p.organization_id and b.profile_version_id=p.profile_version_id join lateral(select dr.* from destination_results dr where dr.organization_id=p.organization_id and dr.recovery_point_id=p.id and dr.status='concluida' and dr.verified_at is not null and dr.removed_at is null and not dr.retention_pending order by dr.id limit 1)d on true where p.organization_id=$1 and ($2::uuid is null or p.profile_version_id=$2) and p.status='complete' and d.status='concluida' and d.verified_at is not null order by p.captured_at desc limit 100`,
            [org, profileVersionId ?? null],
          )
        ).rows;
        const restores = (
          await db.pool.query(
            `select e.id,r.scope->>'targetDatabase' as database,e.status from restore_requests r join executions e on e.organization_id=r.organization_id and e.id=r.execution_id where r.organization_id=$1 and ($2::uuid is null or e.profile_version_id=$2) and r.scope->>'kind'='postgresql_restore' order by e.created_at desc limit 100`,
            [org, profileVersionId ?? null],
          )
        ).rows;
        return Response.json({ plans, points, restores }, { headers });
      }
      return Response.json({ error: 'Página não encontrada.' }, { status: 404, headers });
    } catch (error) {
      if (error instanceof AccessError || error instanceof ConfigurationError)
        return Response.json({ error: error.message }, { status: error.status, headers });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json({ error: 'Revise os campos informados.' }, { status: 400, headers });
      return Response.json(
        { error: 'Não foi possível concluir. Verifique a configuração e tente novamente.' },
        { status: 409, headers },
      );
    }
  };
}
