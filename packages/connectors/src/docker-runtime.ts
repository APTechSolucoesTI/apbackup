import { repositoryHandle } from './repository-runtime.js';
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile, readFile, lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  dockerRuntimeSchema,
  dockerEvidenceSchema,
  dockerRestoredSchema,
  dockerSelectionSchema,
  dockerMountSchema,
  canonicalJson,
  type AgentCommand,
  type AgentResult,
  type ExecutionContext,
} from '@apbackup/contracts';
import { dockerClient, containerInspectSchema, type DockerPolicy } from './docker-client.js';
import { inspectDataTar } from './docker-archive.js';
import { trustedDirectory, safePath } from './runtime/safe-path.js';
import { spawnTool } from './runtime/spawn-tool.js';
import { assertCommandActive, CommandDeadlineError } from './runtime/command-deadline.js';
import { runSwarmCommand } from './swarm-runtime.js';
import { runComposeCommand } from './compose-runtime.js';
export class DockerUnknownEffect extends Error {}
export class DockerStageError extends Error {
  constructor(public readonly stage: NonNullable<AgentResult['failureStage']>) {
    super('Docker resource operation failed');
  }
}
const dataSchema = z.object({
  file: z.string().regex(/^data-\d+\.tar$/),
  mount: dockerMountSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const setSchema = z.strictObject({
  selection: dockerSelectionSchema,
  data: z.array(dataSchema).max(100),
  imageId: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  files: z
    .array(
      z.strictObject({
        name: z.string().regex(/^(data-\d+\.tar|config.enc|image.tar)$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(102),
});
async function hashFile(path: string, signal: AbortSignal) {
  const hash = createHash('sha256');
  for await (const b of createReadStream(path, { signal })) hash.update(b);
  return hash.digest('hex');
}
export function encryptConfig(text: string, password: string) {
  const salt = randomBytes(16),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv),
    bytes = Buffer.concat([cipher.update(text), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), bytes]);
}
export function decryptConfig(bytes: Buffer, password: string) {
  if (bytes.length < 44) throw new Error('Invalid encrypted configuration');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    scryptSync(password, bytes.subarray(0, 16), 32),
    bytes.subarray(16, 28),
  );
  decipher.setAuthTag(bytes.subarray(28, 44));
  return Buffer.concat([decipher.update(bytes.subarray(44)), decipher.final()]).toString();
}
export async function runDockerCommand(
  command: AgentCommand,
  context: ExecutionContext,
  policy: DockerPolicy,
  artifactRoot: string,
): Promise<Partial<AgentResult>> {
  const op = command.operation;
  if (op.kind !== 'docker_backup' && op.kind !== 'docker_restore')
    throw new Error('Unsupported resource operation');
  const active = () => assertCommandActive(command, context);
  active();
  if (!context.resolveDocker) throw new Error('Scoped resource context unavailable');
  const scoped = dockerRuntimeSchema.parse(await context.resolveDocker(command));
  active();
  if (scoped.selection.kind === 'swarm')
    return runSwarmCommand(command, context, policy, artifactRoot, scoped);
  if (scoped.selection.kind === 'compose')
    return runComposeCommand(command, context, policy, artifactRoot, scoped);
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
    ? await repositoryHandle(scoped.repository, policy, stage, command, context)
    : undefined;
  const docker = dockerClient(policy, context.signal);
  let mutation = false,
    phase: NonNullable<AgentResult['failureStage']> = 'connection';
  const authorize = async () => {
    active();
    if (!context.authorizeEffect || !(await context.authorizeEffect(command)))
      throw new Error('Effect ownership lost');
    active();
  };
  const restic = async (args: string[]) => {
    if (remote) return remote.run(args);
    active();
    const r = await spawnTool('restic', ['--no-cache', '--repo', repository, ...args], {
      cwd: stage,
      timeoutMs: Math.min(3600000, Date.parse(command.expiresAt) - Date.now()),
      diagnosticLimit: 1048576,
      signal: context.signal,
      environment: { RESTIC_PASSWORD: scoped.repositoryPassword },
    });
    active();
    if (r.exitCode !== 0 || r.timedOut || r.outputLimited)
      throw new Error('Restic operation failed');
    return r.stdout;
  };
  const mountFor = (kind: 'volume' | 'directory', identity: string, readOnly: boolean) => {
    const source = kind === 'volume' ? identity : policy.directories[identity];
    if (!source) throw new Error('Directory is not approved');
    return {
      Type: kind === 'volume' ? ('volume' as const) : ('bind' as const),
      Source: source,
      Target: '/data',
      ReadOnly: readOnly,
    };
  };
  try {
    if (op.kind === 'docker_backup') {
      const catalog = await docker.discover(),
        selection = scoped.selection;
      active();
      const capturedAt = new Date().toISOString(),
        data: z.infer<typeof dataSchema>[] = [],
        files: z.infer<typeof setSchema>['files'] = [];
      let imageId: string | null = null;
      let mounts: z.infer<typeof dockerMountSchema>[] = [];
      const addFile = async (name: string) => {
        active();
        const path = join(stage, name);
        files.push({
          name,
          sha256: await hashFile(path, context.signal),
          size: (await stat(path)).size,
        });
      };
      phase = 'capture';
      if (selection.kind === 'container') {
        const selected = catalog.containers.find((c) => c.name === selection.identity);
        if (!selected || selected.blockedReason)
          throw new Error('Container is unavailable or requires native/manual restore');
        const inspected = await docker.inspect(selected.id);
        if (inspected.Image !== selected.imageId)
          throw new Error('Container changed during discovery');
        mounts = selected.mounts;
        imageId = inspected.Image;
        await writeFile(
          join(stage, 'config.enc'),
          encryptConfig(canonicalJson(inspected), scoped.repositoryPassword),
          { flag: 'wx', mode: 0o600 },
        );
        await addFile('config.enc');
        await docker.saveImage(imageId, join(stage, 'image.tar'));
        active();
        await addFile('image.tar');
      } else if (selection.kind === 'volume') {
        const volume = catalog.volumes.find((v) => v.name === selection.identity);
        if (!volume || volume.databaseHint)
          throw new Error('Database volumes require a logical connector');
        mounts = [
          {
            kind: 'volume',
            identity: selection.identity,
            destination: '/data',
            readOnly: false,
            owners: volume.owners,
          },
        ];
      } else {
        if (!catalog.directories.some((d) => d.name === selection.identity))
          throw new Error('Directory unavailable');
        mounts = [
          {
            kind: 'directory',
            identity: selection.identity,
            destination: '/data',
            readOnly: false,
            owners: [],
          },
        ];
      }
      for (const [i, mount] of mounts.entries()) {
        active();
        await authorize();
        const file = `data-${i}.tar`;
        await docker.capture(
          mountFor(mount.kind, mount.identity, true),
          command.commandId,
          join(stage, file),
        );
        active();
        const proof = await inspectDataTar(join(stage, file), context.signal);
        if (proof.rootKind !== 'directory')
          throw new Error('Single-file mounts require the explicit Compose adapter');
        data.push({ file, mount, fingerprint: proof.fingerprint });
        await addFile(file);
      }
      if (selection.kind === 'container') {
        const after = await docker.discover(),
          current = after.containers.find((c) => c.name === selection.identity),
          before = catalog.containers.find((c) => c.name === selection.identity)!;
        if (
          !current ||
          current.id !== before.id ||
          current.imageId !== before.imageId ||
          current.blockedReason ||
          canonicalJson(current.mounts) !== canonicalJson(before.mounts)
        )
          throw new Error('Runtime/mount ownership changed during capture');
      }
      const index = setSchema.parse({ selection, data, imageId, files });
      await writeFile(join(stage, 'set.json'), canonicalJson(index), { flag: 'wx', mode: 0o600 });
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
        .object({ id: z.string() })
        .parse(JSON.parse(await restic(['cat', 'config'])));
      phase = 'snapshot';
      const output = await restic([
        'backup',
        '--json',
        '--tag',
        `apbackup:${command.executionId}`,
        '--',
        'set.json',
        ...files.map((f) => f.name),
      ]);
      const summary = output
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((v) => v.message_type === 'summary');
      const snapshotId = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(summary?.snapshot_id);
      phase = 'verification';
      await restic(['check', '--read-data']);
      const verified = await trustedDirectory(join(stage, 'verified'), {
        create: true,
        private: true,
      });
      await restic(['restore', snapshotId, '--target', verified]);
      const sha256 = await hashFile(join(stage, 'set.json'), context.signal);
      if ((await hashFile(await safePath(verified, 'set.json'), context.signal)) !== sha256)
        throw new Error('Recovery set mismatch');
      for (const file of files)
        if ((await hashFile(await safePath(verified, file.name), context.signal)) !== file.sha256)
          throw new Error('Restored component differs');
      active();
      const sizeBytes = String((await stat(join(stage, 'set.json'))).size),
        totalSizeBytes = String(files.reduce((n, f) => n + f.size, 0) + Number(sizeBytes));
      return {
        docker: dockerEvidenceSchema.parse({
          repositoryId: op.repositoryId,
          nativeRepositoryId: config.id,
          snapshotId,
          capturedAt,
          sha256,
          sizeBytes,
          totalSizeBytes,
          selection,
          imageId,
          components: files.map((f) => f.name),
          artifacts: files.map((f) => ({
            name: f.name,
            sha256: f.sha256,
            sizeBytes: String(f.size),
          })),
          consistency: 'crash_consistent',
        }),
        artifact: { path: `${command.executionId}/set.json`, sha256, sizeBytes },
      };
    }
    phase = 'repository';
    const config = z.object({ id: z.string() }).parse(JSON.parse(await restic(['cat', 'config'])));
    if (config.id !== op.nativeRepositoryId) throw new Error('Repository changed');
    const restored = await trustedDirectory(join(stage, 'restored'), {
      create: true,
      private: true,
    });
    await restic(['restore', op.snapshotId, '--target', restored]);
    const setPath = await safePath(restored, 'set.json');
    if ((await hashFile(setPath, context.signal)) !== op.sha256)
      throw new Error('Recovery set changed');
    const index = setSchema.parse(JSON.parse(await readFile(setPath, 'utf8')));
    if (canonicalJson(index.selection) !== canonicalJson(scoped.selection))
      throw new Error('Historical binding changed');
    for (const file of index.files)
      if ((await hashFile(await safePath(restored, file.name), context.signal)) !== file.sha256)
        throw new Error('Component hash mismatch');
    for (const item of index.data)
      if (
        (await inspectDataTar(await safePath(restored, item.file), context.signal)).fingerprint !==
        item.fingerprint
      )
        throw new Error('Unsafe/mismatching data archive');
    phase = 'target';
    const targets: string[] = [];
    let historical: z.infer<typeof containerInspectSchema> | null = null,
      current: z.infer<typeof containerInspectSchema> | null = null;
    if (scoped.selection.kind === 'container') {
      if (!op.replaceContainer || op.targetName !== scoped.selection.identity || !index.imageId)
        throw new Error('Explicit scoped application return required');
      historical = containerInspectSchema.parse(
        JSON.parse(
          decryptConfig(
            await readFile(await safePath(restored, 'config.enc')),
            scoped.configurationPassword ?? scoped.repositoryPassword,
          ),
        ),
      );
      if (historical.Image !== index.imageId) throw new Error('Image identity mismatch');
      const catalog = await docker.discover(),
        selected = catalog.containers.find((c) => c.name === op.targetName);
      if (!selected || selected.blockedReason || selected.id !== op.targetContainerId)
        throw new Error('Target runtime identity changed or requires manual/native adapter');
      current = await docker.inspect(selected.id);
      // Captured mounts and current target must both be exclusive. Database changes are never part of this operation.
      if (
        index.data.some((d) => d.mount.owners.length !== 1 || d.mount.owners[0] !== historical!.Id)
      )
        throw new Error('Historical shared mount is not owned by this application');
      // Exercise the stored code artifact on every return, even with a warm daemon cache.
      await authorize();
      mutation = true;
      await docker.loadImage(createReadStream(await safePath(restored, 'image.tar')));
      active();
      if (!(await docker.imageExists(index.imageId)))
        throw new Error('Historical image unavailable');
    } else if (op.replaceContainer)
      throw new Error('Individual data restore requires a new target');
    const runtimeMounts: { Type: 'volume'; Source: string; Target: string; ReadOnly: boolean }[] =
      [];
    for (const [i, item] of index.data.entries()) {
      const name =
        scoped.selection.kind === 'container'
          ? `apbackup-${command.executionId.slice(0, 18)}-${i}`
          : op.targetName;
      await authorize();
      active();
      let helper: string,
        verifyMount: ReturnType<typeof mountFor>,
        extractPath = '/data';
      if (scoped.selection.kind === 'directory') {
        const root = policy.directories[scoped.selection.identity];
        if (!root) throw new Error('Restore root not approved');
        mutation = true;
        helper = await docker.prepareDirectory(root, name, command.commandId);
        extractPath = '/data/' + name;
        verifyMount = { Type: 'bind', Source: root + '/' + name, Target: '/data', ReadOnly: true };
      } else {
        await docker.volumeAbsent(name);
        active();
        mutation = true;
        await docker.createVolume(name, command.commandId);
        verifyMount = { Type: 'volume', Source: name, Target: '/data', ReadOnly: true };
        helper = await docker.helper({ ...verifyMount, ReadOnly: false }, command.commandId);
        runtimeMounts.push({
          Type: 'volume',
          Source: name,
          Target: item.mount.destination,
          ReadOnly: item.mount.readOnly,
        });
      }
      try {
        await authorize();
        phase = 'restore';
        await docker.extract(
          helper,
          extractPath,
          createReadStream(await safePath(restored, item.file)),
        );
        active();
      } finally {
        if (!context.signal.aborted) await docker.removeHelper(helper, command.commandId);
      }
      const check = join(stage, `check-${i}.tar`);
      await docker.capture(verifyMount, command.commandId, check);
      active();
      if ((await inspectDataTar(check, context.signal)).fingerprint !== item.fingerprint)
        throw new Error('Restored files or permissions differ');
      targets.push(name);
    }
    if (historical && current) {
      phase = 'target';
      const preservation = `apbackup-old-${command.executionId}`,
        temp = `apbackup-new-${command.executionId}`;
      const labels = { ...historical.Config.Labels, 'apbackup.restore': command.commandId };
      await authorize();
      mutation = true;
      const newId = await docker.createContainer(temp, {
        ...historical.Config,
        Image: index.imageId,
        Labels: labels,
        HostConfig: {
          NetworkMode: historical.HostConfig.NetworkMode,
          PortBindings: historical.NetworkSettings.Ports,
          RestartPolicy: historical.HostConfig.RestartPolicy,
          Mounts: runtimeMounts,
          CapDrop: historical.HostConfig.CapDrop,
          ReadonlyRootfs: historical.HostConfig.ReadonlyRootfs,
          SecurityOpt: historical.HostConfig.SecurityOpt,
        },
      });
      await authorize();
      const fresh = await docker.discover(),
        target = fresh.containers.find((c) => c.name === op.targetName);
      if (!target || target.id !== current.Id || target.blockedReason)
        throw new Error('Target ownership changed');
      active();
      await docker.stop(current.Id);
      active();
      await authorize();
      await docker.rename(current.Id, preservation);
      active();
      await authorize();
      await docker.rename(newId, op.targetName);
      active();
      await authorize();
      await docker.start(newId);
      active();
      let health: 'running' | 'healthy' = 'running',
        ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        active();
        const inspected = await docker.inspect(newId);
        if (!inspected.State.Running) throw new Error('Restored application did not stay running');
        if (!inspected.State.Health || inspected.State.Health.Status === 'healthy') {
          health = inspected.State.Health ? 'healthy' : 'running';
          ready = true;
          break;
        }
        if (inspected.State.Health.Status === 'unhealthy')
          throw new Error('Restored application healthcheck failed');
        await delay(1000, undefined, { signal: context.signal });
      }
      if (!ready) throw new Error('Application healthcheck deadline');
      active();
      return {
        dockerRestored: dockerRestoredSchema.parse({
          targetName: op.targetName,
          kind: 'container',
          containerId: newId,
          preservedContainerId: current.Id,
          targets: targets.length ? targets : [op.targetName],
          verifiedAt: new Date().toISOString(),
          running: true,
          health,
        }),
      };
    }
    active();
    return {
      dockerRestored: dockerRestoredSchema.parse({
        targetName: op.targetName,
        kind: scoped.selection.kind,
        targets,
        verifiedAt: new Date().toISOString(),
        running: false,
        health: 'not_applicable',
      }),
    };
  } catch (e) {
    if (e instanceof CommandDeadlineError || context.signal.aborted)
      throw new CommandDeadlineError();
    if (mutation)
      throw new DockerUnknownEffect(
        'Inspect labeled new targets and preserved original before any retry',
      );
    throw new DockerStageError(phase);
  } finally {
    await remote?.close();
  }
}
