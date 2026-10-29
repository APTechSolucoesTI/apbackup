import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { executionStatusSchema, type ExecutionStatus, uuidSchema } from '@apbackup/contracts';
import type { PlatformDatabase } from '../client.js';
import { authorize, type SessionPrincipal } from '../../../security/src/authorization.js';
export type RuntimePrincipal = SessionPrincipal | { kind: 'service'; organizationId: string };
export class ReservationBlockedError extends Error {
  constructor(public readonly reason: 'resource_busy' | 'effect_unknown') {
    super(
      reason === 'resource_busy'
        ? 'Resource busy'
        : 'Previous agent effect requires reconciliation',
    );
  }
}
export interface ClaimedJob {
  jobId: string;
  executionId: string;
  organizationId: string;
  profileVersionId: string;
  holder: string;
  workerId: string;
  fencingToken?: string;
}
export async function runtimeTransaction<T>(
  db: PlatformDatabase,
  run: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.pool.connect();
  try {
    await c.query('begin');
    const v = await run(c);
    await c.query('commit');
    return v;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
export function createExecutionStore(db: PlatformDatabase) {
  async function append(
    c: PoolClient,
    v: {
      organizationId: string;
      executionId: string;
      key: string;
      code: string;
      status: ExecutionStatus;
      diagnostics?: unknown;
    },
  ) {
    executionStatusSchema.parse(v.status);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(v.code) || v.key.length > 200)
      throw new Error('Invalid event');
    await c.query('select id from executions where organization_id=$1 and id=$2 for update', [
      v.organizationId,
      v.executionId,
    ]);
    const previous = (
      await c.query<{ sequence: string }>(
        'select sequence from execution_events where organization_id=$1 and execution_id=$2 and source_key=$3',
        [v.organizationId, v.executionId, v.key],
      )
    ).rows[0];
    if (previous) return previous.sequence;
    // Explicit public DTO: untrusted connector diagnostics never cross this persistence boundary.
    return (
      await c.query<{ sequence: string }>(
        `insert into execution_events(organization_id,execution_id,sequence,source_key,level,code,message,details) select $1,$2,coalesce(max(sequence),0)+1,$3,'info',$4,'Estado da execução atualizado.',jsonb_build_object('status',$5::text) from execution_events where organization_id=$1 and execution_id=$2 returning sequence`,
        [v.organizationId, v.executionId, v.key, v.code, v.status],
      )
    ).rows[0]!.sequence;
  }
  async function enqueue(
    c: PoolClient,
    planId: string,
    scheduledFor: Date | null,
    trigger: { kind: 'manual'; idempotencyKey: string } | { kind: 'schedule' },
    principal: RuntimePrincipal,
  ) {
    uuidSchema.parse(planId);
    if (!('kind' in principal))
      authorize(principal, 'backup', { organizationId: principal.organizationId });
    if (
      trigger.kind === 'manual' &&
      (!trigger.idempotencyKey || trigger.idempotencyKey.length > 200)
    )
      throw new Error('Idempotency key required');
    if (trigger.kind === 'schedule' && !scheduledFor) throw new Error('Schedule instant required');
    const p = (
      await c.query<{ profile_version_id: string }>(
        `select p.profile_version_id from plans p join servers s on s.organization_id=p.organization_id and s.id=p.server_id where p.organization_id=$1 and p.id=$2 and p.enabled and p.archived_at is null and s.archived_at is null for share of p`,
        [principal.organizationId, planId],
      )
    ).rows[0];
    if (!p?.profile_version_id) throw new Error('Plan unavailable');
    const key =
      trigger.kind === 'manual'
        ? `manual:${trigger.idempotencyKey}`
        : `schedule:${planId}:${scheduledFor!.toISOString()}`;
    const inserted = (
      await c.query<{ id: string }>(
        `insert into executions(organization_id,plan_id,kind,idempotency_key,scheduled_for,profile_version_id) values($1,$2,'backup',$3,$4,$5) on conflict do nothing returning id`,
        [principal.organizationId, planId, key, scheduledFor, p.profile_version_id],
      )
    ).rows[0];
    const row =
      inserted ??
      (
        await c.query<{ id: string }>(
          'select id from executions where organization_id=$1 and idempotency_key=$2 and plan_id=$3',
          [principal.organizationId, key, planId],
        )
      ).rows[0];
    if (!row) throw new Error('Idempotency conflict');
    await c.query(
      'insert into execution_jobs(organization_id,execution_id) values($1,$2) on conflict do nothing',
      [principal.organizationId, row.id],
    );
    await append(c, {
      organizationId: principal.organizationId,
      executionId: row.id,
      key: 'enqueued',
      code: 'queued',
      status: 'aguardando',
    });
    return row.id;
  }
  async function guard(c: PoolClient, j: ClaimedJob, now: Date) {
    const row = await c.query(
      `select id from execution_jobs where id=$1 and execution_id=$2 and organization_id=$3 and holder=$4 and claim_until>$5 and state='claimed' for update`,
      [j.jobId, j.executionId, j.organizationId, j.holder, now],
    );
    if (!row.rowCount) throw new Error('Claim lost');
  }
  async function assertFence(j: ClaimedJob, ids: readonly string[], now: Date) {
    if (!j.fencingToken || !ids.length) throw new Error('Fence required');
    return runtimeTransaction(db, async (c) => {
      await guard(c, j, now);
      const rows = await c.query(
        `select resource_id from leases where organization_id=$1 and execution_id=$2 and holder=$3 and fencing_token=$4 and expires_at>$5 and resource_id=any($6::uuid[])`,
        [j.organizationId, j.executionId, j.holder, j.fencingToken, now, ids],
      );
      if (rows.rowCount !== new Set(ids).size) throw new Error('Lease lost');
    });
  }
  return {
    enqueue,
    append,
    enqueueExecution: (
      p: string,
      at: Date | null,
      t: { kind: 'manual'; idempotencyKey: string } | { kind: 'schedule' },
      principal: RuntimePrincipal,
    ) => runtimeTransaction(db, (c) => enqueue(c, p, at, t, principal)),
    appendEvent: (v: Parameters<typeof append>[1]) => runtimeTransaction(db, (c) => append(c, v)),
    async claimJob(workerId: string, now: Date): Promise<ClaimedJob | null> {
      return runtimeTransaction(db, async (c) => {
        const row = (
          await c.query<{
            jobId: string;
            executionId: string;
            organizationId: string;
            profileVersionId: string;
            previousHolder: string | null;
          }>(
            `select j.id as "jobId",j.execution_id as "executionId",j.organization_id as "organizationId",e.profile_version_id as "profileVersionId",j.holder as "previousHolder" from execution_jobs j join executions e on e.organization_id=j.organization_id and e.id=j.execution_id where (j.state='ready' and j.retry_after<=$1) or (j.state='claimed' and j.claim_until<=$1) order by greatest(coalesce(j.retry_after,j.created_at),j.created_at),j.created_at,j.id for update of j skip locked limit 1`,
            [now],
          )
        ).rows[0];
        if (!row) return null;
        const holder = randomUUID();
        if (row.previousHolder) {
          // Serialize with new reservations. Reclaim ownership of this SAME command/fence,
          // never reserve again or adopt another execution's unknown host effect.
          await c.query(
            `select r.id from resources r join agent_commands a on a.organization_id=r.organization_id and a.resource_id=r.id where a.organization_id=$1 and a.execution_id=$2 order by r.id for update of r`,
            [row.organizationId, row.executionId],
          );
          await c.query(
            `update leases l set holder=$3,expires_at=$4,heartbeat_at=$5 from agent_commands a,resource_fences f where l.organization_id=$1 and l.execution_id=$2 and l.holder=$6 and a.organization_id=l.organization_id and a.execution_id=l.execution_id and a.resource_id=l.resource_id and a.fencing_token=l.fencing_token and a.profile_version_id=$7 and a.state in('queued','delivered') and a.result is null and a.expires_at>$5 and f.organization_id=l.organization_id and f.resource_id=l.resource_id and f.highest=l.fencing_token and not exists(select 1 from agent_commands other where other.organization_id=l.organization_id and other.resource_id=l.resource_id and other.execution_id<>l.execution_id and (other.state in('queued','delivered','unknown') or other.result->>'outcome'='unknown'))`,
            [
              row.organizationId,
              row.executionId,
              holder,
              new Date(+now + 60000),
              now,
              row.previousHolder,
              row.profileVersionId,
            ],
          );
        }
        await c.query(
          "update execution_jobs set state='claimed',worker_id=$2,holder=$3,claim_until=$4,heartbeat_at=$5,dispatch_attempts=dispatch_attempts+1 where id=$1",
          [row.jobId, workerId, holder, new Date(+now + 60000), now],
        );
        const { previousHolder, ...claimed } = row;
        void previousHolder;
        return { ...claimed, holder, workerId };
      });
    },
    async deferJob(
      j: ClaimedJob,
      reason: 'resource_busy' | 'effect_unknown' | 'dispatch_failed',
      now: Date,
    ) {
      return runtimeTransaction(db, async (c) => {
        await guard(c, j, now);
        const attempt = (
          await c.query<{ dispatch_attempts: number }>(
            'select dispatch_attempts from execution_jobs where id=$1',
            [j.jobId],
          )
        ).rows[0]!.dispatch_attempts;
        const parked = reason === 'effect_unknown';
        const retry = parked
          ? null
          : new Date(+now + Math.min(60000, 5000 * 2 ** Math.min(attempt - 1, 4)));
        await c.query(
          'update execution_jobs set state=$2,retry_after=$3,blocked_reason=$4,holder=null,claim_until=null where id=$1',
          [j.jobId, parked ? 'waiting' : 'ready', retry, reason],
        );
        if (parked)
          await c.query(
            "update executions set status='exige_intervencao' where organization_id=$1 and id=$2",
            [j.organizationId, j.executionId],
          );
        const current = (
          await c.query<{ status: ExecutionStatus }>(
            'select status from executions where organization_id=$1 and id=$2',
            [j.organizationId, j.executionId],
          )
        ).rows[0]!.status;
        await append(c, {
          organizationId: j.organizationId,
          executionId: j.executionId,
          key: `dispatch:${attempt}:${reason}`,
          code: reason,
          status: current,
        });
      });
    },
    async heartbeat(j: ClaimedJob, now: Date) {
      return runtimeTransaction(db, async (c) => {
        await guard(c, j, now);
        await c.query('update execution_jobs set claim_until=$2,heartbeat_at=$3 where id=$1', [
          j.jobId,
          new Date(+now + 60000),
          now,
        ]);
        await c.query(
          'update leases set expires_at=$3,heartbeat_at=$4 where organization_id=$1 and holder=$2',
          [j.organizationId, j.holder, new Date(+now + 60000), now],
        );
      });
    },
    async reserveResources(j: ClaimedJob, ids: readonly string[], now: Date) {
      return runtimeTransaction(db, async (c) => {
        await guard(c, j, now);
        const sorted = [...new Set(ids)].sort();
        if (!sorted.length) throw new Error('Resources required');
        const owned = await c.query(
          `select r.id from profile_resources p join resources r on r.organization_id=p.organization_id and r.id=p.resource_id join profile_versions v on v.organization_id=p.organization_id and v.id=p.profile_version_id join system_profiles s on s.organization_id=v.organization_id and s.id=v.profile_id where p.organization_id=$1 and p.profile_version_id=$2 and r.id=any($3::uuid[]) and r.server_id=s.server_id order by r.id for update of r`,
          [j.organizationId, j.profileVersionId, sorted],
        );
        if (owned.rowCount !== sorted.length) throw new Error('Resource outside immutable profile');
        const explicitlyUnknown = await c.query(
          "select id from agent_commands where organization_id=$1 and resource_id=any($2::uuid[]) and execution_id<>$3 and (state='unknown' or result->>'outcome'='unknown')",
          [j.organizationId, sorted, j.executionId],
        );
        if (explicitlyUnknown.rowCount) throw new ReservationBlockedError('effect_unknown');
        const blocked = await c.query(
          'select id from leases where organization_id=$1 and resource_id=any($2::uuid[]) and expires_at>$3 and holder<>$4',
          [j.organizationId, sorted, now, j.holder],
        );
        if (blocked.rowCount) throw new ReservationBlockedError('resource_busy');
        const uncertain = await c.query(
          "select id from agent_commands where organization_id=$1 and resource_id=any($2::uuid[]) and execution_id<>$3 and (state in('queued','delivered','unknown') or result->>'outcome'='unknown')",
          [j.organizationId, sorted, j.executionId],
        );
        if (uncertain.rowCount) throw new ReservationBlockedError('effect_unknown');
        const token = (
          await c.query<{ v: string }>("select nextval('runtime_fencing_seq')::text v")
        ).rows[0]!.v;
        for (const id of sorted) {
          await c.query(
            'insert into resource_fences(organization_id,resource_id,highest) values($1,$2,$3) on conflict(organization_id,resource_id) do update set highest=excluded.highest',
            [j.organizationId, id, token],
          );
          await c.query(
            'insert into leases(organization_id,resource_id,execution_id,holder,fencing_token,expires_at,heartbeat_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(organization_id,resource_id) do update set execution_id=excluded.execution_id,holder=excluded.holder,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at',
            [j.organizationId, id, j.executionId, j.holder, token, new Date(+now + 60000), now],
          );
        }
        return { fencingToken: token, resourceIds: sorted };
      });
    },
    assertFence,
    releaseResources: (j: ClaimedJob) =>
      db.pool.query(
        'delete from leases where organization_id=$1 and execution_id=$2 and holder=$3',
        [j.organizationId, j.executionId, j.holder],
      ),
  };
}
