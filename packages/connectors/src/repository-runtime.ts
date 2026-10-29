import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile, unlink, readFile, readdir, lstat, rm, statfs } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import type {
  AgentCommand,
  AgentResult,
  ExecutionContext,
  RepositoryRuntime,
} from '@apbackup/contracts';
import { spawnTool, type ToolRunOptions } from './runtime/spawn-tool.js';
import { safePath, trustedDirectory } from './runtime/safe-path.js';
import { assertCommandActive } from './runtime/command-deadline.js';
export interface RepositoryPolicy {
  repositoryRoot: string;
  mountedRoots?: readonly string[] | undefined;
  allowedHosts?: readonly string[] | undefined;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export async function fileHash(path: string, signal: AbortSignal) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) h.update(chunk);
  return h.digest('hex');
}
export async function repositoryHandle(
  repository: RepositoryRuntime,
  policy: RepositoryPolicy,
  stage: string,
  command: AgentCommand,
  context: ExecutionContext,
) {
  const c = repository.configuration,
    credential = repository.credential;
  const configurationPath = join(stage, `rclone-${repository.repositoryId}.conf`);
  let location: string,
    extra: string[] = [];
  const environment: NonNullable<ToolRunOptions['environment']> = {
    RESTIC_PASSWORD: credential.secret,
  };
  const run = async (
    tool: 'restic' | 'rclone',
    args: string[],
    env = environment,
    stdinText?: string,
  ) => {
    assertCommandActive(command, context);
    const result = await spawnTool(tool, args, {
      cwd: stage,
      timeoutMs: Math.min(3600000, Date.parse(command.expiresAt) - Date.now()),
      diagnosticLimit: 1048576,
      signal: context.signal,
      environment: env,
      ...(stdinText ? { stdinText } : {}),
    });
    assertCommandActive(command, context);
    if (result.exitCode !== 0 || result.timedOut || result.outputLimited)
      throw new Error('Repository operation failed');
    return result.stdout;
  };
  if (repository.kind === 'local') {
    if (c?.backend === 'mounted') {
      if (
        !(policy.mountedRoots ?? []).includes(repository.rootPath) ||
        !isAbsolute(repository.rootPath)
      )
        throw new Error('Explicit mounted dedicated path not approved');
      location = await trustedDirectory(repository.rootPath, { private: true });
    } else {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(repository.rootPath))
        throw new Error('Invalid local repository key');
      await trustedDirectory(policy.repositoryRoot, { private: true });
      location = await trustedDirectory(join(policy.repositoryRoot, repository.rootPath), {
        private: true,
        create: true,
      });
    }
  } else {
    if (
      !c ||
      c.backend !== repository.kind ||
      !repository.rootPath.split('/').every((p) => /^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/.test(p))
    )
      throw new Error('Dedicated backend configuration required');
    if (repository.kind === 's3') {
      const endpoint = new URL(c.endpoint ?? 'https://s3.amazonaws.com');
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== '/' ||
        (!['localhost', '127.0.0.1'].includes(endpoint.hostname) &&
          endpoint.protocol !== 'https:') ||
        !(policy.allowedHosts ?? []).includes(endpoint.hostname) ||
        !c.bucket ||
        !credential.accessKey ||
        !credential.secretKey
      )
        throw new Error('S3 endpoint/credential not approved');
      location = `s3:${endpoint.origin}/${c.bucket}/${repository.rootPath}`;
      Object.assign(environment, {
        AWS_ACCESS_KEY_ID: credential.accessKey,
        AWS_SECRET_ACCESS_KEY: credential.secretKey,
        AWS_DEFAULT_REGION: c.region ?? 'us-east-1',
        ...(credential.sessionToken ? { AWS_SESSION_TOKEN: credential.sessionToken } : {}),
      });
    } else {
      const lines = ['[destination]'];
      if (repository.kind === 'google_drive') {
        if (!credential.driveToken) throw new Error('Configured OAuth token required');
        lines.push(
          'type = drive',
          'scope = drive.file',
          `token = ${JSON.stringify(credential.driveToken)}`,
        );
        if (credential.clientId) lines.push(`client_id = ${credential.clientId}`);
        if (credential.clientSecret) lines.push(`client_secret = ${credential.clientSecret}`);
        if (c.rootFolderId) lines.push(`root_folder_id = ${c.rootFolderId}`);
      } else {
        if (
          !repository.host ||
          !(policy.allowedHosts ?? []).includes(repository.host) ||
          !credential.username ||
          !credential.password
        )
          throw new Error('Approved remote credential required');
        const obscured = (await run('rclone', ['obscure', '-'], {}, credential.password)).trim();
        lines.push(
          `type = ${repository.kind}`,
          `host = ${repository.host}`,
          `user = ${credential.username}`,
          `pass = ${obscured}`,
          `port = ${c.port ?? (repository.kind === 'sftp' ? 22 : 445)}`,
        );
        if (repository.kind === 'sftp') {
          if (!c.hostKey) throw new Error('Pinned host key required');
          const known = join(stage, `known-${repository.repositoryId}`);
          await writeFile(
            known,
            `[${repository.host}]:${c.port ?? 22} ${c.hostKey}\n${repository.host} ${c.hostKey}\n`,
            { mode: 0o600, flag: 'wx' },
          );
          lines.push(`known_hosts_file = ${known}`);
        } else if (repository.kind === 'smb') {
          if (!c.share) throw new Error('Explicit SMB share required');
          if (c.domain) lines.push(`domain = ${c.domain}`);
        } else throw new Error('Backend unsupported');
      }
      await writeFile(configurationPath, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      location = `rclone:destination:${repository.kind === 'smb' ? c.share + '/' : ''}${repository.rootPath}`;
      extra = [
        '-o',
        'rclone.program=/usr/local/bin/rclone',
        '-o',
        `rclone.args=serve restic --stdio --config ${configurationPath}`,
      ];
    }
  }
  return {
    location,
    environment,
    extra,
    run: (args: string[], additional: NonNullable<ToolRunOptions['environment']> = {}) =>
      run('restic', ['--no-cache', '--repo', location, ...extra, ...args], {
        ...environment,
        ...additional,
      }),
    close: async () => {
      for (const path of [
        configurationPath,
        configurationPath + '.old',
        configurationPath + '.tmp',
        configurationPath + '.bak',
      ])
        await unlink(path).catch(() => {});
      await unlink(join(stage, `known-${repository.repositoryId}`)).catch(() => {});
    },
    async initialize() {
      if (repository.nativeRepositoryId === null) {
        // Restic init is confined to the configured dedicated prefix and never removes existing objects.
        try {
          return digest.parse(
            (JSON.parse(await this.run(['cat', 'config'])) as { id: unknown }).id,
          );
        } catch {
          await this.run(['init', '--repository-version', '2']);
        }
      }
      const id = digest.parse(
        (JSON.parse(await this.run(['cat', 'config'])) as { id: unknown }).id,
      );
      if (repository.nativeRepositoryId && id !== repository.nativeRepositoryId)
        throw new Error('Repository identity mismatch');
      return id;
    },
  };
}
export async function runRepositoryCommand(
  command: AgentCommand,
  context: ExecutionContext,
  policy: RepositoryPolicy,
  artifactRoot: string,
  proof?: AgentResult['postgres'] | AgentResult['docker'],
): Promise<Partial<AgentResult>> {
  if (!context.resolveRepositories) {
    if (proof) return {};
    throw new Error('Scoped repositories unavailable');
  }
  const resolved = await context.resolveRepositories(command),
    op = command.operation;
  await trustedDirectory(artifactRoot, { private: true });
  const stage = await trustedDirectory(join(artifactRoot, command.executionId), {
    create: true,
    private: true,
  });
  const replications: NonNullable<AgentResult['replications']> = [];
  const sourceId =
    proof?.repositoryId ?? (op.kind === 'repository_copy' ? op.sourceRepositoryId : null);
  const snapshot = proof?.snapshotId ?? (op.kind === 'repository_copy' ? op.snapshotId : null);
  const source = resolved.repositories.find((r) => r.repositoryId === sourceId);
  if (op.kind === 'repository_copy' || proof) {
    if (!source || !snapshot) throw new Error('Verified capture source required');
    const from = await repositoryHandle(source, policy, stage, command, context);
    try {
      await from.initialize();
      const sourceSnapshot = z
        .array(z.object({ id: digest, original: digest.optional() }))
        .parse(JSON.parse(await from.run(['snapshots', '--json', snapshot])))[0];
      if (!sourceSnapshot || sourceSnapshot.id !== snapshot)
        throw new Error('Exact finalized source snapshot missing');
      const origin = sourceSnapshot.original ?? snapshot;
      const files = proof
        ? 'artifacts' in proof
          ? [
              { name: 'set.json', sha256: proof.sha256 },
              ...proof.artifacts.map((f) => ({ name: f.name, sha256: f.sha256 })),
            ]
          : [{ name: 'database.dump', sha256: proof.sha256 }]
        : resolved.files;
      for (const target of resolved.repositories.filter((r) => r.repositoryId !== sourceId)) {
        let to: Awaited<ReturnType<typeof repositoryHandle>> | undefined;
        try {
          if (!context.authorizeEffect || !(await context.authorizeEffect(command)))
            throw new Error('Effect no longer authorized');
          to = await repositoryHandle(target, policy, stage, command, context);
          const nativeRepositoryId = await to.initialize();
          // Capture source is local: target backend credentials never replace source credentials.
          if (source.kind !== 'local')
            throw new Error('Copy requires local finalized capture repository');
          await to.run(['copy', '--from-repo', from.location, snapshot], {
            RESTIC_FROM_PASSWORD: source.credential.secret,
          });
          const snapshots = z
            .array(z.object({ id: digest, original: digest.optional() }))
            .parse(JSON.parse(await to.run(['snapshots', '--json'])));
          const copied = snapshots.find((s) => s.id === origin || s.original === origin);
          if (!copied) throw new Error('Copied snapshot missing');
          await to.run(['check', '--read-data']);
          const verified = await trustedDirectory(join(stage, `copy-${target.repositoryId}`), {
            create: true,
            private: true,
          });
          await to.run(['restore', copied.id, '--target', verified]);
          if (!files.length) throw new Error('Component evidence missing');
          for (const file of files)
            if (
              (await fileHash(await safePath(verified, file.name), context.signal)) !== file.sha256
            )
              throw new Error('Copied bytes mismatch');
          replications.push({
            repositoryId: target.repositoryId,
            status: 'concluida',
            nativeRepositoryId,
            snapshotId: copied.id,
            verifiedAt: new Date().toISOString(),
          });
        } catch {
          replications.push({ repositoryId: target.repositoryId, status: 'falhou' });
        } finally {
          await to?.close();
        }
      }
    } finally {
      await from.close();
    }
    if (
      resolved.cleanup &&
      replications.length &&
      replications.every((r) => r.status === 'concluida')
    ) {
      try {
        await cleanupStaging(artifactRoot, { ...command, ...resolved.cleanup });
      } catch {
        /* Never remove foreign/unknown staging; leave it for inspection. */
      }
    }
    return { replications };
  }
  const target = resolved.repositories.find(
    (r) => r.repositoryId === ('repositoryId' in op ? op.repositoryId : ''),
  );
  if (!target) throw new Error('Destination missing');
  const handle = await repositoryHandle(target, policy, stage, command, context);
  try {
    const nativeRepositoryId = await handle.initialize();
    if (op.kind === 'repository_test') {
      await handle.run(['check']);
      return {
        repository: {
          repositoryId: target.repositoryId,
          nativeRepositoryId,
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    if (op.kind !== 'repository_retention' || !resolved.retention)
      throw new Error('Unsupported repository operation');
    if (!context.authorizeEffect || !(await context.authorizeEffect(command)))
      throw new Error('Retention ownership lost');
    const forget = resolved.retention.forget.map((id) => digest.parse(id)),
      protect = resolved.retention.protect.map((id) => digest.parse(id));
    if (forget.some((id) => protect.includes(id)))
      throw new Error('Protected snapshot deletion refused');
    if (forget.length) await handle.run(['forget', '--prune', ...forget]);
    return {
      retention: {
        repositoryId: target.repositoryId,
        forgotten: forget,
        protected: protect,
        pruned: forget.length > 0,
      },
    };
  } finally {
    await handle.close();
  }
}
export async function stagingPreflight(root: string) {
  await trustedDirectory(root, { private: true });
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < 512 * 1024 * 1024) throw new Error('Insufficient staging space');
  let bytes = 0,
    entries = 0;
  const visit = async (path: string) => {
    for (const name of await readdir(path)) {
      if (++entries > 10000) throw new Error('Staging inspection limit');
      const p = join(path, name),
        s = await lstat(p);
      if (s.isSymbolicLink()) throw new Error('Staging symlink refused');
      if (s.isDirectory()) await visit(p);
      else bytes += s.size;
      if (bytes > 20 * 1024 ** 3) throw new Error('Staging storage budget exceeded');
    }
  };
  await visit(root);
}
export async function ownStaging(root: string, command: AgentCommand) {
  const stage = await trustedDirectory(join(root, command.executionId), {
    create: true,
    private: true,
  });
  await writeFile(
    join(stage, '.apbackup-owner'),
    JSON.stringify({
      organizationId: command.organizationId,
      executionId: command.executionId,
      commandId: command.commandId,
    }),
    { flag: 'wx', mode: 0o600 },
  );
}
export async function cleanupStaging(root: string, command: AgentCommand) {
  if (!z.uuid().safeParse(command.executionId).success) throw new Error('Invalid owned execution');
  const stage = await safePath(root, command.executionId),
    marker = JSON.parse(await readFile(await safePath(stage, '.apbackup-owner'), 'utf8')) as Record<
      string,
      unknown
    >;
  if (
    marker.organizationId !== command.organizationId ||
    marker.executionId !== command.executionId ||
    marker.commandId !== command.commandId
  )
    throw new Error('Foreign staging refused');
  const inspect = async (p: string) => {
    for (const n of await readdir(p)) {
      const child = join(p, n),
        s = await lstat(child);
      if (s.isSymbolicLink()) throw new Error('Staging symlink refused');
      if (s.isDirectory()) await inspect(child);
    }
  };
  await inspect(stage);
  await rm(stage, { recursive: true });
}
