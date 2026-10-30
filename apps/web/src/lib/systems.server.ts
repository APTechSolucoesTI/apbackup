import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import {
  backupSystemInputSchema,
  backupSystemsOverviewSchema,
  systemBackupInputSchema,
  uuidSchema,
} from '@apbackup/contracts';
import {
  authorize,
  AccessError,
  type SessionPrincipal,
} from '../../../../packages/security/src/authorization.js';
import { ConfigurationError } from '../../../../packages/db/src/repositories/shared.js';
import {
  runtimeTransaction,
  createExecutionStore,
} from '../../../../packages/db/src/repositories/jobs.js';

export function createSystemsApi(
  db: PlatformDatabase,
  requireSession: (r: Request) => Promise<SessionPrincipal>,
  baseURL: string,
) {
  return async (request: Request) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const actor = await requireSession(request),
        org = actor.organizationId,
        path = new URL(request.url).pathname;
      authorize(
        actor,
        request.method === 'GET' ? 'read' : path.endsWith('/backup') ? 'backup' : 'configure',
        actor,
      );
      if (request.method !== 'GET' && request.headers.get('origin') !== new URL(baseURL).origin)
        throw new AccessError(403);
      const input = async () => {
        const value = await request.text();
        if (Buffer.byteLength(value) > 16384)
          throw new ConfigurationError(400, 'Formulário muito grande.');
        return JSON.parse(value || '{}') as unknown;
      };
      if (path === '/api/systems/options' && request.method === 'GET') {
        authorize(actor, 'configure', actor);
        const servers = (
          await db.pool.query(
            'select id,name from servers where organization_id=$1 and archived_at is null order by name',
            [org],
          )
        ).rows;
        const plans = (
          await db.pool.query(
            'select id,server_id as "serverId",name from plans where organization_id=$1 and archived_at is null order by name',
            [org],
          )
        ).rows;
        return Response.json({ servers, plans }, { headers });
      }
      if (path === '/api/systems/overview' && request.method === 'GET') {
        const systems = (
          await db.pool.query<{
            id: string;
            serverId: string;
            serverName: string;
            name: string;
            description: string;
            scopeNotes: string;
            sortOrder: number;
          }>(
            `select b.id,b.server_id as "serverId",s.name as "serverName",b.name,b.description,b.scope_notes as "scopeNotes",b.sort_order as "sortOrder" from backup_systems b join servers s on s.organization_id=b.organization_id and s.id=b.server_id where b.organization_id=$1 and s.archived_at is null order by b.sort_order,b.name,b.id`,
            [org],
          )
        ).rows;
        const components = (
          await db.pool.query<{ systemId: string; [key: string]: unknown }>(
            `
     select l.system_id as "systemId",l.plan_id as "planId",l.component_kind as kind,l.label,l.scope_note as "scopeNote",l.shared,
      p.name as "planName",(p.enabled and p.archived_at is null) as enabled,p.profile_version_id as "profileVersionId",v.definition->'adapter'->>'name' as adapter,r.days as "retentionDays",
      coalesce((select jsonb_agg(jsonb_build_object('time',s.local_time,'timezone',s.timezone,'enabled',s.enabled) order by s.local_time) from schedules s where s.organization_id=p.organization_id and s.plan_id=p.id),'[]') as schedules,
      (select jsonb_build_object('id',e.id,'status',e.status,'createdAt',e.created_at) from executions e where e.organization_id=p.organization_id and e.plan_id=p.id and e.kind='backup' order by e.created_at desc,e.id desc limit 1) as latest,
      coalesce((select jsonb_agg(q.body order by q.captured_at desc) from (
       select rp.captured_at,jsonb_build_object('id',rp.id,'status',rp.status,'capturedAt',rp.captured_at,'destinations',coalesce((
        select jsonb_agg(jsonb_build_object('repositoryId',d.repository_id,'name',ds.name,'kind',ds.kind,'required',coalesce(pd.required,false),'status',d.status,'verifiedAt',d.verified_at,'removedAt',d.removed_at,'retentionPending',d.retention_pending) order by ds.name)
        from destination_results d join repositories rr on rr.organization_id=d.organization_id and rr.id=d.repository_id join destinations ds on ds.organization_id=rr.organization_id and ds.id=rr.destination_id left join plan_destinations pd on pd.organization_id=p.organization_id and pd.plan_id=p.id and pd.repository_id=d.repository_id where d.organization_id=rp.organization_id and d.recovery_point_id=rp.id),'[]')) as body
       from recovery_points rp join executions e on e.organization_id=rp.organization_id and e.id=rp.execution_id where rp.organization_id=p.organization_id and e.plan_id=p.id order by rp.captured_at desc,rp.id desc limit 5
      ) q),'[]') as points,
      coalesce((select jsonb_agg(jsonb_build_object('repositoryId',pd.repository_id,'name',ds.name,'kind',ds.kind,'required',pd.required,'status',d.status,'verifiedAt',d.verified_at,'removedAt',d.removed_at,'retentionPending',d.retention_pending) order by ds.name)
       from plan_destinations pd join repositories rr on rr.organization_id=pd.organization_id and rr.id=pd.repository_id join destinations ds on ds.organization_id=rr.organization_id and ds.id=rr.destination_id
       left join lateral (select dr.* from destination_results dr join recovery_points rp on rp.organization_id=dr.organization_id and rp.id=dr.recovery_point_id join executions e on e.organization_id=rp.organization_id and e.id=rp.execution_id where dr.organization_id=pd.organization_id and dr.repository_id=pd.repository_id and e.plan_id=p.id order by rp.captured_at desc,rp.id desc limit 1) d on true
       where pd.organization_id=p.organization_id and pd.plan_id=p.id),'[]') as destinations
     from system_plan_links l join plans p on p.organization_id=l.organization_id and p.server_id=l.server_id and p.id=l.plan_id left join profile_versions v on v.organization_id=p.organization_id and v.id=p.profile_version_id left join retention_policies r on r.organization_id=p.organization_id and r.id=p.retention_policy_id where l.organization_id=$1 order by l.component_kind,l.label`,
            [org],
          )
        ).rows;
        return Response.json(
          backupSystemsOverviewSchema.parse({
            items: systems.map((s) => ({
              ...s,
              components: components
                .filter((c) => c.systemId === s.id)
                .map(({ systemId, ...component }) => {
                  void systemId;
                  return component;
                }),
            })),
          }),
          { headers },
        );
      }
      if (path === '/api/systems/save' && request.method === 'POST') {
        const v = backupSystemInputSchema.parse(await input());
        const id = await runtimeTransaction(db, async (c) => {
          if (
            !(
              await c.query(
                'select id from servers where organization_id=$1 and id=$2 and archived_at is null for share',
                [org, v.serverId],
              )
            ).rowCount
          )
            throw new ConfigurationError(404, 'Servidor não encontrado.');
          const id = v.id ?? randomUUID();
          if (
            v.id &&
            !(
              await c.query(
                'select id from backup_systems where organization_id=$1 and id=$2 and server_id=$3 for update',
                [org, id, v.serverId],
              )
            ).rowCount
          )
            throw new ConfigurationError(404, 'Sistema não encontrado.');
          const planIds = [...new Set(v.components.map((i) => i.planId))];
          if (
            planIds.length &&
            (
              await c.query(
                'select id from plans where organization_id=$1 and server_id=$2 and id=any($3::uuid[]) and archived_at is null for share',
                [org, v.serverId, planIds],
              )
            ).rowCount !== planIds.length
          )
            throw new ConfigurationError(400, 'Escolha planos deste servidor.');
          await c.query(
            `insert into backup_systems(id,organization_id,server_id,name,description,scope_notes,sort_order) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set name=excluded.name,description=excluded.description,scope_notes=excluded.scope_notes,sort_order=excluded.sort_order`,
            [id, org, v.serverId, v.name, v.description, v.scopeNotes, v.sortOrder],
          );
          await c.query('delete from system_plan_links where organization_id=$1 and system_id=$2', [
            org,
            id,
          ]);
          for (const i of v.components)
            await c.query(
              'insert into system_plan_links(organization_id,server_id,system_id,plan_id,component_kind,label,scope_note,shared) values($1,$2,$3,$4,$5,$6,$7,$8)',
              [org, v.serverId, id, i.planId, i.kind, i.label, i.scopeNote, i.shared],
            );
          await c.query(
            "insert into audit_events(organization_id,actor_id,action,subject_type,subject_id,details) values($1,$2,'system_configured','backup_system',$3,jsonb_build_object('componentCount',$4::int))",
            [org, actor.userId, id, v.components.length],
          );
          return id;
        });
        return Response.json({ id }, { headers, status: 201 });
      }
      const match = /^\/api\/systems\/([^/]+)\/backup$/.exec(path);
      if (match && request.method === 'POST') {
        const systemId = uuidSchema.parse(match[1]),
          v = systemBackupInputSchema.parse(await input()),
          store = createExecutionStore(db);
        const result = await runtimeTransaction(db, async (c) => {
          if (
            !(
              await c.query(
                'select b.id from backup_systems b join servers s on s.organization_id=b.organization_id and s.id=b.server_id where b.organization_id=$1 and b.id=$2 and s.archived_at is null for update of b',
                [org, systemId],
              )
            ).rowCount
          )
            throw new ConfigurationError(404, 'Sistema não encontrado.');
          let run = (
            await c.query<{ id: string; plan_ids: string[] }>(
              'select id,plan_ids from backup_system_runs where organization_id=$1 and system_id=$2 and idempotency_key=$3',
              [org, systemId, v.idempotencyKey],
            )
          ).rows[0];
          const fresh = !run;
          if (!run) {
            const plans = (
              await c.query<{ plan_id: string }>(
                'select distinct plan_id from system_plan_links where organization_id=$1 and system_id=$2 order by plan_id',
                [org, systemId],
              )
            ).rows.map((p) => p.plan_id);
            if (!plans.length)
              throw new ConfigurationError(409, 'Vincule planos antes de iniciar o backup.');
            run = (
              await c.query<{ id: string; plan_ids: string[] }>(
                'insert into backup_system_runs(organization_id,system_id,idempotency_key,plan_ids) values($1,$2,$3,$4) returning id,plan_ids',
                [org, systemId, v.idempotencyKey, plans],
              )
            ).rows[0]!;
          }
          const executions = [];
          for (const planId of run.plan_ids) {
            const key = `system:${run.id}:${planId}`;
            // Return completed jobs too: retries never requeue a completed batch.
            const existing = (
              await c.query<{ id: string }>(
                'select id from executions where organization_id=$1 and plan_id=$2 and idempotency_key=$3',
                [org, planId, `manual:${key}`],
              )
            ).rows[0];
            const executionId =
              existing?.id ??
              (await store.enqueue(
                c,
                planId,
                null,
                { kind: 'manual', idempotencyKey: key },
                actor,
              ));
            executions.push({ planId, executionId });
          }
          if (fresh)
            await c.query(
              "insert into audit_events(organization_id,actor_id,action,subject_type,subject_id,details) values($1,$2,'system_backup_queued','backup_system',$3,jsonb_build_object('runId',$4::text,'planCount',$5::int))",
              [org, actor.userId, systemId, run.id, executions.length],
            );
          return { runId: run.id, executions };
        });
        return Response.json(result, { headers });
      }
      return Response.json({ error: 'Página não encontrada.' }, { status: 404, headers });
    } catch (e) {
      if (e instanceof AccessError || e instanceof ConfigurationError)
        return Response.json({ error: e.message }, { status: e.status, headers });
      if (e instanceof z.ZodError || e instanceof SyntaxError)
        return Response.json({ error: 'Revise os campos informados.' }, { status: 400, headers });
      return Response.json(
        { error: 'Não foi possível concluir. Verifique os planos e tente novamente.' },
        { status: 409, headers },
      );
    }
  };
}
