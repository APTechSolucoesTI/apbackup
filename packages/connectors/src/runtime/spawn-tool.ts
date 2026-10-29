import { spawn } from 'node:child_process';
import { realpath, stat, open } from 'node:fs/promises';
import { redact } from '../../../security/src/redaction.js';
export type AllowedTool = 'tar' | 'systemctl' | 'pg_dump' | 'pg_restore' | 'restic' | 'rclone';
export interface ToolRunOptions {
  cwd: string;
  stdinText?: string;
  timeoutMs: number;
  diagnosticLimit: number;
  signal?: AbortSignal;
  stdoutArtifactPath?: string;
  environment?: Partial<
    Record<
      | 'PGHOST'
      | 'PGPORT'
      | 'PGUSER'
      | 'PGDATABASE'
      | 'PGPASSFILE'
      | 'PGSSLMODE'
      | 'PGSSLROOTCERT'
      | 'RESTIC_PASSWORD'
      | 'RESTIC_FROM_PASSWORD'
      | 'AWS_ACCESS_KEY_ID'
      | 'AWS_SECRET_ACCESS_KEY'
      | 'AWS_SESSION_TOKEN'
      | 'AWS_DEFAULT_REGION',
      string
    >
  >;
}
export interface ToolResult {
  exitCode: number | null;
  signal: string | null;
  diagnostics: string;
  timedOut: boolean;
  outputLimited: boolean;
  stdout: string;
}
export async function spawnTool(
  tool: AllowedTool,
  args: readonly string[],
  options: ToolRunOptions,
): Promise<ToolResult> {
  const executables: Record<AllowedTool, string> = {
    tar: '/usr/bin/tar',
    systemctl: '/usr/bin/systemctl',
    pg_dump: '/usr/lib/postgresql/17/bin/pg_dump',
    pg_restore: '/usr/lib/postgresql/17/bin/pg_restore',
    restic: '/usr/local/bin/restic',
    rclone: '/usr/local/bin/rclone',
  };
  if (!Object.hasOwn(executables, tool) || process.platform !== 'linux')
    throw new Error('Tool not authorized on this host');
  if (
    options.timeoutMs < 1 ||
    options.timeoutMs > 3600000 ||
    options.diagnosticLimit < 1 ||
    options.diagnosticLimit > 1048576 ||
    args.some((v) => v.includes('\0'))
  )
    throw new Error('Invalid tool limits');
  const binary = await realpath(executables[tool]);
  if (binary !== executables[tool]) throw new Error('Executable symlink refused');
  const allowedEnvironment = [
    'PGHOST',
    'PGPORT',
    'PGUSER',
    'PGDATABASE',
    'PGPASSFILE',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'RESTIC_PASSWORD',
    'RESTIC_FROM_PASSWORD',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_DEFAULT_REGION',
  ];
  if (
    options.environment &&
    Object.keys(options.environment).some((key) => !allowedEnvironment.includes(key))
  )
    throw new Error('Environment refused');
  const permissions = await stat(binary);
  if (permissions.uid !== 0 || (permissions.mode & 0o022) !== 0)
    throw new Error('Unsafe executable');
  await realpath(options.cwd);
  const artifact = options.stdoutArtifactPath
    ? await open(options.stdoutArtifactPath, 'wx', 0o600)
    : null;
  try {
    return await new Promise<ToolResult>((resolve, reject) => {
      const child = spawn(binary, [...args], {
        cwd: options.cwd,
        shell: false,
        detached: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ...options.environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdinText ?? '');
      let chunks: Buffer[] = [],
        stdoutChunks: Buffer[] = [],
        size = 0,
        timedOut = false,
        outputLimited = false;
      let artifactWrite = Promise.resolve();
      let artifactError: unknown;
      let killTimer: NodeJS.Timeout | undefined;
      const kill = () => {
        if (killTimer) return;
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          /* already exited */
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            /* exited */
          }
        }, 500);
        killTimer.unref();
      };
      const diagnostic = (chunk: Buffer) => {
        const remaining = options.diagnosticLimit - size;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          size += Math.min(chunk.length, remaining);
        }
        if (chunk.length > remaining) {
          outputLimited = true;
          kill();
        }
      };
      child.stderr.on('data', diagnostic);
      child.stdout.on('data', (chunk: Buffer) => {
        if (artifact) {
          child.stdout.pause();
          artifactWrite = artifactWrite
            .then(async () => {
              await artifact.writeFile(chunk);
              child.stdout.resume();
            })
            .catch((error: unknown) => {
              artifactError = error;
              child.stdout.resume();
              kill();
            });
        } else {
          stdoutChunks.push(chunk.subarray(0, Math.max(0, options.diagnosticLimit - size)));
          diagnostic(chunk);
        }
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
      const abort = () => kill();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) kill();
      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.once('error', (e) => {
        cleanup();
        reject(e);
      });
      child.once('close', (exitCode, signal) => {
        cleanup();
        void artifactWrite
          .then(async () => {
            if (artifactError) throw artifactError;
            await artifact?.sync();
            const text = String(redact(Buffer.concat(chunks).toString('utf8')))
              .replace(/\b(Bearer|Basic)\s+/gi, '')
              .replace(/-----BEGIN/gi, '[removed]');
            chunks = [];
            resolve({
              exitCode,
              signal,
              diagnostics: text,
              timedOut,
              outputLimited,
              stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            });
            stdoutChunks = [];
          })
          .catch(reject);
      });
    });
  } finally {
    await artifact?.close();
  }
}
