import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformDatabase } from '@apbackup/db';
import {
  createExecutionStore,
  type ClaimedJob,
  ReservationBlockedError,
} from '../../../packages/db/src/repositories/jobs.js';
import { scheduleDue } from './scheduler.js';
import { dispatchJob } from './dispatcher.js';
import { reconcileExecution } from './reconciler.js';
import { reconcileDokployNative } from '../../../packages/connectors/src/dokploy-connection.js';
export async function coordinatorTick(
  db: PlatformDatabase,
  workerId: string,
  now = new Date(),
  schedules = false,
) {
  const store = createExecutionStore(db);
  if (schedules) await scheduleDue(db, now);
  const job = await store.claimJob(workerId, now);
  if (job) {
    try {
      await dispatchJob(db, job, now);
    } catch (error) {
      await store.deferJob(
        job,
        error instanceof ReservationBlockedError ? error.reason : 'dispatch_failed',
        now,
      );
    }
  }
  const active = (
    await db.pool.query<ClaimedJob>(
      `select j.id as "jobId",j.organization_id as "organizationId",j.execution_id as "executionId",e.profile_version_id as "profileVersionId",j.holder,j.worker_id as "workerId" from execution_jobs j join executions e on e.organization_id=j.organization_id and e.id=j.execution_id where j.state='claimed' and j.worker_id=$1 and j.claim_until>$2`,
      [workerId, now],
    )
  ).rows;
  for (const current of active) {
    await store.heartbeat(current, now);
    await reconcileExecution(db, current.executionId, current.organizationId);
  }
  return { claimed: job?.executionId ?? null, active: active.length };
}
export async function runCoordinator(
  db: PlatformDatabase,
  signal: AbortSignal,
  options: { workerId?: string; pollMs?: number; schedules?: boolean; once?: boolean } = {},
) {
  const workerId = options.workerId ?? randomUUID();
  const pollMs = options.pollMs ?? 1000;
  if (pollMs < 100 || pollMs > 60000) throw new Error('Invalid polling interval');
  let nativePending: Promise<void> | undefined;
  // Native HTTP observation must never delay command lease renewal.
  const nativeTimer = setInterval(() => {
    if (!nativePending && !signal.aborted)
      nativePending = reconcileDokployNative(db, signal)
        .catch(() => {})
        .finally(() => {
          nativePending = undefined;
        });
  }, 15000);
  nativeTimer.unref();
  try {
    do {
      try {
        const tick = await coordinatorTick(db, workerId, new Date(), options.schedules ?? false);
        if (options.once) return tick;
      } catch {
        console.error('Coordenador aguardando reconexão com o catálogo.');
      }
      if (signal.aborted) break;
      try {
        await delay(pollMs, undefined, { signal });
      } catch {
        break;
      }
    } while (!signal.aborted);
  } finally {
    clearInterval(nativeTimer);
    await nativePending;
  }
}
