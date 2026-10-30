import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import {
  dockerCatalogSchema,
  dockerSelectionSchema,
  dockerRestoreInputSchema,
  dockerEvidenceSchema,
  postgresPlanSchema,
  profileVersionSchema,
  uuidSchema,
} from '@apbackup/contracts';
import {
  runtimeTransaction,
  createExecutionStore,
} from '../../../../packages/db/src/repositories/jobs.js';
import { verifiedPoints } from '../../../../packages/db/src/repositories/coverage.js';
import { encryptSecret } from '../../../../packages/security/src/vault.js';
import {
  authorize,
  AccessError,
  type SessionPrincipal,
} from '../../../../packages/security/src/authorization.js';
import { ConfigurationError } from '../../../../packages/db/src/repositories/shared.js';
import { createResourcePlan } from './resource-plan.server.js';
export function createDockerApi(
  db: PlatformDatabase,
  requireSession: (r: Request) => Promise<SessionPrincipal>,
  baseURL: string,
) {
  return async (request: Request) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const actor = await requireSession(request),
        org = actor.organizationId,
        url = new URL(request.url),
        path = url.pathname.replace('/api/docker', '');
      authorize(
        actor,
        request.method === 'GET' ? 'read' : path === '/restore' ? 'restore' : 'configure',
        actor,
      );
      if (request.method !== 'GET' && request.headers.get('origin') !== new URL(baseURL).origin)
        throw new AccessError(403);
      const input = async () => {
        const text = await request.text();
        if (Buffer.byteLength(text) > 16384)
          throw new ConfigurationError(400, 'Formulário muito grande.');
        return JSON.parse(text || '{}') as unknown;
      };
      async function catalog(serverId: string) {
        const row = (
          await db.pool.query<{ body: unknown; received_at: Date }>(
            `select d.body,d.received_at from docker_catalogs d join agents a on a.organization_id=d.organization_id and a.id=d.agent_id where d.organization_id=$1 and d.server_id=$2 and a.revoked_at is null order by d.received_at desc limit 1`,
            [org, serverId],
          )
        ).rows[0];
        if (!row || +row.received_at < Date.now() - 120000)
          throw new ConfigurationError(
            409,
            'Aguarde um agente Docker conectado atualizar a descoberta.',
          );
        return dockerCatalogSchema.parse(row.body);
      }
      if (path === '/catalog' && request.method === 'GET')
        return Response.json(await catalog(uuidSchema.parse(url.searchParams.get('serverId'))), {
          headers,
        });
      if (path === '/select' && request.method === 'POST') {
        const v = dockerSelectionSchema.parse(await input()),
          found = await catalog(v.serverId);
        if (v.kind === 'volume') {
          const volume = found.volumes.find((i) => i.name === v.identity);
          if (!volume || volume.databaseHint)
            throw new ConfigurationError(
              409,
              'Volume indisponível ou de banco. Use o conector lógico para dados de banco.',
            );
        }
        if (v.kind === 'directory' && !found.directories.some((i) => i.name === v.identity))
          throw new ConfigurationError(404, 'Diretório aprovado não encontrado.');
        if (v.kind === 'container') {
          const container = found.containers.find((i) => i.name === v.identity);
          if (!container) throw new ConfigurationError(404, 'Container não encontrado.');
          if (container.blockedReason) throw new ConfigurationError(409, container.blockedReason);
        }
        if (
          v.kind === 'compose' &&
          v.containers!.some(
            (s) =>
              !found.containers.some(
                (c) =>
                  c.name === s.name &&
                  c.composeProject === v.identity &&
                  c.composeService === s.service &&
                  s.preserveEnvironmentKeys.every((key) => c.environmentKeys?.includes(key)),
              ),
          )
        )
          throw new ConfigurationError(
            409,
            'O projeto ou serviço Compose mudou. Atualize a descoberta e revise o grupo.',
          );
        if (
          v.kind === 'swarm' &&
          v.services?.some(
            (s) =>
              !found.services.some(
                (f) =>
                  f.id === s.id &&
                  f.version !== undefined &&
                  s.preserveEnvironmentKeys.every((k) => f.environmentKeys?.includes(k)),
              ),
          )
        )
          throw new ConfigurationError(
            409,
            'Serviços ou chaves de ambiente indisponíveis. Atualize a descoberta.',
          );
        const result = await runtimeTransaction(db, async (c) => {
          await c.query('select id from servers where organization_id=$1 and id=$2 for update', [
            org,
            v.serverId,
          ]);
          const existing = (
            await c.query(
              'select resource_id as "resourceId",profile_version_id as "profileVersionId" from docker_bindings where organization_id=$1 and server_id=$2 and selection=$3',
              [org, v.serverId, JSON.stringify(v)],
            )
          ).rows[0];
          if (existing) return existing;
          const resourceId = randomUUID(),
            profileId = randomUUID(),
            profileVersionId = randomUUID();
          await c.query(
            "insert into resources(id,organization_id,server_id,kind,name,external_identity) values($1,$2,$3,'files',$4,$5)",
            [
              resourceId,
              org,
              v.serverId,
              v.identity,
              `docker:${v.serverId}:${v.kind}:${v.identity}`,
            ],
          );
          await c.query(
            'insert into system_profiles(id,organization_id,server_id,name,external_identity) values($1,$2,$3,$4,$5)',
            [profileId, org, v.serverId, v.identity, `resource:${resourceId}`],
          );
          const definition = profileVersionSchema.parse({
            profileId,
            version: 1,
            adapter: { name: 'docker-resource', version: '1.0.0' },
            consistency: 'crash_consistent',
            resources: [{ resourceId, required: true }],
            dependencies: [],
            restoreCapabilities: ['files'],
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
            'insert into docker_bindings(organization_id,profile_version_id,resource_id,server_id,selection) values($1,$2,$3,$4,$5)',
            [org, profileVersionId, resourceId, v.serverId, JSON.stringify(v)],
          );
          return { resourceId, profileVersionId };
        });
        return Response.json(result, { headers, status: 201 });
      }
      if (path === '/plans' && request.method === 'POST') {
        const v = postgresPlanSchema.parse(await input());
        if (
          !(
            await db.pool.query(
              'select 1 from docker_bindings where organization_id=$1 and profile_version_id=$2',
              [org, v.profileVersionId],
            )
          ).rowCount
        )
          throw new ConfigurationError(404, 'Recurso não encontrado.');
        return Response.json(await createResourcePlan(db, org, v), { status: 201, headers });
      }
      if (path === '/restore' && request.method === 'POST') {
        const v = dockerRestoreInputSchema.parse(await input());
        if (
          !(
            await verifiedPoints({
              db,
              organizationId: org,
              actorId: actor.userId,
              vault: { encryptSecret },
            })
          ).some((p) => p.id === v.recoveryPointId)
        )
          throw new ConfigurationError(409, 'Selecione um ponto íntegro e verificado.');
        const executionId = await runtimeTransaction(db, async (c) => {
          const point = (
            await c.query<{
              profile_version_id: string;
              repository_id: string;
              docker_evidence: unknown;
            }>(
              `select p.profile_version_id,d.repository_id,d.docker_evidence from recovery_points p join destination_results d on d.organization_id=p.organization_id and d.recovery_point_id=p.id join repositories r on r.organization_id=d.organization_id and r.id=d.repository_id where p.organization_id=$1 and p.id=$2 and p.status='complete' and d.status='concluida' and d.removed_at is null and not d.retention_pending and ($3::uuid is null or d.repository_id=$3) and d.verified_at is not null and r.native_repository_id=d.docker_evidence->>'nativeRepositoryId' order by d.id limit 1 for share of p,d`,
              [org, v.recoveryPointId, v.repositoryId ?? null],
            )
          ).rows[0];
          if (!point) throw new ConfigurationError(409, 'Ponto Docker indisponível.');
          const proof = dockerEvidenceSchema.parse(point.docker_evidence);
          if (
            ['container', 'swarm', 'compose'].includes(proof.selection.kind) &&
            (!v.replaceContainer || v.targetName !== proof.selection.identity)
          )
            throw new ConfigurationError(
              400,
              'Confirme a substituição somente da aplicação selecionada. Banco é uma ação independente.',
            );
          if (
            !['container', 'swarm', 'compose'].includes(proof.selection.kind) &&
            v.replaceContainer
          )
            throw new ConfigurationError(400, 'Recurso de arquivos exige um destino novo.');
          let targetContainerId: string | null = null;
          let targetServices: { id: string; version: number }[] | undefined;
          let targetContainers: { id: string; name: string }[] | undefined;
          if (proof.selection.kind === 'compose') {
            if (!v.redeployGuardConfirmed)
              throw new ConfigurationError(
                409,
                'Pause os redeploys externos e confirme o procedimento antes do retorno.',
              );
            const current = await catalog(proof.selection.serverId);
            targetContainers = proof.selection.containers!.map((s) => {
              const target = current.containers.find(
                (c) =>
                  c.name === s.name &&
                  c.composeProject === proof.selection.identity &&
                  c.composeService === s.service,
              );
              if (!target)
                throw new ConfigurationError(
                  409,
                  'Container Compose alvo indisponível ou identidade alterada.',
                );
              return { id: target.id, name: target.name };
            });
          }
          if (proof.selection.kind === 'swarm') {
            if (!v.redeployGuardConfirmed)
              throw new ConfigurationError(
                409,
                'Prepare o bloqueio de redeploy externo e confirme o procedimento antes do retorno.',
              );
            const current = await catalog(proof.selection.serverId);
            targetServices = proof.selection.services!.map((s) => {
              const target = current.services.find((f) => f.id === s.id);
              if (!target || target.version === undefined)
                throw new ConfigurationError(409, 'Serviço alvo indisponível.');
              return { id: s.id, version: target.version };
            });
          }
          if (proof.selection.kind === 'container') {
            const target = (await catalog(proof.selection.serverId)).containers.find(
              (i) => i.name === v.targetName,
            );
            if (!target || target.blockedReason)
              throw new ConfigurationError(
                409,
                target?.blockedReason ?? 'Container alvo indisponível.',
              );
            targetContainerId = target.id;
          }
          const scope = {
            kind: 'docker_restore',
            repositoryId: point.repository_id,
            recoveryPointId: v.recoveryPointId,
            snapshotId: proof.snapshotId,
            nativeRepositoryId: proof.nativeRepositoryId,
            sha256: proof.sha256,
            targetName: v.targetName,
            replaceContainer: v.replaceContainer,
            targetContainerId,
            ...(targetServices ? { targetServices, redeployGuardConfirmed: true } : {}),
            ...(targetContainers ? { targetContainers, redeployGuardConfirmed: true } : {}),
          };
          const previous = (
            await c.query<{ id: string; scope: unknown }>(
              `select e.id,r.scope from executions e join restore_requests r on r.organization_id=e.organization_id and r.execution_id=e.id where e.organization_id=$1 and e.idempotency_key=$2`,
              [org, `docker-restore:${v.idempotencyKey}`],
            )
          ).rows[0];
          if (previous) {
            const prior = z
              .object({
                recoveryPointId: z.string(),
                repositoryId: z.string(),
                targetName: z.string(),
                replaceContainer: z.boolean(),
              })
              .parse(previous.scope);
            if (
              prior.recoveryPointId !== v.recoveryPointId ||
              prior.targetName !== v.targetName ||
              (v.repositoryId !== undefined && prior.repositoryId !== v.repositoryId) ||
              prior.replaceContainer !== v.replaceContainer
            )
              throw new ConfigurationError(409, 'Esta solicitação já possui outro destino.');
            return previous.id;
          }
          const id = randomUUID();
          await c.query(
            "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1,$2,'restore',$3,$4)",
            [id, org, `docker-restore:${v.idempotencyKey}`, point.profile_version_id],
          );
          await c.query(
            "insert into restore_requests(organization_id,execution_id,recovery_point_id,requested_by,scope,production,status) values($1,$2,$3,$4,$5,false,'aguardando')",
            [org, id, v.recoveryPointId, actor.userId, JSON.stringify(scope)],
          );
          await c.query('insert into execution_jobs(organization_id,execution_id) values($1,$2)', [
            org,
            id,
          ]);
          await createExecutionStore(db).append(c, {
            organizationId: org,
            executionId: id,
            key: 'enqueued',
            code: 'restore_queued',
            status: 'aguardando',
          });
          return id;
        });
        return Response.json({ executionId }, { headers });
      }
      if (path === '/overview' && request.method === 'GET') {
        const profileVersionId = url.searchParams.has('profileVersionId')
          ? uuidSchema.parse(url.searchParams.get('profileVersionId'))
          : null;
        const plans = (
          await db.pool.query(
            `select p.id,p.name,b.selection,(select jsonb_build_object('id',e.id,'status',e.status) from executions e where e.organization_id=p.organization_id and e.plan_id=p.id order by e.created_at desc,e.id limit 1) as latest from plans p join docker_bindings b on b.organization_id=p.organization_id and b.profile_version_id=p.profile_version_id where p.organization_id=$1 and p.archived_at is null and ($2::uuid is null or p.profile_version_id=$2) order by p.created_at desc limit 100`,
            [org, profileVersionId],
          )
        ).rows;
        const points = (
          await db.pool.query(
            `select p.id,b.selection,p.captured_at as "capturedAt",d.docker_evidence as evidence from recovery_points p join docker_bindings b on b.organization_id=p.organization_id and b.profile_version_id=p.profile_version_id join lateral (select x.docker_evidence from destination_results x where x.organization_id=p.organization_id and x.recovery_point_id=p.id and x.status='concluida' and x.verified_at is not null and x.removed_at is null and not x.retention_pending and x.docker_evidence is not null order by x.verified_at desc,x.id limit 1) d on true where p.organization_id=$1 and p.status='complete' and ($2::uuid is null or p.profile_version_id=$2) order by p.captured_at desc,p.id limit 100`,
            [org, profileVersionId],
          )
        ).rows;
        const restores = (
          await db.pool.query(
            `select e.id,r.scope->>'targetName' as "targetName",e.status,x.evidence from restore_requests r join executions e on e.organization_id=r.organization_id and e.id=r.execution_id left join restore_results x on x.organization_id=r.organization_id and x.request_id=r.id where r.organization_id=$1 and r.scope->>'kind'='docker_restore' and ($2::uuid is null or e.profile_version_id=$2) order by e.created_at desc limit 100`,
            [org, profileVersionId],
          )
        ).rows;
        return Response.json({ plans, points, restores }, { headers });
      }
      return Response.json({ error: 'Página não encontrada.' }, { headers, status: 404 });
    } catch (e) {
      if (e instanceof AccessError || e instanceof ConfigurationError)
        return Response.json({ error: e.message }, { status: e.status, headers });
      if (e instanceof z.ZodError || e instanceof SyntaxError)
        return Response.json({ error: 'Revise os campos informados.' }, { status: 400, headers });
      return Response.json(
        { error: 'Não foi possível concluir. Confira o agente e tente novamente.' },
        { status: 409, headers },
      );
    }
  };
}
