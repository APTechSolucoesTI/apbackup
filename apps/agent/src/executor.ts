import {
  runRepositoryCommand,
  stagingPreflight,
  ownStaging,
  cleanupStaging,
  type RepositoryPolicy,
} from '../../../packages/connectors/src/repository-runtime.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  agentCommandSchema,
  canonicalJson,
  type AgentCommand,
  type AgentResult,
  type ExecutionContext,
} from '@apbackup/contracts';
import { safePath, trustedDirectory } from '../../../packages/connectors/src/runtime/safe-path.js';
import { spawnTool } from '../../../packages/connectors/src/runtime/spawn-tool.js';
import type { AgentJournal } from './journal.js';
import { resumePaused } from './watchdog.js';
import {
  runDockerCommand,
  DockerUnknownEffect,
  DockerStageError,
} from '../../../packages/connectors/src/docker-runtime.js';
import type { DockerPolicy } from '../../../packages/connectors/src/docker-client.js';
import {
  withCommandDeadline,
  CommandDeadlineError,
} from '../../../packages/connectors/src/runtime/command-deadline.js';
import {
  runPostgresCommand,
  PostgresUnknownEffect,
  PostgresStageError,
  type PostgresPolicy,
} from '../../../packages/connectors/src/postgresql-runtime.js';
export interface AgentPolicy {
  agentId: string;
  organizationId: string;
  resources: Readonly<Record<string, { root: string; units: readonly string[] }>>;
  artifactRoot: string;
  repositories?: RepositoryPolicy | undefined;
  postgresql?: PostgresPolicy | undefined;
  docker?: DockerPolicy | undefined;
}
export function createExecutor(policy: AgentPolicy, journal: AgentJournal) {
  let serial = Promise.resolve();
  async function execute(input: AgentCommand, context: ExecutionContext): Promise<AgentResult> {
    const parsed = agentCommandSchema.safeParse(input);
    const rejected: AgentResult = {
      commandId: input.commandId,
      sequence: 1,
      outcome: 'rejected',
      code: 'command_rejected',
    };
    if (!parsed.success) return rejected;
    const c = parsed.data,
      scope = policy.resources[c.resourceId];
    const postgres =
      c.operation.kind === 'postgresql_backup' || c.operation.kind === 'postgresql_restore';
    const docker = c.operation.kind === 'docker_backup' || c.operation.kind === 'docker_restore';
    const repositoryOperation = c.operation.kind.startsWith('repository_');
    if (
      (!scope &&
        !(postgres && policy.postgresql) &&
        !(docker && policy.docker) &&
        !(repositoryOperation && (policy.repositories || policy.postgresql || policy.docker))) ||
      c.agentId !== policy.agentId ||
      c.organizationId !== policy.organizationId ||
      context.executionId !== c.executionId ||
      context.profileVersionId !== c.profileVersionId ||
      context.agentId !== c.agentId ||
      context.organizationId !== c.organizationId ||
      context.fencingToken !== c.fencingToken
    )
      return rejected;
    const digest = createHash('sha256').update(canonicalJson(c)).digest('hex');
    const existing = journal.state.commands[c.commandId];
    if (existing) {
      if (existing.digest !== digest) return rejected;
      if (existing.result) return existing.result;
      if (existing.phase === 'unknown')
        return { commandId: c.commandId, sequence: 1, outcome: 'unknown', code: 'effect_unknown' };
    }
    if (
      Date.parse(c.expiresAt) <= Date.now() ||
      context.signal.aborted ||
      BigInt(c.fencingToken) < BigInt(journal.state.fences[c.resourceId] ?? '0')
    )
      return rejected;
    try {
      if ('path' in c.operation) await safePath(scope!.root, c.operation.path);
      if ('unit' in c.operation && !scope!.units.includes(c.operation.unit)) return rejected;
    } catch {
      return rejected;
    }
    if (c.operation.kind === 'service_pause') {
      try {
        const active = await spawnTool('systemctl', ['is-active', '--quiet', c.operation.unit], {
          cwd: scope!.root,
          timeoutMs: 10000,
          diagnosticLimit: 1024,
          signal: context.signal,
        });
        if (active.exitCode !== 0 || active.timedOut) return rejected;
      } catch {
        return rejected;
      }
    }
    if (c.operation.kind !== 'inspect') {
      try {
        if (!context.authorizeEffect || !(await context.authorizeEffect(c))) return rejected;
      } catch {
        return rejected;
      }
      if (Date.parse(c.expiresAt) <= Date.now() || context.signal.aborted) return rejected;
    }
    if (!existing)
      await journal.record({
        kind: 'accepted',
        commandId: c.commandId,
        resourceId: c.resourceId,
        fencingToken: c.fencingToken,
        digest,
      });
    await journal.record({ kind: 'started', commandId: c.commandId });
    let result: AgentResult = {
      commandId: c.commandId,
      sequence: 1,
      outcome: 'completed',
      code: 'ok',
    };
    try {
      const repositoryPolicy = policy.repositories ?? policy.postgresql ?? policy.docker;
      if (postgres || docker || repositoryOperation) {
        await stagingPreflight(policy.artifactRoot);
        await ownStaging(policy.artifactRoot, c);
      }
      if (repositoryOperation) {
        result = {
          ...result,
          ...(await withCommandDeadline(c, context, (scoped) =>
            runRepositoryCommand(c, scoped, repositoryPolicy!, policy.artifactRoot),
          )),
        };
        if (
          c.operation.kind === 'repository_copy' &&
          result.replications?.some((r) => r.status === 'falhou')
        )
          result = { ...result, outcome: 'failed', code: 'execution_failed' };
      } else if (docker) {
        result = {
          ...result,
          ...(await withCommandDeadline(c, context, (scoped) =>
            runDockerCommand(
              c,
              scoped,
              { ...policy.docker!, ...policy.repositories },
              policy.artifactRoot,
            ),
          )),
        };
      } else if (postgres) {
        result = {
          ...result,
          ...(await withCommandDeadline(c, context, (scoped) =>
            runPostgresCommand(
              c,
              scoped,
              {
                ...policy.postgresql!,
                mountedRoots: policy.repositories?.mountedRoots,
                storageHosts: policy.repositories?.allowedHosts,
              },
              policy.artifactRoot,
            ),
          )),
        };
      } else if (c.operation.kind === 'inspect') {
        await stat(await safePath(scope!.root, c.operation.path));
      } else if (c.operation.kind === 'archive_files') {
        // Unique execution directory is local policy, never a caller-selected absolute destination.
        await trustedDirectory(policy.artifactRoot, { private: true });
        if (c.operation.artifact.includes('/')) throw new Error('Flat artifact key required');
        const root = await trustedDirectory(join(policy.artifactRoot, c.executionId), {
          create: true,
          private: true,
        });
        const output = join(root, c.operation.artifact),
          source = await safePath(scope!.root, c.operation.path);
        const r = await spawnTool(
          'tar',
          [
            '--create',
            '--file=-',
            '--directory',
            dirname(source),
            '--',
            c.operation.path.split('/').at(-1)!,
          ],
          {
            cwd: scope!.root,
            timeoutMs: 300000,
            diagnosticLimit: 8192,
            signal: context.signal,
            stdoutArtifactPath: output,
          },
        );
        if (r.exitCode !== 0 || r.timedOut || r.outputLimited) throw new Error('Capture failed');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(output)) hash.update(chunk);
        result = {
          ...result,
          artifact: {
            path: `${c.executionId}/${c.operation.artifact}`,
            sha256: hash.digest('hex'),
            sizeBytes: String((await stat(output)).size),
          },
        };
      } else if ('unit' in c.operation) {
        const unit = c.operation.unit;
        if (c.operation.kind === 'service_pause')
          await journal.record({ kind: 'paused', resourceId: c.resourceId, unit });
        const r = await spawnTool(
          'systemctl',
          [c.operation.kind === 'service_pause' ? 'stop' : 'start', unit],
          { cwd: scope!.root, timeoutMs: 30000, diagnosticLimit: 4096, signal: context.signal },
        );
        if (r.exitCode !== 0 || r.timedOut) throw new Error('Service operation failed');
        if (c.operation.kind === 'service_resume')
          await journal.record({ kind: 'resumed', resourceId: c.resourceId, unit });
      }
      const proof = result.docker ?? result.postgres;
      if (proof && context.resolveRepositories) {
        try {
          result = {
            ...result,
            ...(await withCommandDeadline(c, context, (scoped) =>
              runRepositoryCommand(c, scoped, repositoryPolicy!, policy.artifactRoot, proof),
            )),
          };
        } catch (error) {
          if (error instanceof CommandDeadlineError || context.signal.aborted) throw error;
          const ids = 'repositoryIds' in c.operation ? (c.operation.repositoryIds ?? []) : [];
          result = {
            ...result,
            replications: ids
              .filter((id) => id !== proof.repositoryId)
              .map((repositoryId) => ({ repositoryId, status: 'falhou' })),
          };
        }
      }
      if (postgres || docker || repositoryOperation) {
        result.staging = 'retained';
        if (!result.replications?.some((r) => r.status === 'falhou'))
          try {
            await cleanupStaging(policy.artifactRoot, c);
            result.staging = 'cleaned';
          } catch {
            /* Keep owned artifacts for inspection; capture proof remains durable. */
          }
      }
    } catch (error) {
      result = { ...result, outcome: 'failed', code: 'execution_failed' };
      if (
        error instanceof PostgresUnknownEffect ||
        error instanceof DockerUnknownEffect ||
        error instanceof CommandDeadlineError ||
        ((postgres || docker) && context.signal.aborted)
      )
        result = { ...result, outcome: 'unknown', code: 'effect_unknown' };
      if (error instanceof PostgresStageError) result = { ...result, failureStage: error.stage };
      if (error instanceof DockerStageError) result = { ...result, failureStage: error.stage };
      if (!(await resumePaused(journal, policy.resources)))
        result = { ...result, code: 'watchdog_incident' };
    }
    await journal.record({ kind: 'result', commandId: c.commandId, result });
    return result;
  }
  return {
    runCommand(command: AgentCommand, context: ExecutionContext) {
      const work = serial.then(() => execute(command, context));
      serial = work.then(
        () => {},
        () => {},
      );
      return work;
    },
  };
}
