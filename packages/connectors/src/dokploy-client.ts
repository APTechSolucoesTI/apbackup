import { z } from 'zod';
import {
  dokployCatalogSchema,
  dokployNativeConfigurationSchema,
  type dokployServiceTypeSchema,
  type dokployNativeSelectionSchema,
} from '@apbackup/contracts';
export function assertApprovedDokployOrigin(endpoint: string) {
  const origin = new URL(endpoint).origin;
  if (
    !(process.env.DOKPLOY_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((v) => v.trim())
      .includes(origin)
  )
    throw new Error('Dokploy origin is not approved');
}
const procedures = [
  'settings.getDokployVersion',
  'project.all',
  'application.one',
  'compose.one',
  'postgres.one',
  'volumeBackups.list',
  'volumeBackups.one',
  'backup.one',
  'backup.listBackupFiles',
  'backup.manualBackupPostgres',
  'volumeBackups.runManually',
] as const;
export function dokployClient(endpoint: string, apiKey: string, signal?: AbortSignal) {
  assertApprovedDokployOrigin(endpoint);
  async function request(
    procedure: (typeof procedures)[number],
    input?: Record<string, unknown>,
    mutation = false,
  ): Promise<unknown> {
    if (!procedures.includes(procedure)) throw new Error('Unsupported Dokploy operation');
    const url = new URL('/api/' + procedure, endpoint);
    if (!mutation && input)
      for (const [key, value] of Object.entries(input))
        if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method: mutation ? 'POST' : 'GET',
      redirect: 'error',
      headers: { 'x-api-key': apiKey, ...(mutation ? { 'content-type': 'application/json' } : {}) },
      ...(mutation ? { body: JSON.stringify(input ?? {}) } : {}),
      signal: AbortSignal.any([
        AbortSignal.timeout(mutation ? 120000 : 30000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) throw new Error('Dokploy refused request');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty provider response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      length += r.value.length;
      if (length > 8388608) {
        await reader.cancel();
        throw new Error('Provider response limit');
      }
      chunks.push(r.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  }
  const detail = (kind: z.infer<typeof dokployServiceTypeSchema>, id: string) =>
    request(`${kind}.one`, { [`${kind}Id`]: id });
  async function discover() {
    const version = z
      .string()
      .max(50)
      .parse(await request('settings.getDokployVersion'));
    const projects = z
      .array(
        z.object({
          name: z.string(),
          environments: z.array(
            z.object({
              name: z.string(),
              applications: z
                .array(z.object({ applicationId: z.string(), name: z.string() }))
                .optional(),
              compose: z.array(z.object({ composeId: z.string(), name: z.string() })).optional(),
              postgres: z.array(z.object({ postgresId: z.string(), name: z.string() })).optional(),
            }),
          ),
        }),
      )
      .max(1000)
      .parse(await request('project.all'));
    const resources: z.infer<typeof dokployCatalogSchema>['resources'] = [];
    for (const project of projects)
      for (const environment of project.environments)
        for (const kind of ['application', 'compose', 'postgres'] as const) {
          const entries =
            kind === 'application'
              ? (environment.applications ?? []).map((a) => ({ id: a.applicationId, name: a.name }))
              : kind === 'compose'
                ? (environment.compose ?? []).map((a) => ({ id: a.composeId, name: a.name }))
                : (environment.postgres ?? []).map((a) => ({ id: a.postgresId, name: a.name }));
          for (const item of entries) {
            if (resources.length >= 1000) throw new Error('Resource limit');
            const found = z
              .object({
                appName: z.string(),
                mounts: z
                  .array(
                    z.object({
                      mountId: z.string(),
                      type: z.string(),
                      volumeName: z.string().nullish(),
                      mountPath: z.string(),
                    }),
                  )
                  .optional(),
              })
              .parse(await detail(kind, item.id));
            resources.push({
              id: item.id,
              kind,
              name: item.name,
              appName: found.appName,
              project: project.name,
              environment: environment.name,
              mounts: (found.mounts ?? []).map((m) => ({
                id: m.mountId,
                type: m.type,
                volumeName: m.volumeName ?? null,
                mountPath: m.mountPath,
              })),
            });
          }
        }
    return dokployCatalogSchema.parse({
      version,
      supported: version.replace(/^v/, '') === '0.29.13',
      resources,
      limitations: [
        'Backups nativos usam somente destinos S3 existentes. Nenhuma agenda é duplicada.',
        'Restore nativo com logs não é REST público nesta versão; use o agente ou o painel nativo.',
        'HTTP aceito e metadados S3 não comprovam recuperação. Pontos nativos ficam separados dos pontos Restic verificados.',
      ],
    });
  }
  async function configurations(
    resourceType: z.infer<typeof dokployServiceTypeSchema>,
    resourceId: string,
  ) {
    const catalog = await discover();
    const resource = catalog.resources.find((r) => r.kind === resourceType && r.id === resourceId);
    if (!resource) throw new Error('Resource unavailable');
    if (!catalog.supported) throw new Error('Provider version requires review');
    const native = z
      .array(
        z.object({
          volumeBackupId: z.string(),
          name: z.string(),
          destinationId: z.string(),
          prefix: z.string(),
          enabled: z.boolean().nullish(),
          cronExpression: z.string(),
          volumeName: z.string(),
          turnOff: z.boolean().optional(),
        }),
      )
      .max(100)
      .parse(
        await request('volumeBackups.list', { id: resourceId, volumeBackupType: resourceType }),
      );
    const items = (resourceType === 'postgres' ? [] : native).map((c) =>
      dokployNativeConfigurationSchema.parse({
        id: c.volumeBackupId,
        kind: 'volume',
        resourceId,
        resourceType,
        name: c.name,
        destinationId: c.destinationId,
        prefix: c.prefix,
        enabled: c.enabled ?? false,
        schedule: c.cronExpression,
        volumeName: c.volumeName,
        turnOff: c.turnOff ?? false,
      }),
    );
    if (resourceType === 'postgres') {
      const found = z
        .object({
          backups: z
            .array(
              z.object({
                backupId: z.string(),
                destinationId: z.string(),
                prefix: z.string(),
                enabled: z.boolean().nullish(),
                schedule: z.string(),
                database: z.string().optional(),
              }),
            )
            .optional(),
        })
        .parse(await detail(resourceType, resourceId));
      for (const c of found.backups ?? [])
        items.push(
          dokployNativeConfigurationSchema.parse({
            id: c.backupId,
            kind: 'postgres',
            resourceId,
            resourceType,
            name: c.database ?? resource.name,
            destinationId: c.destinationId,
            prefix: c.prefix,
            enabled: c.enabled ?? false,
            schedule: c.schedule,
            volumeName: null,
            turnOff: false,
          }),
        );
    }
    return { items, resource };
  }
  async function nativeConfig(selection: z.infer<typeof dokployNativeSelectionSchema>) {
    const { items, resource } = await configurations(selection.resourceType, selection.resourceId),
      config = items.find((i) => i.id === selection.configurationId && i.kind === selection.kind);
    if (!config) throw new Error('Native config is not attached to selected resource');
    if (
      config.kind === 'volume' &&
      (!resource.mounts.some((m) => m.type === 'volume' && m.volumeName === config.volumeName) ||
        config.turnOff)
    )
      throw new Error('Only mounted named volumes without automatic pause are supported');
    const raw = z.record(z.string(), z.unknown()).parse(
      await request(config.kind === 'postgres' ? 'backup.one' : 'volumeBackups.one', {
        [config.kind === 'postgres' ? 'backupId' : 'volumeBackupId']: config.id,
      }),
    );
    if (
      raw.destinationId !== config.destinationId ||
      raw.prefix !== config.prefix ||
      raw[`${selection.resourceType}Id`] !== selection.resourceId
    )
      throw new Error('Native config identity changed');
    // getVolumeServiceAppName in v0.29.13 uses the linked service's appName,
    // with a Compose service suffix; the backup job's appName is only staging.
    let appName = resource.appName;
    if (config.kind === 'volume') {
      const linked = z.object({ appName: z.string() }).parse(raw[selection.resourceType]);
      if (linked.appName !== resource.appName) throw new Error('Linked service identity changed');
      if (selection.resourceType === 'compose') {
        const serviceName = z.string().nullish().parse(raw.serviceName);
        if (serviceName) appName += `_${serviceName}`;
      }
    }
    const serverId = z
      .string()
      .nullish()
      .parse(
        raw.serverId ??
          z
            .object({ serverId: z.string().nullish() })
            .parse(await detail(selection.resourceType, selection.resourceId)).serverId,
      );
    const search =
      appName +
      '/' +
      config.prefix.replace(/^\/+|\/+$/g, '') +
      (config.prefix.replace(/^\/+|\/+$/g, '') ? '/' : '');
    if (search.includes('..') || search.includes('\\')) throw new Error('Invalid native prefix');
    return { config, search, serverId };
  }
  const files = async (destinationId: string, search: string, serverId?: string | null) =>
    z
      .array(
        z.object({
          Path: z.string().max(1000),
          Name: z.string(),
          Size: z.number().int().nonnegative(),
          IsDir: z.boolean(),
        }),
      )
      .max(100)
      .parse(
        await request('backup.listBackupFiles', {
          destinationId,
          search,
          ...(serverId ? { serverId } : {}),
        }),
      );
  return {
    discover,
    configurations,
    nativeConfig,
    files,
    run: async (kind: 'postgres' | 'volume', id: string) =>
      request(
        kind === 'postgres' ? 'backup.manualBackupPostgres' : 'volumeBackups.runManually',
        { [kind === 'postgres' ? 'backupId' : 'volumeBackupId']: id },
        true,
      ),
  };
}
