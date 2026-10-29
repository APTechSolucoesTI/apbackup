import { request as httpRequest, type IncomingMessage } from 'node:http';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { dockerCatalogSchema, type DockerCatalog } from '@apbackup/contracts';
export interface DockerPolicy {
  socketPath: string;
  helperImage: string;
  repositoryRoot: string;
  mountedRoots?: readonly string[] | undefined;
  allowedHosts?: readonly string[] | undefined;
  /** Exact daemon-host directories. Never accepted from the console or a command. */
  directories: Readonly<Record<string, string>>;
}
const mountSchema = z.object({
  Type: z.string(),
  Name: z.string().optional(),
  Source: z.string(),
  Destination: z.string(),
  RW: z.boolean(),
});
export const containerInspectSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Image: z.string(),
  Config: z.object({
    Image: z.string(),
    Env: z.array(z.string()).nullable(),
    Cmd: z.array(z.string()).nullable(),
    Entrypoint: z.array(z.string()).nullable(),
    WorkingDir: z.string(),
    User: z.string(),
    Labels: z.record(z.string(), z.string()).nullable(),
    StopSignal: z.string().optional(),
    StopTimeout: z.number().optional(),
    Tty: z.boolean(),
    OpenStdin: z.boolean(),
    ExposedPorts: z.record(z.string(), z.object({})).nullable().optional(),
    Healthcheck: z
      .object({
        Test: z.array(z.string()),
        Interval: z.number().optional(),
        Timeout: z.number().optional(),
        Retries: z.number().optional(),
        StartPeriod: z.number().optional(),
      })
      .optional(),
  }),
  HostConfig: z.object({
    Privileged: z.boolean(),
    NetworkMode: z.string(),
    PidMode: z.string(),
    IpcMode: z.string(),
    CapAdd: z.array(z.string()).nullable(),
    Devices: z.array(z.unknown()).nullable(),
    CapDrop: z.array(z.string()).nullable(),
    ReadonlyRootfs: z.boolean(),
    Dns: z.array(z.string()).nullable(),
    ExtraHosts: z.array(z.string()).nullable(),
    Tmpfs: z.record(z.string(), z.string()).nullable().optional(),
    VolumesFrom: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
    Memory: z.number(),
    MemoryReservation: z.number(),
    PidsLimit: z.number().int().nullable(),
    MemorySwap: z.number(),
    NanoCpus: z.number(),
    CpuShares: z.number(),
    CpuQuota: z.number(),
    CpuPeriod: z.number(),
    CpusetCpus: z.string(),
    CpusetMems: z.string(),
    Ulimits: z.array(z.unknown()).nullable(),
    GroupAdd: z.array(z.string()).nullable(),
    Binds: z.array(z.string()).nullable(),
    PortBindings: z
      .record(
        z.string(),
        z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
      )
      .nullable(),
    RestartPolicy: z.strictObject({
      Name: z.enum(['', 'no', 'always', 'unless-stopped', 'on-failure']),
      MaximumRetryCount: z.number().int().nonnegative(),
    }),
  }),
  State: z.object({
    Running: z.boolean(),
    Status: z.string(),
    Health: z.object({ Status: z.string() }).optional(),
  }),
  Mounts: z.array(mountSchema),
  NetworkSettings: z.object({
    Networks: z.record(z.string(), z.unknown()),
    Ports: z
      .record(
        z.string(),
        z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
      )
      .nullable(),
  }),
});
export type ContainerInspect = z.infer<typeof containerInspectSchema>;
const id = (v: string) => encodeURIComponent(v);
export function dockerClient(policy: DockerPolicy, signal: AbortSignal) {
  if (
    process.platform !== 'linux' ||
    !policy.socketPath.startsWith('/') ||
    !/^sha256:[a-f0-9]{64}$/.test(policy.helperImage)
  )
    throw new Error('Trusted Linux Docker policy required');
  async function raw(
    method: string,
    path: string,
    body?: unknown,
    stream?: NodeJS.ReadableStream,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const serialized = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          socketPath: policy.socketPath,
          method,
          path: '/v1.47' + path,
          signal,
          headers: serialized
            ? { 'content-type': 'application/json', 'content-length': serialized.length }
            : stream
              ? { 'content-type': 'application/x-tar' }
              : {},
        },
        (res) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode > 299) {
            res.resume();
            reject(new Error(`Docker refused ${method} ${path.split('?')[0]} (${res.statusCode})`));
          } else resolve(res);
        },
      );
      req.on('error', reject);
      if (stream) {
        stream.on('error', (e) => req.destroy(e as Error));
        stream.pipe(req);
      } else req.end(serialized);
    });
  }
  async function json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await raw(method, path, body),
      chunks: Buffer[] = [];
    let bytes = 0;
    for await (const c of res) {
      const b = Buffer.from(c as Uint8Array);
      bytes += b.length;
      if (bytes > 8388608) {
        res.destroy();
        throw new Error('Docker metadata limit');
      }
      chunks.push(b);
    }
    const text = Buffer.concat(chunks).toString();
    return text ? (JSON.parse(text) as unknown) : null;
  }
  const inspect = async (container: string) =>
    containerInspectSchema.parse(await json('GET', `/containers/${id(container)}/json`));
  async function listContainers() {
    const list = z
      .array(z.object({ Id: z.string(), Labels: z.record(z.string(), z.string()).nullable() }))
      .max(1000)
      .parse(await json('GET', '/containers/json?all=1'));
    return Promise.all(
      list.filter((c) => !c.Labels?.['apbackup.helper']).map((c) => inspect(c.Id)),
    );
  }
  function mountSource(m: ContainerInspect['Mounts'][number]) {
    if (m.Type === 'volume' && m.Name) return { kind: 'volume' as const, identity: m.Name };
    if (m.Type === 'bind') {
      const entry = Object.entries(policy.directories).find(([, path]) => path === m.Source);
      if (entry) return { kind: 'directory' as const, identity: entry[0] };
    }
    return null;
  }
  async function discover(): Promise<DockerCatalog> {
    const containers = await listContainers();
    const volumes = z
      .object({ Volumes: z.array(z.object({ Name: z.string() })).nullable() })
      .parse(await json('GET', '/volumes'));
    const overlaps = (a: string, b: string) =>
      a === b ||
      a.startsWith(b.replace(/\/$/, '') + '/') ||
      b.startsWith(a.replace(/\/$/, '') + '/');
    const owners = (kind: string, name: string) =>
      containers
        .filter((c) =>
          c.Mounts.some((m) =>
            kind === 'volume'
              ? m.Type === 'volume' && m.Name === name
              : m.Type === 'bind' && overlaps(m.Source, policy.directories[name]!),
          ),
        )
        .map((c) => c.Id);
    const db = (c: ContainerInspect) =>
      /(?:^|[/_-])(postgres|mysql|mariadb|mongo|redis)(?:[:/@_-]|$)/i.test(c.Config.Image);
    let services: DockerCatalog['services'] = [];
    let serviceMounts: { Type: string; Source: string }[] = [];
    let serviceOwnershipKnown = false;
    // Only positive daemon information establishes absence of Swarm owners.
    // A worker/denial/transport/schema failure cannot certify an empty service set.
    try {
      const mode = z
        .object({
          Swarm: z.object({
            LocalNodeState: z.enum(['inactive', 'pending', 'active', 'error', 'locked']),
            ControlAvailable: z.boolean(),
          }),
        })
        .parse(await json('GET', '/info')).Swarm;
      if (mode.LocalNodeState === 'inactive' && !mode.ControlAvailable)
        serviceOwnershipKnown = true;
      else if (mode.LocalNodeState === 'active' && mode.ControlAvailable) {
        const found = z
          .array(
            z.object({
              ID: z.string(),
              Version: z.object({ Index: z.number().int() }).optional(),
              Spec: z.object({
                Name: z.string(),
                TaskTemplate: z.object({
                  ContainerSpec: z.object({
                    Env: z.array(z.string()).optional(),
                    Mounts: z
                      .array(
                        z
                          .object({
                            Type: z.enum(['volume', 'bind', 'tmpfs']),
                            Source: z.string().optional(),
                          })
                          .refine((m) => m.Type !== 'bind' || !!m.Source)
                          .refine((m) => !m.Source?.includes('{{')),
                      )
                      .optional(),
                  }),
                }),
              }),
            }),
          )
          .max(1000)
          .parse(await json('GET', '/services'));
        services = found.map((s) => ({
          id: s.ID,
          name: s.Spec.Name,
          ...(s.Version ? { version: s.Version.Index } : {}),
          environmentKeys: (s.Spec.TaskTemplate.ContainerSpec.Env ?? []).map(
            (e) => e.split('=')[0]!,
          ),
        }));
        serviceMounts = found.flatMap((s) =>
          (s.Spec.TaskTemplate.ContainerSpec.Mounts ?? []).flatMap((m) =>
            m.Source ? [{ Type: m.Type, Source: m.Source }] : [],
          ),
        );
        serviceOwnershipKnown = true;
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
    const changes = new Map<string, boolean>();
    for (const c of containers) {
      const diff = z
        .array(z.object({ Path: z.string(), Kind: z.number() }))
        .max(100000)
        .nullable()
        .transform((value) => value ?? [])
        .parse(await json('GET', `/containers/${id(c.Id)}/changes`));
      // Docker creates absent mountpoint directories in the writable layer.
      // Those additions contain no independent application code or data.
      changes.set(
        c.Id,
        diff.some(
          (change) =>
            !c.Mounts.some(
              (m) =>
                change.Path.startsWith(m.Destination.replace(/\/$/, '') + '/') ||
                (change.Kind === 1 &&
                  (change.Path === m.Destination ||
                    m.Destination.startsWith(change.Path.replace(/\/$/, '') + '/'))),
            ),
        ),
      );
    }
    return dockerCatalogSchema.parse({
      capturedAt: new Date().toISOString(),
      containers: containers.map((c) => {
        const mounts = c.Mounts.flatMap((m) => {
          const s = mountSource(m);
          return s
            ? [
                {
                  ...s,
                  destination: m.Destination,
                  readOnly: !m.RW,
                  owners: owners(s.kind, s.identity),
                },
              ]
            : [];
        });
        const unsafe =
          c.Config.Tty ||
          c.Config.OpenStdin ||
          c.HostConfig.Privileged ||
          c.HostConfig.CapAdd?.length ||
          c.HostConfig.Devices?.length ||
          !['default', 'bridge', 'none'].includes(c.HostConfig.NetworkMode) ||
          c.HostConfig.PidMode ||
          !['', 'private'].includes(c.HostConfig.IpcMode) ||
          c.HostConfig.Dns?.length ||
          c.HostConfig.ExtraHosts?.length ||
          Object.keys(c.HostConfig.Tmpfs ?? {}).length ||
          c.HostConfig.VolumesFrom?.length ||
          c.HostConfig.SecurityOpt?.some((v) => v !== 'no-new-privileges') ||
          c.HostConfig.Memory ||
          c.HostConfig.MemoryReservation ||
          (c.HostConfig.PidsLimit !== null && c.HostConfig.PidsLimit !== 0) ||
          c.HostConfig.MemorySwap ||
          c.HostConfig.NanoCpus ||
          c.HostConfig.CpuShares ||
          c.HostConfig.CpuQuota ||
          c.HostConfig.CpuPeriod ||
          c.HostConfig.CpusetCpus ||
          c.HostConfig.CpusetMems ||
          c.HostConfig.Ulimits?.length ||
          c.HostConfig.GroupAdd?.length ||
          Object.keys(c.NetworkSettings.Networks).length !== 1 ||
          Object.keys(c.NetworkSettings.Networks)[0] !==
            (c.HostConfig.NetworkMode === 'none' ? 'none' : 'bridge');
        const serviceShared = c.Mounts.some((m) =>
          serviceMounts.some(
            (s) =>
              s.Type === m.Type &&
              (m.Type === 'volume' ? s.Source === m.Name : overlaps(s.Source, m.Source)),
          ),
        );
        const reason = c.Config.Labels?.['com.docker.swarm.service.id']
          ? 'Serviço Swarm: retorno pelo adaptador nativo.'
          : db(c)
            ? 'Dados de banco: use o conector lógico independente.'
            : !serviceOwnershipKnown
              ? 'Propriedade dos mounts Swarm desconhecida: confira o acesso do agente ao daemon gerenciador antes de proteger ou voltar o container.'
              : unsafe
                ? 'Runtime especial exige retorno manual.'
                : changes.get(c.Id)
                  ? 'Camada gravável alterada fora dos mounts: migre os dados para um mount próprio antes de proteger.'
                  : mounts.length !== c.Mounts.length
                    ? 'Mount fora das raízes aprovadas ou tipo não suportado.'
                    : mounts.some((m) => m.owners.length !== 1) || serviceShared
                      ? 'Mount compartilhado ou ambíguo: retorno automático bloqueado.'
                      : null;
        return {
          id: c.Id,
          name: c.Name.replace(/^\//, ''),
          imageId: c.Image,
          imageReference: c.Config.Image,
          state: c.State.Status,
          mounts,
          blockedReason: reason,
        };
      }),
      volumes: (volumes.Volumes ?? []).map((v) => ({
        name: v.Name,
        owners: owners('volume', v.Name),
        databaseHint: containers.some((c) => db(c) && c.Mounts.some((m) => m.Name === v.Name)),
      })),
      directories: Object.keys(policy.directories).map((name) => ({ name })),
      services,
    });
  }
  async function helper(
    mount: { Type: 'volume' | 'bind'; Source: string; Target: string; ReadOnly: boolean },
    operation: string,
    directoryName?: string,
  ) {
    const command = directoryName
      ? [
          '/usr/local/bin/node',
          '-e',
          "const fs=require('node:fs');const p='/data/'+process.argv[1];fs.mkdirSync(p,{mode:448});",
          directoryName,
        ]
      : ['/usr/bin/tar', '--format=ustar', '--create', '--file=-', '--directory', '/data', '.'];
    const body = {
      Image: policy.helperImage,
      Cmd: command,
      Labels: { 'apbackup.helper': operation },
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Mounts: [mount],
      },
    };
    return z.object({ Id: z.string() }).parse(await json('POST', '/containers/create', body)).Id;
  }
  async function removeHelper(container: string, operation: string) {
    const current = await inspect(container);
    if (current.Config.Labels?.['apbackup.helper'] !== operation)
      throw new Error('Helper ownership changed');
    await json('DELETE', `/containers/${id(container)}?force=1&v=0`);
  }
  async function capture(
    mount: { Type: 'volume' | 'bind'; Source: string; Target: string; ReadOnly: boolean },
    operation: string,
    output: string,
  ) {
    const container = await helper(mount, operation);
    const file = await open(output, 'wx', 0o600);
    try {
      await json('POST', `/containers/${id(container)}/start`);
      const logs = await raw('GET', `/containers/${id(container)}/logs?follow=1&stdout=1&stderr=1`);
      let pending = Buffer.alloc(0),
        diagnostics = 0;
      for await (const chunk of logs) {
        pending = Buffer.concat([pending, Buffer.from(chunk as Uint8Array)]);
        while (pending.length >= 8) {
          const length = pending.readUInt32BE(4);
          if (length > 16777216) throw new Error('Invalid Docker frame');
          if (pending.length < length + 8) break;
          const content = pending.subarray(8, 8 + length);
          if (pending[0] === 1) await file.writeFile(content);
          else diagnostics += content.length;
          if (diagnostics > 8192) throw new Error('Capture diagnostics limit');
          pending = pending.subarray(8 + length);
        }
      }
      if (pending.length) throw new Error('Incomplete archive stream');
      const waited = z
        .object({ StatusCode: z.number() })
        .parse(await json('POST', `/containers/${id(container)}/wait?condition=not-running`));
      if (waited.StatusCode !== 0)
        throw new Error('Capture failed or files changed during capture');
      await file.sync();
    } finally {
      await file.close();
      if (!signal.aborted) await removeHelper(container, operation);
    }
  }
  return {
    async changes(container: string) {
      return z
        .array(z.object({ Path: z.string(), Kind: z.number().int() }))
        .max(100000)
        .nullable()
        .transform((v) => v ?? [])
        .parse(await json('GET', `/containers/${id(container)}/changes`));
    },
    async nodeId() {
      return z
        .object({
          Swarm: z.object({ NodeID: z.string().min(1), ControlAvailable: z.literal(true) }),
        })
        .parse(await json('GET', '/info')).Swarm.NodeID;
    },
    async services() {
      return z
        .array(
          z.object({
            ID: z.string(),
            Version: z.object({ Index: z.number().int() }),
            Spec: z.record(z.string(), z.unknown()),
          }),
        )
        .max(1000)
        .parse(await json('GET', '/services'));
    },
    async service(idValue: string) {
      return z
        .object({
          ID: z.string(),
          Version: z.object({ Index: z.number().int() }),
          Spec: z.record(z.string(), z.unknown()),
        })
        .parse(await json('GET', `/services/${id(idValue)}`));
    },
    async updateService(idValue: string, version: number, spec: unknown) {
      await json('POST', `/services/${id(idValue)}/update?version=${version}`, spec);
    },
    async tasks(serviceId: string) {
      return z
        .array(
          z.object({
            ID: z.string(),
            DesiredState: z.string(),
            NodeID: z.string().optional(),
            Status: z.object({
              State: z.string(),
              ContainerStatus: z.object({ ContainerID: z.string() }).optional(),
            }),
          }),
        )
        .parse(
          await json(
            'GET',
            `/tasks?filters=${encodeURIComponent(JSON.stringify({ service: [serviceId] }))}`,
          ),
        );
    },
    discover,
    inspect,
    mountSource,
    capture,
    helper,
    removeHelper,
    imageExists: async (image: string) => {
      try {
        await json('GET', `/images/${id(image)}/json`);
        return true;
      } catch (e) {
        if (signal.aborted) throw e;
        return false;
      }
    },
    async saveImage(image: string, path: string) {
      const res = await raw('GET', `/images/${id(image)}/get`),
        f = await open(path, 'wx', 0o600);
      try {
        for await (const b of res) await f.writeFile(b);
        await f.sync();
      } finally {
        await f.close();
      }
    },
    async loadImage(stream: NodeJS.ReadableStream) {
      const res = await raw('POST', '/images/load?quiet=1', undefined, stream);
      for await (const _ of res) void _;
    },
    async createVolume(name: string, operation: string) {
      const result = z
        .object({ Name: z.string(), Labels: z.record(z.string(), z.string()).nullable() })
        .parse(
          await json('POST', '/volumes/create', {
            Name: name,
            Labels: { 'apbackup.restore': operation },
          }),
        );
      if (result.Name !== name || result.Labels?.['apbackup.restore'] !== operation)
        throw new Error('Target volume collision');
    },
    async volumeAbsent(name: string) {
      const result = z
        .object({ Volumes: z.array(z.object({ Name: z.string() })).nullable() })
        .parse(await json('GET', '/volumes'));
      if (result.Volumes?.some((v) => v.Name === name)) throw new Error('Target volume exists');
    },
    async prepareDirectory(source: string, name: string, operation: string) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Error('Unsafe target name');
      const container = await helper(
        { Type: 'bind', Source: source, Target: '/data', ReadOnly: false },
        operation,
        name,
      );
      try {
        await json('POST', `/containers/${id(container)}/start`);
        const result = z
          .object({ StatusCode: z.number() })
          .parse(await json('POST', `/containers/${id(container)}/wait?condition=not-running`));
        if (result.StatusCode !== 0) throw new Error('Directory exists or is unavailable');
        return container;
      } catch (e) {
        if (!signal.aborted) await removeHelper(container, operation);
        throw e;
      }
    },
    async extract(container: string, path: string, stream: NodeJS.ReadableStream) {
      const res = await raw(
        'PUT',
        `/containers/${id(container)}/archive?path=${encodeURIComponent(path)}&copyUIDGID=1`,
        undefined,
        stream,
      );
      for await (const _ of res) void _;
    },
    async createContainer(name: string, body: unknown) {
      return z
        .object({ Id: z.string() })
        .parse(await json('POST', `/containers/create?name=${id(name)}`, body)).Id;
    },
    async stop(container: string) {
      await json('POST', `/containers/${id(container)}/stop?t=20`);
    },
    async rename(container: string, name: string) {
      await json('POST', `/containers/${id(container)}/rename?name=${id(name)}`);
    },
    async start(container: string) {
      await json('POST', `/containers/${id(container)}/start`);
    },
  };
}
