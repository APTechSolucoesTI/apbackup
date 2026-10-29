import { repositoryHandle } from './repository-runtime.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile, unlink, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  postgresRuntimeSecretsSchema,
  postgresEvidenceSchema,
  postgresRestoreEvidenceSchema,
  type AgentCommand,
  type AgentResult,
  type ExecutionContext,
} from '@apbackup/contracts';
import { trustedDirectory, safePath } from './runtime/safe-path.js';
import { spawnTool, type AllowedTool } from './runtime/spawn-tool.js';
import { postgresClient } from './postgresql-connection.js';
import { inspectPostgresSchemaScope } from './postgresql-schemas.js';
import { assertCommandActive, CommandDeadlineError } from './runtime/command-deadline.js';
export interface PostgresPolicy {
  allowedHosts: readonly string[];
  repositoryRoot: string;
  mountedRoots?: readonly string[] | undefined;
  storageHosts?: readonly string[] | undefined;
}
export class PostgresUnknownEffect extends Error {}
export class PostgresStageError extends Error {
  constructor(public readonly stage: NonNullable<AgentResult['failureStage']>) {
    super('PostgreSQL operation failed');
  }
}
async function hashFile(path: string, signal: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
function quoteIdentifier(name: string) {
  return '"' + name.replaceAll('"', '""') + '"';
}
export async function runPostgresCommand(
  command: AgentCommand,
  context: ExecutionContext,
  policy: PostgresPolicy,
  artifactRoot: string,
): Promise<Partial<AgentResult>> {
  const op = command.operation;
  if (op.kind !== 'postgresql_backup' && op.kind !== 'postgresql_restore')
    throw new Error('Unsupported operation');
  if (!context.resolvePostgres) throw new Error('Scoped context unavailable');
  const active = () => assertCommandActive(command, context);
  active();
  const scoped = postgresRuntimeSecretsSchema.parse(await context.resolvePostgres(command)),
    connection = scoped.connection;
  active();
  if (!policy.allowedHosts.includes(connection.host)) throw new Error('Unapproved database host');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(scoped.repositoryPath))
    throw new Error('Dedicated relative repository key required');
  await trustedDirectory(policy.repositoryRoot, { private: true });
  await trustedDirectory(artifactRoot, { private: true });
  const repository = await trustedDirectory(join(policy.repositoryRoot, scoped.repositoryPath), {
    create: true,
    private: true,
  });
  const stage = await trustedDirectory(join(artifactRoot, command.executionId), {
    create: true,
    private: true,
  });
  const remote = scoped.repository
    ? await repositoryHandle(
        scoped.repository,
        { ...policy, allowedHosts: policy.storageHosts ?? policy.allowedHosts },
        stage,
        command,
        context,
      )
    : undefined;
  const pgpass = join(stage, 'connection.pgpass'),
    escape = (v: string) => v.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  await writeFile(
    pgpass,
    [connection.host, String(connection.port), '*', connection.username, connection.password]
      .map(escape)
      .join(':') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const environment = {
    PGHOST: connection.host,
    PGPORT: String(connection.port),
    PGUSER: connection.username,
    PGDATABASE: scoped.database,
    PGPASSFILE: pgpass,
    PGSSLMODE: connection.sslMode,
    PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt',
    RESTIC_PASSWORD: scoped.repositoryPassword,
  };
  const run = async (tool: AllowedTool, args: string[], artifact?: string) => {
    active();
    const result = await spawnTool(tool, args, {
      cwd: stage,
      timeoutMs: Math.min(3600000, Date.parse(command.expiresAt) - Date.now()),
      diagnosticLimit: 1048576,
      signal: context.signal,
      environment,
      ...(artifact ? { stdoutArtifactPath: artifact } : {}),
    });
    active();
    if (result.exitCode !== 0 || result.timedOut || result.outputLimited)
      throw new Error('Approved tool failed');
    return result.stdout;
  };
  const restic = (args: string[]) =>
    remote ? remote.run(args) : run('restic', ['--no-cache', '--repo', repository, ...args]);
  let created = false;
  let phase: NonNullable<AgentResult['failureStage']> = 'connection';
  // Closing the active pg connection interrupts connect/query/CREATE/count work
  // when the same overall command budget expires.
  const clients = new Set<ReturnType<typeof postgresClient>>();
  const abortSQL = () => {
    for (const client of clients) void client.end().catch(() => {});
  };
  context.signal.addEventListener('abort', abortSQL, { once: true });
  const connect = async (database: string) => {
    active();
    const client = postgresClient(connection, database);
    clients.add(client);
    await client.connect();
    active();
    return client;
  };
  try {
    const control = await connect('postgres');
    try {
      const version = Number(
        (
          await control.query<{ version: string }>(
            "select current_setting('server_version_num') as version",
          )
        ).rows[0]!.version,
      );
      if (Math.floor(version / 10000) !== 17)
        throw new Error('Matching PostgreSQL 17 runtime required');
      if (op.kind === 'postgresql_restore') {
        if (
          op.targetDatabase === scoped.database ||
          (await control.query('select 1 from pg_database where datname=$1', [op.targetDatabase]))
            .rowCount
        )
          throw new Error('Target database must be absent');
      }
    } finally {
      await control.end();
      clients.delete(control);
    }
    const archive = join(stage, 'database.dump');
    if (op.kind === 'postgresql_backup') {
      phase = 'capture';
      if (scoped.schemas.length) {
        const source = await connect(scoped.database);
        try {
          if (!(await inspectPostgresSchemaScope(source, scoped.schemas)).isolated)
            throw new Error('Cross-schema dependencies require manual reconstruction');
        } finally {
          await source.end();
          clients.delete(source);
        }
      }
      const capturedAt = new Date().toISOString();
      await run(
        'pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '--no-password',
          ...scoped.schemas.map((s) => `--schema=${s}`),
        ],
        archive,
      );
      phase = 'archive';
      await run('pg_restore', ['--list', archive]);
      phase = 'repository';
      let exists = false;
      try {
        await lstat(join(repository, 'config'));
        exists = true;
      } catch (e) {
        if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e;
      }
      if (!exists) await restic(['init', '--repository-version', '2']);
      const config = z
        .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(await restic(['cat', 'config'])));
      phase = 'snapshot';
      const output = await restic([
        'backup',
        '--json',
        '--tag',
        `apbackup:${command.executionId}`,
        '--',
        'database.dump',
      ]);
      const summary = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((value) => value.message_type === 'summary');
      const snapshotId = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(summary?.snapshot_id);
      phase = 'verification';
      await restic(['check', '--read-data']);
      const originalHash = await hashFile(archive, context.signal);
      active();
      const verified = await trustedDirectory(join(stage, 'verified'), {
        create: true,
        private: true,
      });
      await restic(['restore', snapshotId, '--target', verified]);
      const recovered = await safePath(verified, 'database.dump');
      if ((await hashFile(recovered, context.signal)) !== originalHash)
        throw new Error('Snapshot artifact hash mismatch');
      active();
      const evidence = postgresEvidenceSchema.parse({
        repositoryId: op.repositoryId,
        nativeRepositoryId: config.id,
        snapshotId,
        database: scoped.database,
        schemas: scoped.schemas,
        serverMajor: 17,
        capturedAt,
        sha256: originalHash,
        sizeBytes: String((await stat(archive)).size),
      });
      return {
        postgres: evidence,
        artifact: {
          path: `${command.executionId}/database.dump`,
          sha256: evidence.sha256,
          sizeBytes: evidence.sizeBytes,
        },
      };
    }
    phase = 'repository';
    const config = z.object({ id: z.string() }).parse(JSON.parse(await restic(['cat', 'config'])));
    if (config.id !== op.nativeRepositoryId) throw new Error('Repository identity mismatch');
    const restored = await trustedDirectory(join(stage, 'restored'), {
      create: true,
      private: true,
    });
    await restic(['restore', op.snapshotId, '--target', restored]);
    const dump = await safePath(restored, 'database.dump');
    if ((await hashFile(dump, context.signal)) !== op.sha256)
      throw new Error('Snapshot artifact hash mismatch');
    await run('pg_restore', ['--list', dump]);
    phase = 'target';
    // A new effect authorization immediately before CREATE. Never replay uncertain CREATE/restore.
    if (!context.authorizeEffect || !(await context.authorizeEffect(command)))
      throw new Error('Lease no longer valid');
    active();
    const admin = await connect('postgres');
    try {
      if (
        (await admin.query('select 1 from pg_database where datname=$1', [op.targetDatabase]))
          .rowCount
      )
        throw new Error('Target collision');
      active();
      created = true;
      await admin.query(`create database ${quoteIdentifier(op.targetDatabase)} template template0`);
    } finally {
      await admin.end();
      clients.delete(admin);
    }
    environment.PGDATABASE = op.targetDatabase;
    phase = 'restore';
    await run('pg_restore', [
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-acl',
      '--no-password',
      '--dbname',
      op.targetDatabase,
      dump,
    ]);
    const target = await connect(op.targetDatabase);
    try {
      const tables = (
        await target.query<{ schema: string; name: string }>(
          "select schemaname as schema,tablename as name from pg_tables where schemaname not in('pg_catalog','information_schema') order by schemaname,tablename",
        )
      ).rows;
      if (tables.length > 10000) throw new Error('Verification table limit');
      const counts = [];
      for (const table of tables) {
        active();
        const count = (
          await target.query<{ count: string }>(
            `select count(*)::text as count from ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`,
          )
        ).rows[0]!.count;
        counts.push({ ...table, rows: count });
      }
      active();
      return {
        restored: postgresRestoreEvidenceSchema.parse({
          database: op.targetDatabase,
          schemas: scoped.schemas,
          tables: counts,
          verifiedAt: new Date().toISOString(),
        }),
      };
    } finally {
      await target.end();
      clients.delete(target);
    }
  } catch (error) {
    if (error instanceof CommandDeadlineError || context.signal.aborted)
      throw new CommandDeadlineError();
    if (created) throw new PostgresUnknownEffect('New target may exist; inspect before any retry');
    throw new PostgresStageError(phase);
  } finally {
    context.signal.removeEventListener('abort', abortSQL);
    for (const client of clients) await client.end().catch(() => {});
    await remote?.close();
    await unlink(pgpass);
  }
}
