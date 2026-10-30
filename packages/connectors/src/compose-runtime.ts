import { createHash, randomUUID } from 'node:crypto';
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
import {
  dockerClient,
  dockerMountsOverlap,
  containerInspectSchema,
  type ContainerInspect,
  type DockerPolicy,
} from './docker-client.js';
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
import { repositoryHandle } from './repository-runtime.js';

const endpoint = z.object({
  NetworkID: z.string(),
  Aliases: z.array(z.string()).nullable(),
  IPAMConfig: z.record(z.string(), z.unknown()).nullable(),
  Links: z.array(z.string()).nullable().optional(),
  DriverOpts: z.record(z.string(), z.string()).nullable().optional(),
  IPAddress: z.string().optional(),
  GlobalIPv6Address: z.string().optional(),
});
const network = z.object({
  Id: z.string(),
  Name: z.string(),
  Driver: z.enum(['bridge', 'overlay']),
  Scope: z.enum(['local', 'swarm']),
  Internal: z.boolean(),
  Attachable: z.boolean(),
  Ingress: z.literal(false),
  EnableIPv6: z.boolean(),
  Options: z.record(z.string(), z.string()).nullable(),
  Labels: z.record(z.string(), z.string()).nullable(),
  IPAM: z.object({
    Driver: z.string(),
    Options: z.record(z.string(), z.string()).nullable(),
    Config: z.array(z.record(z.string(), z.string())).nullable(),
  }),
});
const configuration = z.strictObject({
  containers: z.array(containerInspectSchema).min(1).max(3),
  networks: z.array(network).min(1).max(10),
});
const archive = z.strictObject({
  selection: dockerSelectionSchema,
  images: z
    .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
    .min(1)
    .max(3),
  data: z
    .array(
      z.strictObject({
        name: z.string().regex(/^data-\d+\.tar$/),
        source: z.string(),
        type: z.enum(['volume', 'bind']),
        rootKind: z.enum(['file', 'directory']),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100),
  files: z
    .array(
      z.strictObject({
        name: z.string().regex(/^(config.enc|image-\d+\.tar|data-\d+\.tar)$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .min(2)
    .max(104),
});
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b.replace(/\/$/, '') + '/') || b.startsWith(a.replace(/\/$/, '') + '/');
const database = (c: ContainerInspect) =>
  /(?:^|[/_-])(postgres|mysql|mariadb|mongo|redis)(?:[:/@_-]|$)/i.test(c.Config.Image) ||
  c.Mounts.some((m) => /(?:^|\/)(?:postgresql|mysql|mongodb|redis)(?:\/|$)/i.test(m.Destination));
const migration = (argv: readonly string[]) =>
  /\b(migrate|migration|migrations)\b|prisma[^\n]*deploy/i.test(argv.join(' '));
async function hash(path: string, signal: AbortSignal) {
  const h = createHash('sha256');
  for await (const b of createReadStream(path, { signal })) h.update(b);
  return h.digest('hex');
}
const mountKey = (m: ContainerInspect['Mounts'][number]) =>
  `${m.Type}:${m.Type === 'volume' ? m.Name : m.Source}`;
const mountSubpath = (c: ContainerInspect, m: ContainerInspect['Mounts'][number]) =>
  c.HostConfig.Mounts?.find((declaration) => declaration.Target === m.Destination)?.VolumeOptions
    ?.Subpath ?? '';
export const composeContainerIdentity = (c: ContainerInspect) =>
  canonicalJson({
    Id: c.Id,
    Name: c.Name,
    Image: c.Image,
    Config: c.Config,
    HostConfig: c.HostConfig,
    Mounts: [...c.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination, 'en')),
    Networks: Object.fromEntries(
      Object.entries(c.NetworkSettings.Networks).map(([name, v]) => {
        const e = endpoint.parse(v);
        return [
          name,
          {
            NetworkID: e.NetworkID,
            Aliases: e.Aliases,
            IPAMConfig: e.IPAMConfig,
            Links: e.Links,
            DriverOpts: e.DriverOpts,
          },
        ];
      }),
    ),
  });
const stable = composeContainerIdentity;

/** Deliberately finite Compose adapter: three reviewed application roles, no DB runtime. */
export async function runComposeCommand(
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
  const selected = scoped.selection.containers!;
  const docker = dockerClient(policy, context.signal);
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
  async function group(capture: boolean) {
    const all = await docker.listContainers(),
      desired = capture ? selected : op.kind === 'docker_restore' ? op.targetContainers : undefined;
    if (
      !desired ||
      desired.length !== selected.length ||
      new Set(desired.map((s) => s.name)).size !== desired.length
    )
      throw new Error('Exact current group required');
    const containers = selected.map((s) => {
      const target = desired.find((t) => t.name === s.name);
      const found = all.find((c) => c.Name === '/' + s.name);
      if (!found || !target || (!capture && found.Id !== target.id))
        throw new Error('Container identity changed');
      return found;
    });
    const ids = new Set(containers.map((c) => c.Id)),
      services = new Set<string>(),
      scopes = new Map<string, string>();
    const swarmMounts = await docker.swarmMounts();
    for (const [i, c] of containers.entries()) {
      const service = c.Config.Labels?.['com.docker.compose.service'];
      if (
        c.Config.Labels?.['com.docker.compose.project'] !== scoped.selection.identity ||
        service !== selected[i]!.service ||
        services.has(service) ||
        c.Config.Labels?.['com.docker.swarm.service.id']
      )
        throw new Error('Compose project/service identity is ambiguous');
      services.add(service);
      if (database(c) || docker.unsupportedRuntime(c, true))
        throw new Error('Database or unsupported runtime');
      const startup = selected[i]!.restoreStartup;
      if (
        capture &&
        migration([
          ...(startup?.entrypoint ?? c.Config.Entrypoint ?? []),
          ...(startup?.command ?? c.Config.Cmd ?? []),
        ])
      )
        throw new Error('Migrating startup needs reviewed start-only override');
      if (capture && !c.State.Running)
        throw new Error('Every captured application must be running');
      if (capture) {
        const ephemeral = selected[i]!.ephemeralPaths ?? [],
          injected = c.HostConfig.Init ? ['/sbin/docker-init', '/usr/sbin/docker-init'] : [];
        const outside = (await docker.changes(c.Id)).filter(
          (change) =>
            !ephemeral.some((path) => change.Path === path || change.Path.startsWith(path + '/')) &&
            !(change.Kind === 1 && injected.includes(change.Path)) &&
            !c.Mounts.some(
              (m) =>
                change.Path.startsWith(m.Destination.replace(/\/$/, '') + '/') ||
                (change.Kind === 1 && change.Path === m.Destination),
            ),
        );
        // Creating a file mount changes its existing parent directory mtime in
        // overlayfs. Accept only ancestor directories whose mode and owner still
        // match the exact captured image; independent changed paths stay blocked.
        if (outside.length) {
          if (
            outside.some(
              (change) =>
                ![0, 1].includes(change.Kind) ||
                ![...c.Mounts.map((m) => m.Destination), ...ephemeral, ...injected].some((path) =>
                  path.startsWith(change.Path.replace(/\/$/, '') + '/'),
                ),
            )
          )
            throw new Error('Writable-layer changes outside mounts');
          await authorize();
          const probe = await docker.createContainer('apbackup-probe-' + randomUUID(), {
            Image: c.Image,
            Labels: { 'apbackup.helper': command.commandId },
            HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true },
          });
          try {
            for (const change of outside) {
              const actual = await docker.directoryMetadata(c.Id, change.Path);
              if (change.Kind === 1) continue;
              if (
                canonicalJson(actual) !==
                canonicalJson(await docker.directoryMetadata(probe, change.Path))
              )
                throw new Error('Changed directory ownership or mode outside mounts');
            }
          } finally {
            if (!context.signal.aborted) await docker.removeHelper(probe, command.commandId);
          }
        }
      }
      for (const m of c.Mounts) {
        if (!docker.mountSource(m)) throw new Error('Unapproved mount');
        if (m.Type === 'volume') await docker.assertLocalVolume(m.Name!);
        const subpath = mountSubpath(c, m),
          scope = scopes.get(mountKey(m));
        if (scope !== undefined && scope !== subpath)
          throw new Error('Mixed root/subpath ownership is unsupported');
        scopes.set(mountKey(m), subpath);
        if (
          subpath &&
          !(
            m.Type === 'volume' &&
            subpath === 'data' &&
            m.Name &&
            c.Config.Labels?.['apbackup.restore'] &&
            (await docker.restoredVolume(m.Name, c.Config.Labels['apbackup.restore']))
          )
        )
          throw new Error('Only adapter-owned restored file subpaths are supported');
        for (const other of all.filter((o) => !ids.has(o.Id)))
          if (other.Mounts.some((n) => dockerMountsOverlap(m, n) && (m.RW || n.RW)))
            throw new Error('Writable data is shared outside selected group');
        if (
          swarmMounts.some(
            (n) =>
              n.Type === m.Type &&
              (m.Type === 'volume'
                ? n.Source === m.Name
                : !!n.Source && overlaps(n.Source, m.Source)) &&
              (m.RW || !n.ReadOnly),
          )
        )
          throw new Error('Mount shared by external Swarm service');
      }
      for (const destination of selected[i]!.emptyReadOnlyMounts ?? []) {
        const m = c.Mounts.find((m) => m.Destination === destination),
          priorRestore = c.Config.Labels?.['apbackup.restore'];
        if (
          !m ||
          m.RW ||
          !(
            m.Type === 'bind' ||
            (m.Type === 'volume' &&
              m.Name &&
              priorRestore &&
              (await docker.restoredVolume(m.Name, priorRestore)))
          )
        )
          throw new Error(
            'Only approved RO binds or previously restored empty volumes may be omitted',
          );
      }
      for (const [name, raw] of Object.entries(c.NetworkSettings.Networks)) {
        if (['host', 'none', 'bridge'].includes(name))
          throw new Error('Explicit custom bridge network required');
        const e = endpoint.parse(raw);
        if (
          !e.NetworkID ||
          (Object.keys(e.IPAMConfig ?? {}).length &&
            !(
              policy.dynamicOverlayNetworks?.[name] === e.NetworkID &&
              Object.entries(e.IPAMConfig ?? {}).every(([key, value]) =>
                key === 'IPv4Address'
                  ? value === e.IPAddress
                  : key === 'IPv6Address' && value === e.GlobalIPv6Address,
              )
            )) ||
          e.Links?.length ||
          Object.keys(e.DriverOpts ?? {}).length
        )
          throw new Error('Static addresses or endpoint options unsupported');
      }
    }
    const names = [...new Set(containers.flatMap((c) => Object.keys(c.NetworkSettings.Networks)))];
    if (!names.length || names.length > 10) throw new Error('Network group limit');
    const networks = await Promise.all(
      names.map(async (n) => network.parse(await docker.network(n))),
    );
    if (
      networks.some((n) =>
        n.Driver === 'bridge' ? n.Scope !== 'local' : n.Scope !== 'swarm' || !n.Attachable,
      )
    )
      throw new Error('Network scope/attachment unsupported');
    for (const c of containers)
      for (const [name, raw] of Object.entries(c.NetworkSettings.Networks))
        if (
          Object.keys(endpoint.parse(raw).IPAMConfig ?? {}).length &&
          networks.find((n) => n.Name === name)?.Driver !== 'overlay'
        )
          throw new Error('Static bridge endpoint addresses unsupported');
    for (const c of containers)
      for (const [name, raw] of Object.entries(c.NetworkSettings.Networks))
        if (endpoint.parse(raw).NetworkID !== networks.find((n) => n.Name === name)?.Id)
          throw new Error('Network identity changed');
    return configuration.parse({ containers, networks });
  }
  try {
    if (op.kind === 'docker_backup') {
      phase = 'capture';
      const captured = await group(true),
        capturedAt = new Date().toISOString(),
        files: z.infer<typeof archive>['files'] = [],
        data: z.infer<typeof archive>['data'] = [];
      const add = async (name: string) => {
        files.push({
          name,
          sha256: await hash(join(stage, name), context.signal),
          size: (await stat(join(stage, name))).size,
        });
      };
      await writeFile(
        join(stage, 'config.enc'),
        encryptConfig(canonicalJson(captured), scoped.repositoryPassword),
        { flag: 'wx', mode: 0o600 },
      );
      await add('config.enc');
      const images = captured.containers.map((c) => c.Image);
      for (const [i, image] of images.entries()) {
        await docker.saveImage(image, join(stage, `image-${i}.tar`));
        await add(`image-${i}.tar`);
      }
      const mounts = new Map(
        captured.containers
          .flatMap((c, i) =>
            c.Mounts.filter((m) => !selected[i]!.emptyReadOnlyMounts?.includes(m.Destination)).map(
              (m) => ({ mount: m, subpath: mountSubpath(c, m) }),
            ),
          )
          .map((item) => [mountKey(item.mount), item]),
      );
      for (const { mount: m, subpath } of mounts.values()) {
        const name = `data-${data.length}.tar`,
          source = m.Type === 'volume' ? m.Name! : m.Source;
        await authorize();
        await docker.capture(
          {
            Type: m.Type as 'volume' | 'bind',
            Source: source,
            Target: '/data',
            ReadOnly: true,
            ...(subpath ? { VolumeOptions: { Subpath: subpath } } : {}),
          },
          command.commandId,
          join(stage, name),
        );
        const proof = await inspectDataTar(join(stage, name), context.signal);
        if (proof.rootKind === 'other') throw new Error('Unrecognized mount root');
        data.push({
          name,
          source,
          type: m.Type as 'volume' | 'bind',
          rootKind: proof.rootKind,
          fingerprint: proof.fingerprint,
        });
        await add(name);
      }
      const fresh = await group(true);
      if (
        captured.containers.some((c, i) => stable(c) !== stable(fresh.containers[i]!)) ||
        canonicalJson(captured.networks) !== canonicalJson(fresh.networks)
      )
        throw new Error(
          'Compose runtime changed during capture: ' +
            JSON.stringify({
              containers: captured.containers.map((c, i) =>
                Object.keys(JSON.parse(stable(c)) as object).filter(
                  (key) =>
                    canonicalJson((JSON.parse(stable(c)) as Record<string, unknown>)[key]) !==
                    canonicalJson(
                      (JSON.parse(stable(fresh.containers[i]!)) as Record<string, unknown>)[key],
                    ),
                ),
              ),
              networks: canonicalJson(captured.networks) !== canonicalJson(fresh.networks),
            }),
        );
      const index = archive.parse({ selection: scoped.selection, images, data, files });
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
          totalSizeBytes: String(Number(sizeBytes) + files.reduce((n, f) => n + f.size, 0)),
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
      !op.targetContainers
    )
      throw new Error('Explicit group and paused external deployment guard required');
    const current = await group(false);
    phase = 'repository';
    const config = z.object({ id: z.string() }).parse(JSON.parse(await restic(['cat', 'config'])));
    if (config.id !== op.nativeRepositoryId) throw new Error('Repository changed');
    const restored = await trustedDirectory(join(stage, 'restored'), {
      create: true,
      private: true,
    });
    await restic(['restore', op.snapshotId, '--target', restored]);
    const indexPath = await safePath(restored, 'set.json');
    if ((await hash(indexPath, context.signal)) !== op.sha256) throw new Error('Index mismatch');
    const index = archive.parse(JSON.parse(await readFile(indexPath, 'utf8')));
    if (canonicalJson(index.selection) !== canonicalJson(scoped.selection))
      throw new Error('Historical binding changed');
    for (const f of index.files)
      if ((await hash(await safePath(restored, f.name), context.signal)) !== f.sha256)
        throw new Error('Artifact mismatch');
    const historical = configuration.parse(
      JSON.parse(
        decryptConfig(
          await readFile(await safePath(restored, 'config.enc')),
          scoped.configurationPassword ?? scoped.repositoryPassword,
        ),
      ),
    );
    if (
      historical.containers.length !== selected.length ||
      index.images.length !== selected.length ||
      historical.containers.some(
        (c, i) =>
          c.Image !== index.images[i] ||
          c.Name !== '/' + selected[i]!.name ||
          c.Name !== current.containers[i]!.Name ||
          c.Config.Labels?.['com.docker.compose.service'] !== selected[i]!.service ||
          c.Config.Labels?.['com.docker.compose.project'] !== scoped.selection.identity,
      )
    )
      throw new Error('Historical group identity mismatch');
    if (canonicalJson(historical.networks) !== canonicalJson(current.networks))
      throw new Error(
        'Historical network unavailable or replaced; reconstruct dependencies explicitly',
      );
    for (const [i, c] of historical.containers.entries()) {
      const override = selected[i]!.restoreStartup;
      if (
        database(c) ||
        docker.unsupportedRuntime(c, true) ||
        migration([
          ...(override?.entrypoint ?? c.Config.Entrypoint ?? []),
          ...(override?.command ?? c.Config.Cmd ?? []),
        ])
      )
        throw new Error('Unsafe historical startup/runtime');
    }
    const expected = new Set(
      historical.containers
        .flatMap((c, i) =>
          c.Mounts.filter((m) => !selected[i]!.emptyReadOnlyMounts?.includes(m.Destination)),
        )
        .map(mountKey),
    );
    if (
      expected.size !== index.data.length ||
      index.data.some((d) => !expected.has(`${d.type}:${d.source}`))
    )
      throw new Error('Incomplete captured mount set');
    for (const d of index.data) {
      const p = await inspectDataTar(await safePath(restored, d.name), context.signal);
      if (p.fingerprint !== d.fingerprint || p.rootKind !== d.rootKind)
        throw new Error('Unsafe archive');
    }
    // Validate compatibility before any mutation. Only listed connection values are inherited.
    const environments = historical.containers.map((c, i) => {
      const keys = selected[i]!.preserveEnvironmentKeys,
        env = current.containers[i]!.Config.Env ?? [];
      for (const key of keys)
        if (!env.some((e) => e.startsWith(key + '=')))
          throw new Error('Current connection key missing');
      return [
        ...(c.Config.Env ?? []).filter((e) => !keys.includes(e.split('=')[0]!)),
        ...env.filter((e) => keys.includes(e.split('=')[0]!)),
      ];
    });
    const fence = async () => {
      const fresh = await group(false);
      if (
        current.containers.some((c, i) => stable(c) !== stable(fresh.containers[i]!)) ||
        canonicalJson(current.networks) !== canonicalJson(fresh.networks)
      )
        throw new Error('External deployment changed target');
    };
    const targets = new Map<string, string>();
    phase = 'target';
    for (const [i, d] of index.data.entries()) {
      const name = `apbackup-${command.executionId.slice(0, 18)}-${i}`;
      await authorize();
      await fence();
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
      // File archives contain /data as a wrapper; recapture the exact file through Subpath.
      if (d.rootKind === 'file') {
        const fileCheck = join(stage, `file-check-${i}.tar`);
        await docker.capture(
          { ...m, ReadOnly: true, VolumeOptions: { Subpath: 'data' } },
          command.commandId,
          fileCheck,
        );
        if ((await inspectDataTar(fileCheck, context.signal)).fingerprint !== d.fingerprint)
          throw new Error('Restored file differs');
      } else if ((await inspectDataTar(verify, context.signal)).fingerprint !== d.fingerprint)
        throw new Error('Restored data differs');
      targets.set(`${d.type}:${d.source}`, name);
    }
    const emptyTargets = new Map<string, string>();
    for (const [i, c] of historical.containers.entries())
      for (const destination of selected[i]!.emptyReadOnlyMounts ?? []) {
        const m = c.Mounts.find((m) => m.Destination === destination);
        if (
          !m ||
          m.RW ||
          !docker.mountSource(m) ||
          !(
            m.Type === 'bind' ||
            (m.Type === 'volume' &&
              c.Config.Labels?.['apbackup.restore'] &&
              m.Name?.startsWith('apbackup-'))
          )
        )
          throw new Error('Unsafe omitted mount');
        const name = `apbackup-${command.executionId.slice(0, 18)}-empty-${emptyTargets.size}`;
        await authorize();
        await fence();
        await docker.volumeAbsent(name);
        mutated = true;
        await docker.createVolume(name, command.commandId);
        emptyTargets.set(`${i}:${destination}`, name);
      }
    for (const [i, image] of index.images.entries()) {
      await authorize();
      await fence();
      mutated = true;
      await docker.loadImage(createReadStream(await safePath(restored, `image-${i}.tar`)));
      if (!(await docker.imageExists(image))) throw new Error('Historical image absent');
    }
    const replacements: string[] = [];
    for (const [i, c] of historical.containers.entries()) {
      const override = selected[i]!.restoreStartup,
        endpoints = Object.fromEntries(
          Object.entries(c.NetworkSettings.Networks).map(([name, raw]) => {
            const e = endpoint.parse(raw);
            return [
              name,
              {
                NetworkID: e.NetworkID,
                Aliases: (e.Aliases ?? []).filter((a) => !/^[a-f0-9]{12,64}$/.test(a)),
              },
            ];
          }),
        );
      const mounts = c.Mounts.map((m) => {
        const empty = emptyTargets.get(`${i}:${m.Destination}`);
        if (empty) return { Type: 'volume', Source: empty, Target: m.Destination, ReadOnly: true };
        const source = targets.get(mountKey(m));
        const data = index.data.find((d) => `${d.type}:${d.source}` === mountKey(m));
        if (!source || !data) throw new Error('Missing mount');
        return {
          Type: 'volume',
          Source: source,
          Target: m.Destination,
          ReadOnly: !m.RW,
          ...(data.rootKind === 'file' ? { VolumeOptions: { Subpath: 'data' } } : {}),
        };
      });
      await authorize();
      await fence();
      mutated = true;
      replacements.push(
        await docker.createContainer(`apbackup-new-${command.executionId}-${i}`, {
          ...c.Config,
          ...(override
            ? {
                Cmd: override.command,
                ...(override.entrypoint ? { Entrypoint: override.entrypoint } : {}),
              }
            : {}),
          Image: index.images[i],
          Env: environments[i],
          Labels: { ...c.Config.Labels, 'apbackup.restore': command.commandId },
          HostConfig: {
            NetworkMode: c.HostConfig.NetworkMode,
            PortBindings: current.containers[i]!.HostConfig.PortBindings,
            RestartPolicy: c.HostConfig.RestartPolicy,
            Mounts: mounts,
            CapDrop: c.HostConfig.CapDrop,
            ReadonlyRootfs: c.HostConfig.ReadonlyRootfs,
            Init: c.HostConfig.Init,
            SecurityOpt: c.HostConfig.SecurityOpt,
          },
          NetworkingConfig: { EndpointsConfig: endpoints },
        }),
      );
    }
    phase = 'restore';
    await authorize();
    await fence();
    // All replacements and fresh data exist before original applications are stopped.
    for (const c of current.containers) {
      await authorize();
      await docker.stop(c.Id);
    }
    for (const [i, c] of current.containers.entries()) {
      await authorize();
      const fresh = await docker.inspect(c.Id);
      if (fresh.Name !== c.Name || fresh.Image !== c.Image)
        throw new Error('Cutover identity changed');
      await docker.rename(c.Id, `apbackup-old-${command.executionId}-${i}`);
      await authorize();
      await docker.rename(replacements[i]!, c.Name.replace(/^\//, ''));
    }
    for (const replacement of replacements) {
      await authorize();
      await docker.start(replacement);
    }
    for (let attempt = 0; attempt < 90; attempt++) {
      active();
      let ready = true,
        healthy = true;
      for (const [i, id] of replacements.entries()) {
        const c = await docker.inspect(id),
          h = historical.containers[i]!;
        if (
          c.Image !== index.images[i] ||
          !c.State.Running ||
          c.Name !== h.Name ||
          environments[i]!.some((e) => !c.Config.Env?.includes(e))
        )
          throw new Error('Restored runtime identity or startup failed');
        if (c.State.Health?.Status === 'unhealthy') throw new Error('Group healthcheck failed');
        if (c.State.Health && c.State.Health.Status !== 'healthy') ready = false;
        if (!c.State.Health) healthy = false;
      }
      if (ready)
        return {
          dockerRestored: dockerRestoredSchema.parse({
            targetName: op.targetName,
            kind: 'compose',
            services: replacements.map((id, i) => ({
              id,
              role: selected[i]!.role,
              image: index.images[i],
            })),
            targets:
              targets.size || emptyTargets.size
                ? [...targets.values(), ...emptyTargets.values()]
                : [op.targetName],
            verifiedAt: new Date().toISOString(),
            running: true,
            health: healthy ? 'healthy' : 'running',
          }),
        };
      await delay(1000, undefined, { signal: context.signal });
    }
    throw new Error('Group health deadline');
  } catch (e) {
    if (e instanceof CommandDeadlineError || context.signal.aborted)
      throw new CommandDeadlineError();
    if (mutated)
      throw new DockerUnknownEffect(
        'Inspect labeled fresh volumes/containers and preserved originals before retry',
        { cause: e },
      );
    const failure = new DockerStageError(phase);
    failure.cause = e;
    throw failure;
  } finally {
    await remote?.close();
  }
}
