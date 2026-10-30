import { repositoryApi } from './repository.server.js';
import { resolveRepositoryCommand } from '../../../../packages/connectors/src/repository-context.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  uuidSchema,
  agentCommandSchema,
  canonicalJson,
  postgresDatabaseNameSchema,
  postgresEvidenceSchema,
} from '@apbackup/contracts';
import { resolvePostgresCommand } from '../../../../packages/connectors/src/postgresql-connection.js';
import { resolveDockerCommand } from '../../../../packages/connectors/src/docker-context.js';
import { dockerCatalogSchema } from '@apbackup/contracts';
import { verifiedPoints } from '../../../../packages/db/src/repositories/coverage.js';
import { encryptSecret } from '../../../../packages/security/src/vault.js';
import type { PlatformDatabase } from '@apbackup/db';
import { ConfigurationError } from '../../../../packages/db/src/repositories/shared.js';
import { createAgentRegistry } from '../../../../apps/agent/src/enrollment.js';
import {
  createExecutionStore,
  runtimeTransaction,
} from '../../../../packages/db/src/repositories/jobs.js';
import { acceptAgentResult } from '../../../../apps/coordinator/src/reconciler.js';
import {
  authorize,
  AccessError,
  type SessionPrincipal,
} from '../../../../packages/security/src/authorization.js';
async function body(request: Request): Promise<unknown> {
  let total = 0;
  const parts: Uint8Array[] = [];
  for await (const part of request.body ?? []) {
    total += part.byteLength;
    if (total > 1048576) throw new Error('Request too large');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as unknown;
}
export function createRuntimeApi(
  db: PlatformDatabase,
  requireSession: (r: Request) => Promise<SessionPrincipal>,
  baseURL: string,
) {
  const registry = createAgentRegistry(db),
    store = createExecutionStore(db);
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/agents/enroll' && request.method === 'POST') {
        const value = z
          .strictObject({
            enrollment: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
            externalIdentity: z.string().min(1).max(128),
          })
          .parse(await body(request));
        try {
          return Response.json(await registry.enroll(value.enrollment, value.externalIdentity));
        } catch {
          throw new AccessError(401);
        }
      }
      if (
        [
          '/api/agents/poll',
          '/api/agents/results',
          '/api/agents/authorize',
          '/api/agents/postgresql-context',
          '/api/agents/docker-context',
          '/api/agents/repository-context',
          '/api/agents/docker-catalog',
        ].includes(path) &&
        request.method === 'POST'
      ) {
        const header = request.headers.get('authorization');
        if (!header?.startsWith('Bearer ')) throw new AccessError(401);
        let agent;
        try {
          agent = await registry.authenticate(header.slice(7));
        } catch {
          throw new AccessError(401);
        }
        if (path.endsWith('/docker-catalog')) {
          const catalog = dockerCatalogSchema.parse(await body(request));
          await db.pool.query(
            `insert into docker_catalogs(organization_id,agent_id,server_id,body) select organization_id,id,server_id,$3 from agents where organization_id=$1 and id=$2 and revoked_at is null on conflict(organization_id,agent_id) do update set body=excluded.body,received_at=now()`,
            [agent.organization_id, agent.id, JSON.stringify(catalog)],
          );
          return Response.json({ accepted: true });
        }
        if (
          path.endsWith('/authorize') ||
          path.endsWith('/postgresql-context') ||
          path.endsWith('/docker-context') ||
          path.endsWith('/repository-context')
        ) {
          const command = agentCommandSchema.parse(await body(request));
          const current = (
            await db.pool.query<{ body: unknown }>(
              `select c.body from agent_commands c join leases l on l.organization_id=c.organization_id and l.execution_id=c.execution_id and l.resource_id=c.resource_id and l.fencing_token=c.fencing_token join resource_fences f on f.organization_id=l.organization_id and f.resource_id=l.resource_id and f.highest=l.fencing_token join execution_jobs j on j.organization_id=l.organization_id and j.execution_id=l.execution_id and j.holder=l.holder join executions e on e.organization_id=c.organization_id and e.id=c.execution_id where c.id=$1 and c.agent_id=$2 and c.organization_id=$3 and c.state='delivered' and c.expires_at>now() and l.expires_at>now() and j.claim_until>now() and j.state='claimed' and e.profile_version_id=c.profile_version_id`,
              [command.commandId, agent.id, agent.organization_id],
            )
          ).rows[0];
          const allowed = Boolean(
            current && canonicalJson(current.body) === canonicalJson(command),
          );
          if (path.endsWith('/repository-context')) {
            if (!allowed) throw new AccessError(403);
            return Response.json(await resolveRepositoryCommand(db, command), {
              headers: { 'cache-control': 'no-store' },
            });
          }
          if (path.endsWith('/postgresql-context')) {
            if (!allowed) throw new AccessError(403);
            return Response.json(await resolvePostgresCommand(db, command), {
              headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
            });
          }
          if (path.endsWith('/docker-context')) {
            if (!allowed) throw new AccessError(403);
            return Response.json(await resolveDockerCommand(db, command), {
              headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
            });
          }
          return Response.json({ allowed });
        }
        if (path.endsWith('/results')) {
          await acceptAgentResult(db, agent.id, agent.organization_id, await body(request));
          return Response.json({ accepted: true });
        }
        z.strictObject({}).parse(await body(request));
        const commands = await runtimeTransaction(db, async (c) => {
          const rows = (
            await c.query<{ id: string; body: unknown; state: string; expires_at: Date }>(
              `select id,body,state,expires_at from agent_commands where organization_id=$1 and agent_id=$2 and state in('queued','delivered') order by created_at,id for update skip locked limit 16`,
              [agent.organization_id, agent.id],
            )
          ).rows;
          const output = [];
          for (const row of rows) {
            const command = agentCommandSchema.parse(row.body);
            if (row.state === 'queued') {
              const valid = await c.query(
                `select l.id from leases l join resources r on r.organization_id=l.organization_id and r.id=l.resource_id join agents a on a.organization_id=r.organization_id and a.server_id=r.server_id join executions e on e.organization_id=l.organization_id and e.id=l.execution_id where l.organization_id=$1 and l.execution_id=$2 and l.resource_id=$3 and l.fencing_token=$4 and l.expires_at>now() and a.id=$5 and a.revoked_at is null and e.profile_version_id=$6`,
                [
                  agent.organization_id,
                  command.executionId,
                  command.resourceId,
                  command.fencingToken,
                  agent.id,
                  command.profileVersionId,
                ],
              );
              if (!valid.rowCount || +row.expires_at <= Date.now()) continue;
              await c.query("update agent_commands set state='delivered' where id=$1", [row.id]);
            }
            output.push(command);
          }
          return output;
        });
        return Response.json({ commands });
      }
      const principal = await requireSession(request);
      if (request.method === 'POST' && request.headers.get('origin') !== new URL(baseURL).origin)
        throw new AccessError(403);
      const repositoryResponse = await repositoryApi(
        db,
        principal,
        path,
        request,
        request.method === 'POST' &&
          [
            '/api/runtime/replicate',
            '/api/runtime/retention',
            '/api/runtime/test-destination',
          ].includes(path)
          ? await body(request)
          : undefined,
      );
      if (repositoryResponse) return repositoryResponse;
      if (path === '/api/runtime/execute' && request.method === 'POST') {
        authorize(principal, 'backup', principal);
        const v = z
          .strictObject({ planId: uuidSchema, idempotencyKey: z.string().min(1).max(200) })
          .parse(await body(request));
        return Response.json({
          executionId: await store.enqueueExecution(
            v.planId,
            null,
            { kind: 'manual', idempotencyKey: v.idempotencyKey },
            principal,
          ),
        });
      }
      if (path === '/api/runtime/restore-postgresql' && request.method === 'POST') {
        authorize(principal, 'restore', principal);
        const v = z
          .strictObject({
            recoveryPointId: uuidSchema,
            repositoryId: uuidSchema.optional(),
            targetDatabase: postgresDatabaseNameSchema,
            idempotencyKey: z.string().min(1).max(160),
          })
          .parse(await body(request));
        const org = principal.organizationId;
        if (
          !(
            await verifiedPoints({
              db,
              organizationId: org,
              actorId: principal.userId,
              vault: { encryptSecret },
            })
          ).some((p) => p.id === v.recoveryPointId)
        )
          throw new Error('Verified recovery point required');
        const executionId = await runtimeTransaction(db, async (c) => {
          const previous = (
            await c.query<{ id: string; scope: Record<string, unknown> }>(
              `select e.id,r.scope from executions e join restore_requests r on r.organization_id=e.organization_id and r.execution_id=e.id where e.organization_id=$1 and e.idempotency_key=$2`,
              [org, `postgresql-restore:${v.idempotencyKey}`],
            )
          ).rows[0];
          if (previous) {
            if (
              previous.scope.recoveryPointId !== v.recoveryPointId ||
              previous.scope.targetDatabase !== v.targetDatabase ||
              (v.repositoryId !== undefined && previous.scope.repositoryId !== v.repositoryId)
            )
              throw new Error('Idempotency conflict');
            return previous.id;
          }
          const point = (
            await c.query<{
              profile_version_id: string;
              repository_id: string;
              postgresql_evidence: unknown;
            }>(
              `select p.profile_version_id,d.repository_id,d.postgresql_evidence from recovery_points p join destination_results d on d.organization_id=p.organization_id and d.recovery_point_id=p.id join repositories r on r.organization_id=d.organization_id and r.id=d.repository_id where p.organization_id=$1 and p.id=$2 and p.status='complete' and d.status='concluida' and d.verified_at is not null and d.removed_at is null and not d.retention_pending and ($3::uuid is null or d.repository_id=$3) and r.native_repository_id=d.postgresql_evidence->>'nativeRepositoryId' order by d.id limit 1 for share of p,d`,
              [org, v.recoveryPointId, v.repositoryId ?? null],
            )
          ).rows[0];
          if (!point) throw new Error('Recovery point unavailable');
          const proof = postgresEvidenceSchema.parse(point.postgresql_evidence);
          if (proof.requiresCompatibleCluster)
            throw new ConfigurationError(
              409,
              'Este backup do Supabase exige recuperação em uma instalação compatível, com suas chaves originais. O retorno automático para um banco novo não é compatível com estas extensões.',
            );
          if (proof.database === v.targetDatabase)
            throw new Error('Restore must use a new database');
          const scope = {
            kind: 'postgresql_restore',
            repositoryId: point.repository_id,
            recoveryPointId: v.recoveryPointId,
            snapshotId: proof.snapshotId,
            nativeRepositoryId: proof.nativeRepositoryId,
            sha256: proof.sha256,
            targetDatabase: v.targetDatabase,
          };
          const id = randomUUID();
          await c.query(
            "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1,$2,'restore',$3,$4)",
            [id, org, `postgresql-restore:${v.idempotencyKey}`, point.profile_version_id],
          );
          await c.query(
            "insert into restore_requests(organization_id,execution_id,recovery_point_id,requested_by,scope,production,status) values($1,$2,$3,$4,$5,false,'aguardando')",
            [org, id, v.recoveryPointId, principal.userId, JSON.stringify(scope)],
          );
          await c.query('insert into execution_jobs(organization_id,execution_id) values($1,$2)', [
            org,
            id,
          ]);
          await store.append(c, {
            organizationId: org,
            executionId: id,
            key: 'enqueued',
            code: 'restore_queued',
            status: 'aguardando',
          });
          return id;
        });
        return Response.json({ executionId });
      }
      if (path === '/api/agents/invitations' && request.method === 'POST') {
        authorize(principal, 'configure', principal);
        const v = z.strictObject({ serverId: uuidSchema }).parse(await body(request));
        return Response.json({
          enrollment: await registry.invite(
            principal.organizationId,
            v.serverId,
            new Date(Date.now() + 600000),
          ),
          expiresInSeconds: 600,
        });
      }
      const revoke = /^\/api\/agents\/([^/]+)\/revoke$/.exec(path);
      if (revoke && request.method === 'POST') {
        authorize(principal, 'configure', principal);
        z.strictObject({}).parse(await body(request));
        await registry.revoke(principal.organizationId, uuidSchema.parse(revoke[1]));
        return Response.json({ revoked: true });
      }
      const execution = /^\/api\/runtime\/executions\/([^/]+)$/.exec(path);
      if (execution && request.method === 'GET') {
        authorize(principal, 'read', principal);
        const id = uuidSchema.parse(execution[1]);
        const item = (
          await db.pool.query(
            'select id,status,profile_version_id as "profileVersionId",created_at as "createdAt" from executions where organization_id=$1 and id=$2',
            [principal.organizationId, id],
          )
        ).rows[0];
        if (!item) return Response.json({ error: 'Execução não encontrada.' }, { status: 404 });
        const events = (
          await db.pool.query(
            'select sequence,code,message,details from execution_events where organization_id=$1 and execution_id=$2 order by sequence desc limit 100',
            [principal.organizationId, id],
          )
        ).rows;
        return Response.json({ ...item, events });
      }
      return Response.json({ error: 'Página não encontrada.' }, { status: 404 });
    } catch (error) {
      if (error instanceof AccessError || error instanceof ConfigurationError)
        return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json({ error: 'Verifique os dados informados.' }, { status: 400 });
      return Response.json({ error: 'Não foi possível concluir a operação.' }, { status: 409 });
    }
  };
}
