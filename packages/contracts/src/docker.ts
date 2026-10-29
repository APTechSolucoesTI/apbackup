import { repositoryRuntimeSchema } from './destinations.js';
import { z } from 'zod';
import { uuidSchema, sha256Schema } from './common.js';
export const dockerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const dockerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const dockerSelectionSchema = z
  .strictObject({
    serverId: uuidSchema,
    kind: z.enum(['volume', 'directory', 'container', 'swarm']),
    identity: dockerNameSchema,
    services: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9]{6,64}$/),
          role: z.enum(['frontend', 'api', 'worker']),
          preserveEnvironmentKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100),
          startupReviewed: z.literal(true),
        }),
      )
      .min(1)
      .max(3)
      .optional(),
  })
  .superRefine((v, c) => {
    if (
      v.kind === 'swarm'
        ? !v.services ||
          new Set(v.services.map((s) => s.id)).size !== v.services.length ||
          new Set(v.services.map((s) => s.role)).size !== v.services.length
        : v.services !== undefined
    )
      c.addIssue({
        code: 'custom',
        message: 'Selecione serviços e papéis explícitos, sem duplicação.',
      });
  });
export const dockerMountSchema = z.strictObject({
  kind: z.enum(['volume', 'directory']),
  identity: dockerNameSchema,
  destination: z.string().regex(/^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]*$/),
  readOnly: z.boolean(),
  owners: z.array(dockerIdSchema).max(1000),
});
export const dockerCatalogSchema = z.strictObject({
  capturedAt: z.iso.datetime(),
  containers: z
    .array(
      z.strictObject({
        id: dockerIdSchema,
        name: dockerNameSchema,
        imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        imageReference: z.string().max(512),
        state: z.string().max(32),
        mounts: z.array(dockerMountSchema).max(100),
        blockedReason: z.string().max(500).nullable(),
      }),
    )
    .max(1000),
  volumes: z
    .array(
      z.strictObject({
        name: dockerNameSchema,
        owners: z.array(dockerIdSchema).max(1000),
        databaseHint: z.boolean(),
      }),
    )
    .max(1000),
  directories: z.array(z.strictObject({ name: dockerNameSchema })).max(100),
  services: z
    .array(
      z.strictObject({
        id: z.string().max(128),
        name: z.string().max(200),
        version: z.number().int().nonnegative().optional(),
        environmentKeys: z.array(z.string()).optional(),
      }),
    )
    .max(1000),
});
export const dockerEvidenceSchema = z
  .strictObject({
    repositoryId: uuidSchema,
    nativeRepositoryId: sha256Schema,
    snapshotId: sha256Schema,
    capturedAt: z.iso.datetime(),
    sha256: sha256Schema,
    sizeBytes: z.string().regex(/^\d+$/),
    selection: dockerSelectionSchema,
    components: z.array(z.string().regex(/^[a-z0-9_.-]+$/)).min(1),
    consistency: z.literal('crash_consistent'),
    imageId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    totalSizeBytes: z.string().regex(/^\d+$/),
    artifacts: z
      .array(
        z.strictObject({
          name: z.string().regex(/^(data-\d+\.tar|config.enc|image(?:-\d+)?\.tar)$/),
          sha256: sha256Schema,
          sizeBytes: z.string().regex(/^\d+$/),
        }),
      )
      .min(1)
      .max(102),
  })
  .superRefine((v, c) => {
    const names = v.artifacts.map((f) => f.name);
    if (
      new Set(names).size !== names.length ||
      v.components.length !== names.length ||
      v.components.some((n, i) => n !== names[i])
    )
      c.addIssue({ code: 'custom', message: 'Exact unique component evidence required' });
    if (
      v.selection.kind === 'container' &&
      (!v.imageId || !names.includes('image.tar') || !names.includes('config.enc'))
    )
      c.addIssue({
        code: 'custom',
        message: 'Application requires historical image and encrypted configuration',
      });
    if (
      v.selection.kind === 'swarm' &&
      (!names.includes('config.enc') ||
        v.selection.services?.some((_, i) => !names.includes(`image-${i}.tar`)))
    )
      c.addIssue({
        code: 'custom',
        message: 'Every service requires an image archive and encrypted configuration',
      });
  });
export const dockerRestoreInputSchema = z
  .strictObject({
    recoveryPointId: uuidSchema,
    repositoryId: uuidSchema.optional(),
    targetName: dockerNameSchema,
    replaceContainer: z.boolean().default(false),
    confirmation: z.string().max(100).default(''),
    idempotencyKey: z.string().min(1).max(160),
    redeployGuardConfirmed: z.boolean().default(false),
  })
  .refine(
    (v) => !v.replaceContainer || v.confirmation === v.targetName,
    'Confirme o nome exato do container.',
  );
export const dockerRestoredSchema = z.strictObject({
  targetName: dockerNameSchema,
  kind: z.enum(['volume', 'directory', 'container', 'swarm']),
  services: z
    .array(z.strictObject({ id: z.string(), role: z.string(), image: z.string() }))
    .optional(),
  containerId: dockerIdSchema.optional(),
  preservedContainerId: dockerIdSchema.optional(),
  targets: z.array(dockerNameSchema).min(1),
  verifiedAt: z.iso.datetime(),
  running: z.boolean(),
  health: z.enum(['not_applicable', 'running', 'healthy']),
});
export const dockerRuntimeSchema = z.strictObject({
  selection: dockerSelectionSchema,
  repositoryPath: dockerNameSchema,
  repositoryPassword: z.string().min(1),
  configurationPassword: z.string().min(1).optional(),
  repository: repositoryRuntimeSchema.optional(),
});
export type DockerCatalog = z.infer<typeof dockerCatalogSchema>;
export type DockerSelection = z.infer<typeof dockerSelectionSchema>;
export type DockerRuntime = z.infer<typeof dockerRuntimeSchema>;
export type DockerEvidence = z.infer<typeof dockerEvidenceSchema>;
