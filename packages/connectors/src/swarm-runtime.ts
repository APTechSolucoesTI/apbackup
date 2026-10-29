import { repositoryHandle } from './repository-runtime.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  canonicalJson,
  dockerEvidenceSchema,
  dockerRestoredSchema,
  dockerSelectionSchema,
  type AgentCommand,
  type AgentResult,
  type DockerRuntime,
  type ExecutionContext,
} from '@apbackup/contracts';
import { dockerClient, type DockerPolicy } from './docker-client.js';
import {
  encryptConfig,
  decryptConfig,
  DockerUnknownEffect,
  DockerStageError,
} from './docker-runtime.js';
import { inspectDataTar } from './docker-archive.js';
import { safePath, trustedDirectory } from './runtime/safe-path.js';
import { spawnTool } from './runtime/spawn-tool.js';
import { assertCommandActive, CommandDeadlineError } from './runtime/command-deadline.js';

const mount = z
  .object({
    Type: z.enum(['volume', 'bind']),
    Source: z.string().min(1),
    Target: z.string().startsWith('/'),
    ReadOnly: z.boolean().optional(),
  })
  .passthrough();
const service = z.object({
  ID: z.string(),
  Version: z.object({ Index: z.number().int() }),
  Spec: z
    .object({
      Name: z.string(),
      Mode: z.object({ Replicated: z.object({ Replicas: z.number().int().min(0).max(10) }) }),
      TaskTemplate: z
        .object({
          ContainerSpec: z
            .object({
              Image: z.string(),
              Env: z.array(z.string()).optional(),
              Command: z.array(z.string()).optional(),
              Args: z.array(z.string()).optional(),
              Mounts: z.array(mount).optional(),
              Secrets: z.array(z.unknown()).optional(),
              Configs: z.array(z.unknown()).optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
});
const archive = z.strictObject({
  selection: dockerSelectionSchema,
  services: z.array(service).min(1).max(3),
  images: z
    .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
    .min(1)
    .max(3),
  data: z
    .array(
      z.object({
        name: z.string().regex(/^data-\d+\.tar$/),
        source: z.string(),
        type: z.enum(['volume', 'bind']),
        fingerprint: z.string(),
      }),
    )
    .max(100),
  files: z
    .array(
      z.object({
        name: z.string().regex(/^(config.enc|image-\d+\.tar|data-\d+\.tar)$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(104),
});
const isDatabase = (image: string) =>
  /(?:^|[/_-])(postgres|mysql|mariadb|mongo|redis)(?:[:/@_-]|$)/i.test(image);
function hash(path: string, signal: AbortSignal) {
  return (async () => {
    const h = createHash('sha256');
    for await (const b of createReadStream(path, { signal })) h.update(b);
    return h.digest('hex');
  })();
}

/** Explicit 1–3 service group, single agent node, no DB/queue reconstruction. */
export async function runSwarmCommand(
  command: AgentCommand,
  context: ExecutionContext,
  policy: DockerPolicy,
  artifactRoot: string,
  scoped: DockerRuntime,
): Promise<Partial<AgentResult>> {
  const op = command.operation;
  if (op.kind !== 'docker_backup' && op.kind !== 'docker_restore')
    throw new Error('Unsupported command');
  const active = () => assertCommandActive(command, context),
    authorize = async () => {
      active();
      if (!context.authorizeEffect || !(await context.authorizeEffect(command)))
        throw new Error('Effect ownership lost');
      active();
    };
  active();
  const selected = scoped.selection.services!;
  const docker = dockerClient(policy, context.signal),
    node = await docker.nodeId();
  await trustedDirectory(policy.repositoryRoot, { private: true });
  await trustedDirectory(artifactRoot, { private: true });
  const repository = await trustedDirectory(join(policy.repositoryRoot, scoped.repositoryPath), {
      create: true,
      private: true,
    }),
    stage = await trustedDirectory(join(artifactRoot, command.executionId), {
      create: true,
      private: true,
    });
  const remote = scoped.repository
    ? await repositoryHandle(scoped.repository, policy, stage, command, context)
    : undefined;
  let mutated = false,
    phase: NonNullable<AgentResult['failureStage']> = 'connection';
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
    if (r.exitCode !== 0 || r.timedOut || r.outputLimited) throw new Error('Restic failed');
    return r.stdout;
  };
  async function currentGroup(capture: boolean) {
    // Every owner's mount inventory must be understood. Unknown service types fail closed.
    const raws = await docker.services();
    const services = selected.map((s) => {
      const found = raws.find((r) => r.ID === s.id);
      return service.parse(found);
    });
    const ids = new Set(services.map((s) => s.ID));
    const mounts = services.flatMap((s) => s.Spec.TaskTemplate.ContainerSpec.Mounts ?? []);
    for (const s of services) {
      const c = s.Spec.TaskTemplate.ContainerSpec;
      if (
        capture &&
        (isDatabase(c.Image) ||
          /\b(migrate|migration)\b|prisma[^\n]*deploy/i.test(
            [...(c.Command ?? []), ...(c.Args ?? [])].join(' '),
          ))
      )
        throw new Error('Database/migrating startup requires a reviewed nonmigrating adapter');
      if (capture && (c.Secrets?.length || c.Configs?.length))
        throw new Error('External Swarm secrets/configs require native reconstruction');
      const allTasks = await docker.tasks(s.ID);
      if (
        allTasks.some(
          (t) =>
            (t.DesiredState === 'running' || t.Status.State === 'running') &&
            t.NodeID &&
            t.NodeID !== node,
        ) ||
        allTasks.some((t) => t.Status.State === 'running' && !t.NodeID)
      )
        throw new Error('Current task node is outside or unknown to this agent');
      // Damaged targets need identity/ownership checks, not capture eligibility.
      // Pending/failed tasks have no running data to capture; returned tasks are pinned below.
      if (!capture) continue;
      const tasks = allTasks.filter((t) => t.DesiredState === 'running');
      if (
        s.Spec.Mode.Replicated.Replicas < 1 ||
        tasks.length !== s.Spec.Mode.Replicated.Replicas ||
        tasks.some((t) => t.Status.State !== 'running' || !t.Status.ContainerStatus?.ContainerID)
      )
        throw new Error('Every replica must be running locally');
      for (const t of tasks) {
        const inspected = await docker.inspect(t.Status.ContainerStatus!.ContainerID);
        if (!inspected.State.Running) throw new Error('Task is not running');
        const changes = await docker.changes(inspected.Id);
        if (
          changes.some(
            (change) =>
              !inspected.Mounts.some(
                (m) =>
                  change.Path.startsWith(m.Destination.replace(/\/$/, '') + '/') ||
                  (change.Kind === 1 &&
                    (change.Path === m.Destination ||
                      m.Destination.startsWith(change.Path.replace(/\/$/, '') + '/'))),
              ),
          )
        )
          throw new Error('Writable-layer changes outside captured mounts require manual recovery');
      }
    }
    for (const m of mounts) {
      if (
        m.Source.includes('{{') ||
        (m.Type === 'bind' && !Object.values(policy.directories).includes(m.Source))
      )
        throw new Error('Mount is not approved');
      for (const raw of raws.filter((r) => !ids.has(r.ID))) {
        const other = z
          .object({
            TaskTemplate: z.object({
              ContainerSpec: z.object({
                Mounts: z
                  .array(
                    z
                      .object({
                        Type: z.enum(['volume', 'bind', 'tmpfs']),
                        Source: z.string().optional(),
                      })
                      .refine(
                        (n) => n.Type === 'tmpfs' || (!!n.Source && !n.Source.includes('{{')),
                      ),
                  )
                  .optional(),
              }),
            }),
          })
          .parse(raw.Spec);
        if (
          other.TaskTemplate.ContainerSpec.Mounts?.some(
            (n) =>
              n.Type === m.Type &&
              (n.Source === m.Source ||
                (m.Type === 'bind' &&
                  n.Source &&
                  (n.Source.startsWith(m.Source + '/') || m.Source.startsWith(n.Source + '/')))),
          )
        )
          throw new Error('Mount belongs to another service');
      }
    }
    // Standalone containers cannot share the selected data; group tasks are allowed.
    const catalog = await docker.discover();
    for (const c of catalog.containers) {
      const inspected = await docker.inspect(c.id),
        owner = inspected.Config.Labels?.['com.docker.swarm.service.id'];
      if (!owner || !ids.has(owner))
        for (const m of inspected.Mounts)
          if (
            mounts.some(
              (n) =>
                n.Type === m.Type &&
                (n.Type === 'volume'
                  ? m.Name === n.Source
                  : m.Source === n.Source ||
                    m.Source.startsWith(n.Source + '/') ||
                    n.Source.startsWith(m.Source + '/')),
            )
          )
            throw new Error('Data is also owned outside selected group');
    }
    return services;
  }
  try {
    if (op.kind === 'docker_backup') {
      phase = 'capture';
      const services = await currentGroup(true),
        capturedAt = new Date().toISOString(),
        images: string[] = [],
        files: z.infer<typeof archive>['files'] = [],
        data: z.infer<typeof archive>['data'] = [];
      const add = async (name: string) =>
        files.push({
          name,
          sha256: await hash(join(stage, name), context.signal),
          size: (await stat(join(stage, name))).size,
        });
      await writeFile(
        join(stage, 'config.enc'),
        encryptConfig(canonicalJson(services), scoped.repositoryPassword),
        { flag: 'wx', mode: 0o600 },
      );
      await add('config.enc');
      for (const [i, s] of services.entries()) {
        const tasks = (await docker.tasks(s.ID)).filter((t) => t.DesiredState === 'running'),
          inspected = await docker.inspect(tasks[0]!.Status.ContainerStatus!.ContainerID);
        images.push(inspected.Image);
        await docker.saveImage(inspected.Image, join(stage, `image-${i}.tar`));
        await add(`image-${i}.tar`);
      }
      const mounts = new Map(
        services
          .flatMap((s) => s.Spec.TaskTemplate.ContainerSpec.Mounts ?? [])
          .map((m) => [`${m.Type}:${m.Source}`, m]),
      );
      for (const m of mounts.values()) {
        const name = `data-${data.length}.tar`;
        await authorize();
        await docker.capture(
          { Type: m.Type, Source: m.Source, Target: '/data', ReadOnly: true },
          command.commandId,
          join(stage, name),
        );
        const proof = await inspectDataTar(join(stage, name), context.signal);
        data.push({ name, source: m.Source, type: m.Type, fingerprint: proof.fingerprint });
        await add(name);
      }
      const fresh = await currentGroup(true);
      if (canonicalJson(fresh) !== canonicalJson(services))
        throw new Error('Services changed during capture');
      // Config is encrypted separately. The public index deliberately contains no environment values.
      const index = { selection: scoped.selection, images, data, files };
      await writeFile(join(stage, 'set.json'), canonicalJson(index), { flag: 'wx', mode: 0o600 });
      phase = 'repository';
      try {
        await lstat(join(repository, 'config'));
      } catch (e) {
        if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e;
        await restic(['init', '--repository-version', '2']);
      }
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
        ]),
        summary = output
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((v) => v.message_type === 'summary'),
        snapshotId = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(summary?.snapshot_id);
      phase = 'verification';
      await restic(['check', '--read-data']);
      const verify = await trustedDirectory(join(stage, 'verified'), {
        create: true,
        private: true,
      });
      await restic(['restore', snapshotId, '--target', verify]);
      const sha256 = await hash(join(stage, 'set.json'), context.signal);
      if ((await hash(await safePath(verify, 'set.json'), context.signal)) !== sha256)
        throw new Error('Index mismatch');
      for (const f of files)
        if ((await hash(await safePath(verify, f.name), context.signal)) !== f.sha256)
          throw new Error('Artifact mismatch');
      const sizeBytes = String((await stat(join(stage, 'set.json'))).size);
      return {
        docker: dockerEvidenceSchema.parse({
          repositoryId: op.repositoryId,
          nativeRepositoryId: config.id,
          snapshotId,
          capturedAt,
          sha256,
          sizeBytes,
          totalSizeBytes: String(Number(sizeBytes) + files.reduce((a, b) => a + b.size, 0)),
          selection: scoped.selection,
          components: files.map((f) => f.name),
          artifacts: files.map((f) => ({
            name: f.name,
            sha256: f.sha256,
            sizeBytes: String(f.size),
          })),
          imageId: null,
          consistency: 'crash_consistent',
        }),
        artifact: { path: `${command.executionId}/set.json`, sha256, sizeBytes },
      };
    }
    if (
      !op.replaceContainer ||
      op.targetName !== scoped.selection.identity ||
      !op.redeployGuardConfirmed ||
      !op.targetServices
    )
      throw new Error('Explicit group confirmation and external redeploy guard required');
    const current = await currentGroup(false);
    if (
      current.some(
        (s) => !op.targetServices!.some((t) => t.id === s.ID && t.version === s.Version.Index),
      ) ||
      op.targetServices.length !== current.length
    )
      throw new Error('Current target version changed');
    phase = 'repository';
    const config = z.object({ id: z.string() }).parse(JSON.parse(await restic(['cat', 'config'])));
    if (config.id !== op.nativeRepositoryId) throw new Error('Repository identity changed');
    const restored = await trustedDirectory(join(stage, 'restored'), {
      create: true,
      private: true,
    });
    await restic(['restore', op.snapshotId, '--target', restored]);
    const indexPath = await safePath(restored, 'set.json');
    if ((await hash(indexPath, context.signal)) !== op.sha256)
      throw new Error('Index hash mismatch');
    const index = archive
      .omit({ services: true })
      .parse(JSON.parse(await readFile(indexPath, 'utf8')));
    if (canonicalJson(index.selection) !== canonicalJson(scoped.selection))
      throw new Error('Group binding mismatch');
    for (const f of index.files)
      if ((await hash(await safePath(restored, f.name), context.signal)) !== f.sha256)
        throw new Error('Artifact hash mismatch');
    const historical = z
      .array(service)
      .min(1)
      .max(3)
      .parse(
        JSON.parse(
          decryptConfig(
            await readFile(await safePath(restored, 'config.enc')),
            scoped.configurationPassword ?? scoped.repositoryPassword,
          ),
        ),
      );
    if (
      historical.length !== selected.length ||
      historical.some((s, i) => s.ID !== selected[i]!.id)
    )
      throw new Error('Historical target mismatch');
    for (const d of index.data)
      if (
        (await inspectDataTar(await safePath(restored, d.name), context.signal)).fingerprint !==
        d.fingerprint
      )
        throw new Error('Unsafe archive');
    const targets = new Map<string, string>();
    phase = 'target';
    for (const [i, d] of index.data.entries()) {
      const name = `apbackup-${command.executionId.slice(0, 18)}-${i}`;
      await authorize();
      await docker.volumeAbsent(name);
      mutated = true;
      await docker.createVolume(name, command.commandId);
      const m = { Type: 'volume' as const, Source: name, Target: '/data', ReadOnly: false },
        helper = await docker.helper(m, command.commandId);
      try {
        await authorize();
        await docker.extract(helper, '/data', createReadStream(await safePath(restored, d.name)));
      } finally {
        if (!context.signal.aborted) await docker.removeHelper(helper, command.commandId);
      }
      const verify = join(stage, `check-${i}.tar`);
      await docker.capture({ ...m, ReadOnly: true }, command.commandId, verify);
      if ((await inspectDataTar(verify, context.signal)).fingerprint !== d.fingerprint)
        throw new Error('Restored files differ');
      targets.set(`${d.type}:${d.source}`, name);
    }
    for (const [i, image] of index.images.entries()) {
      await authorize();
      mutated = true;
      await docker.loadImage(createReadStream(await safePath(restored, `image-${i}.tar`)));
      if (!(await docker.imageExists(image))) throw new Error('Historical image unavailable');
    }
    const replacements = historical.map((s, i) => {
      const spec = structuredClone(s.Spec),
        now = current[i]!,
        keys = selected[i]!.preserveEnvironmentKeys,
        env = now.Spec.TaskTemplate.ContainerSpec.Env ?? [];
      for (const key of keys)
        if (!env.some((e) => e.startsWith(key + '=')))
          throw new Error('Current compatibility key missing');
      spec.TaskTemplate.ContainerSpec.Env = [
        ...(spec.TaskTemplate.ContainerSpec.Env ?? []).filter(
          (e) => !keys.includes(e.split('=')[0]!),
        ),
        ...env.filter((e) => keys.includes(e.split('=')[0]!)),
      ];
      spec.TaskTemplate.ContainerSpec.Image = index.images[i]!;
      spec.TaskTemplate.ContainerSpec.Mounts = (spec.TaskTemplate.ContainerSpec.Mounts ?? []).map(
        (m) => {
          const source = targets.get(`${m.Type}:${m.Source}`);
          if (!source) throw new Error('Captured mount missing');
          return {
            Type: 'volume' as const,
            Source: source,
            Target: m.Target,
            ReadOnly: m.ReadOnly ?? false,
          };
        },
      );
      const placement = z
        .object({ Constraints: z.array(z.string()).optional() })
        .passthrough()
        .parse(spec.TaskTemplate.Placement ?? {});
      spec.TaskTemplate.Placement = {
        ...placement,
        Constraints: [...(placement.Constraints ?? []), `node.id==${node}`],
      };
      return spec;
    });
    phase = 'restore';
    for (const [i, s] of current.entries()) {
      await authorize();
      const fresh = await docker.service(s.ID);
      // Swarm also increments Version for orchestration status. Rebase only when
      // the complete desired Spec remains identical; the update still uses CAS.
      if (canonicalJson(fresh.Spec) !== canonicalJson(s.Spec))
        throw new Error('Target desired configuration changed before update');
      mutated = true;
      await docker.updateService(s.ID, fresh.Version.Index, replacements[i]);
    }
    for (let attempt = 0; attempt < 90; attempt++) {
      active();
      let ready = true;
      for (const [i, s] of current.entries()) {
        const tasks = (await docker.tasks(s.ID)).filter((t) => t.DesiredState === 'running');
        if (tasks.length !== replacements[i]!.Mode.Replicated.Replicas) {
          ready = false;
          continue;
        }
        for (const t of tasks) {
          if (t.Status.State !== 'running' || !t.Status.ContainerStatus) {
            ready = false;
            continue;
          }
          let c: Awaited<ReturnType<typeof docker.inspect>>;
          try {
            c = await docker.inspect(t.Status.ContainerStatus.ContainerID);
          } catch (e) {
            if (context.signal.aborted) throw e;
            ready = false;
            continue;
          }
          const expected = replacements[i]!.TaskTemplate.ContainerSpec;
          if (
            c.Image !== index.images[i] ||
            !c.State.Running ||
            (expected.Env ?? []).some((e) => !c.Config.Env?.includes(e)) ||
            (expected.Mounts ?? []).some(
              (m) =>
                !c.Mounts.some(
                  (actual) =>
                    actual.Type === 'volume' &&
                    actual.Name === m.Source &&
                    actual.Destination === m.Target &&
                    actual.RW === !(m.ReadOnly ?? false),
                ),
            ) ||
            (c.State.Health && c.State.Health.Status !== 'healthy')
          )
            ready = false;
        }
      }
      if (ready)
        return {
          dockerRestored: dockerRestoredSchema.parse({
            targetName: op.targetName,
            kind: 'swarm',
            services: current.map((s, i) => ({
              id: s.ID,
              role: selected[i]!.role,
              image: index.images[i],
            })),
            targets: [...targets.values(), ...(targets.size ? [] : [op.targetName])],
            verifiedAt: new Date().toISOString(),
            running: true,
            health: 'running',
          }),
        };
      await delay(1000, undefined, { signal: context.signal });
    }
    throw new Error('Service health deadline');
  } catch (e) {
    if (e instanceof CommandDeadlineError || context.signal.aborted)
      throw new CommandDeadlineError();
    if (mutated)
      throw new DockerUnknownEffect('Inspect partial service/volume effects before retry', {
        cause: e,
      });
    const failure = new DockerStageError(phase);
    failure.cause = e;
    throw failure;
  } finally {
    await remote?.close();
  }
}
