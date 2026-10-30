import { z } from 'zod';
import { uuidSchema } from './common.js';
export const systemComponentInputSchema = z.strictObject({
  planId: uuidSchema,
  kind: z.enum(['application', 'database', 'files']),
  label: z.string().trim().min(1).max(160),
  scopeNote: z.string().trim().max(2000).default(''),
  shared: z.boolean().default(false),
});
export const backupSystemInputSchema = z
  .strictObject({
    id: uuidSchema.optional(),
    serverId: uuidSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    scopeNotes: z.string().trim().max(4000).default(''),
    sortOrder: z.number().int().min(-100000).max(100000).default(0),
    components: z.array(systemComponentInputSchema).max(100),
  })
  .refine(
    (v) => new Set(v.components.map((c) => `${c.planId}:${c.kind}`)).size === v.components.length,
    { message: 'Remova componentes repetidos.', path: ['components'] },
  );
const execution = z.object({ id: uuidSchema, status: z.string(), createdAt: z.string() });
const destination = z.object({
  repositoryId: uuidSchema,
  name: z.string(),
  kind: z.string().nullable(),
  required: z.boolean(),
  status: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  removedAt: z.string().nullable(),
  retentionPending: z.boolean().nullable(),
});
export const backupSystemComponentSchema = systemComponentInputSchema.extend({
  planName: z.string(),
  enabled: z.boolean(),
  profileVersionId: uuidSchema.nullable(),
  adapter: z.string().nullable(),
  retentionDays: z.number().nullable(),
  schedules: z.array(z.object({ time: z.string(), timezone: z.string(), enabled: z.boolean() })),
  latest: execution.nullable(),
  points: z.array(
    z.object({
      id: uuidSchema,
      status: z.string(),
      capturedAt: z.string(),
      destinations: z.array(destination),
    }),
  ),
  destinations: z.array(destination),
});
export const backupSystemSchema = z.object({
  id: uuidSchema,
  serverId: uuidSchema,
  serverName: z.string(),
  name: z.string(),
  description: z.string(),
  scopeNotes: z.string(),
  sortOrder: z.number(),
  components: z.array(backupSystemComponentSchema),
});
export const backupSystemsOverviewSchema = z.object({ items: z.array(backupSystemSchema) });
export const systemBackupInputSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
});
export const systemBackupResultSchema = z.object({
  runId: uuidSchema,
  executions: z.array(z.object({ planId: uuidSchema, executionId: uuidSchema })),
});
export const systemEditorOptionsSchema = z.object({
  servers: z.array(z.object({ id: uuidSchema, name: z.string() })),
  plans: z.array(z.object({ id: uuidSchema, serverId: uuidSchema, name: z.string() })),
});
