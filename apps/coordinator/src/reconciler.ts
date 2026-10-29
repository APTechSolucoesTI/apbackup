import { finishRepository } from './repository-results.js';
import type { PlatformDatabase } from '@apbackup/db';
import {
  agentResultSchema,
  agentCommandSchema,
  canonicalJson,
  executionStatusSchema,
} from '@apbackup/contracts';
import { assertTransition } from '../../../packages/engine/src/state-machine.js';
import {
  createExecutionStore,
  runtimeTransaction,
} from '../../../packages/db/src/repositories/jobs.js';
import { finishPostgres, validatePostgresResult } from './postgresql-results.js';
export async function acceptAgentResult(
  db: PlatformDatabase,
  agentId: string,
  organizationId: string,
  input: unknown,
) {
  const result = agentResultSchema.parse(input),
    store = createExecutionStore(db);
  const accepted = await runtimeTransaction(db, async (c) => {
    const row = (
      await c.query<{ execution_id: string; result: unknown; state: string; body: unknown }>(
        `select c.execution_id,c.result,c.state,c.body from agent_commands c join agents a on a.organization_id=c.organization_id and a.id=c.agent_id where c.id=$1 and c.organization_id=$2 and c.agent_id=$3 and a.revoked_at is null for update of c`,
        [result.commandId, organizationId, agentId],
      )
    ).rows[0];
    if (!row) throw new Error('Unknown command');
    validatePostgresResult(row.body, result);
    const command = agentCommandSchema.parse(row.body);
    const postgres =
      command.operation.kind === 'postgresql_backup' ||
      command.operation.kind === 'postgresql_restore' ||
      command.operation.kind === 'docker_backup' ||
      command.operation.kind === 'docker_restore' ||
      command.operation.kind.startsWith('repository_');
    if (row.result) {
      if (canonicalJson(row.result) !== canonicalJson(result))
        throw new Error('Conflicting result');
      return postgres ? row.execution_id : null;
    }
    await c.query('update agent_commands set result=$2,state=$3 where id=$1', [
      result.commandId,
      JSON.stringify(result),
      result.outcome === 'unknown' ? 'unknown' : 'completed',
    ]);
    await store.append(c, {
      organizationId,
      executionId: row.execution_id,
      key: `result:${result.commandId}:1`,
      code: result.code,
      status: result.outcome === 'completed' ? 'verificando' : 'exige_intervencao',
    });
    return postgres ? row.execution_id : null;
  });
  // Publication can arrive after timeout parked the job. Reconcile the recorded
  // result directly; never requeue/replay a mutable host effect to discover it.
  if (accepted) await reconcileExecution(db, accepted, organizationId);
}
export async function reconcileExecution(
  db: PlatformDatabase,
  executionId: string,
  organizationId: string,
) {
  const store = createExecutionStore(db);
  return runtimeTransaction(db, async (c) => {
    const execution = (
      await c.query<{ status: string }>(
        'select status from executions where organization_id=$1 and id=$2 for update',
        [organizationId, executionId],
      )
    ).rows[0];
    if (!execution) throw new Error('Unknown execution');
    let current = executionStatusSchema.parse(execution.status);
    if (['concluida', 'falhas_parciais', 'falhou', 'cancelada'].includes(current))
      return { state: current };
    const rows = (
      await c.query<{
        state: string;
        expires_at: Date;
        body: unknown;
        result: { outcome: string } | null;
      }>(
        'select state,expires_at,body,result from agent_commands where organization_id=$1 and execution_id=$2',
        [organizationId, executionId],
      )
    ).rows;
    if (!rows.length) return { state: execution.status };
    if (rows.some((r) => !r.result && +r.expires_at > Date.now())) return { state: 'waiting' };
    if (
      current === 'exige_intervencao' &&
      rows.length === 1 &&
      rows[0]!.result?.outcome === 'completed'
    ) {
      const command = agentCommandSchema.parse(rows[0]!.body);
      if (
        command.operation.kind === 'postgresql_backup' ||
        command.operation.kind === 'postgresql_restore' ||
        command.operation.kind === 'docker_backup' ||
        command.operation.kind === 'docker_restore'
      ) {
        await c.query('select id from resources where organization_id=$1 and id=$2 for update', [
          organizationId,
          command.resourceId,
        ]);
        const authoritative = await c.query(
          `select l.id from leases l join resource_fences f on f.organization_id=l.organization_id and f.resource_id=l.resource_id and f.highest=l.fencing_token where l.organization_id=$1 and l.execution_id=$2 and l.resource_id=$3 and l.fencing_token=$4 and exists(select 1 from execution_events e where e.organization_id=l.organization_id and e.execution_id=l.execution_id and e.source_key='reconciliation:effect_unknown') and not exists(select 1 from agent_commands other where other.organization_id=l.organization_id and other.resource_id=l.resource_id and other.execution_id<>l.execution_id and (other.state in('queued','delivered','unknown') or other.result->>'outcome'='unknown'))`,
          [organizationId, executionId, command.resourceId, command.fencingToken],
        );
        if (!authoritative.rowCount) return { state: 'exige_intervencao' };
        // Only a first authoritative result for the reserved exact command can
        // resolve coordinator timeout uncertainty. An agent's unknown result is
        // immutable and cannot be replaced by a contradictory success.
        current = 'verificando';
        await c.query(
          "update executions set status='verificando' where organization_id=$1 and id=$2",
          [organizationId, executionId],
        );
        await store.append(c, {
          organizationId,
          executionId,
          key: 'late-result-confirmed',
          code: 'late_result_confirmed',
          status: 'verificando',
        });
      }
    }
    if (await finishRepository(c, store, organizationId, executionId, rows))
      return { state: 'concluida' };
    if (
      rows.every((r) => r.result?.outcome === 'completed') &&
      (await finishPostgres(c, store, organizationId, executionId, current, rows))
    )
      return { state: 'concluida' };
    // No second mutable command is manufactured from an unknown or merely claimed effect.
    const unknown = rows.some((r) => !r.result || r.result.outcome === 'unknown');
    const state = 'exige_intervencao';
    assertTransition(current, state);
    const code = unknown
      ? 'effect_unknown'
      : rows.some((r) => r.result?.outcome !== 'completed')
        ? 'agent_failed'
        : 'connector_not_configured';
    await c.query(
      "update executions set status='exige_intervencao' where organization_id=$1 and id=$2",
      [organizationId, executionId],
    );
    await c.query(
      'update execution_steps set status=$3,finished_at=now() where organization_id=$1 and execution_id=$2',
      [
        organizationId,
        executionId,
        unknown
          ? 'exige_intervencao'
          : rows.every((r) => r.result?.outcome === 'completed')
            ? 'concluida'
            : 'falhou',
      ],
    );
    await store.append(c, {
      organizationId,
      executionId,
      key: `reconciliation:${code}`,
      code,
      status: state,
    });
    await c.query(
      'update attempts a set status=s.status,finished_at=s.finished_at from execution_steps s where a.organization_id=s.organization_id and a.step_id=s.id and s.organization_id=$1 and s.execution_id=$2',
      [organizationId, executionId],
    );
    await c.query(
      "update execution_jobs set state='done' where organization_id=$1 and execution_id=$2",
      [organizationId, executionId],
    );
    // Unknown effects retain the reservation until explicit operational reconciliation.
    if (!unknown)
      await c.query('delete from leases where organization_id=$1 and execution_id=$2', [
        organizationId,
        executionId,
      ]);
    return { state };
  });
}
