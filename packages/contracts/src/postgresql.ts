import { repositoryRuntimeSchema } from './destinations.js';
import { z } from 'zod';
import { uuidSchema, sha256Schema } from './common.js';
export const postgresSourceDatabaseSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
  .refine((v) => !['template0', 'template1'].includes(v));
export const postgresSchemaNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
  .refine(
    (v) =>
      !v.startsWith('pg_') &&
      ![
        'information_schema',
        'auth',
        'storage',
        'vault',
        'extensions',
        'realtime',
        'supabase_functions',
        'supabase_migrations',
        'graphql',
        'graphql_public',
      ].includes(v),
    'Schema gerenciado exige recuperação específica e revisão de dependências.',
  );
export const postgresSchemaScope = z
  .array(postgresSchemaNameSchema)
  .max(100)
  .default([])
  .transform((v) => [...new Set(v)].sort());
export const postgresDatabaseNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Use até 63 letras, números ou sublinhado.')
  .refine(
    (v) => !['postgres', 'template0', 'template1'].includes(v.toLowerCase()),
    'Banco reservado. Escolha um banco de aplicação.',
  );
export const postgresConnectionInputSchema = z.strictObject({
  serverId: uuidSchema,
  name: z.string().trim().min(1).max(200),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/),
  port: z.number().int().min(1).max(65535).default(5432),
  username: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
  password: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\0]+$/),
  sslMode: z.enum(['verify-full', 'disable']).default('verify-full'),
});
export const postgresConnectionSchema = postgresConnectionInputSchema
  .omit({ password: true })
  .extend({ id: uuidSchema });
export const postgresSelectionSchema = z.strictObject({
  connectionId: uuidSchema,
  database: postgresSourceDatabaseSchema,
  schemas: postgresSchemaScope,
});
export const postgresPlanSchema = z.strictObject({
  profileVersionId: uuidSchema,
  destinationId: uuidSchema,
  destinationIds: z.array(uuidSchema).min(1).max(10).optional(),
  name: z.string().trim().min(1).max(200),
  scheduleEnabled: z.boolean().default(false),
  localTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('03:00'),
  timezone: z.string().min(1).max(100).default('America/Sao_Paulo'),
});
export const postgresEvidenceSchema = z.strictObject({
  repositoryId: uuidSchema,
  nativeRepositoryId: sha256Schema,
  snapshotId: sha256Schema,
  database: postgresSourceDatabaseSchema,
  schemas: postgresSchemaScope,
  serverMajor: z.literal(17),
  capturedAt: z.iso.datetime(),
  sha256: sha256Schema,
  sizeBytes: z.string().regex(/^\d+$/),
});
export const postgresRestoreEvidenceSchema = z.strictObject({
  database: postgresSourceDatabaseSchema,
  schemas: postgresSchemaScope,
  tables: z
    .array(
      z.strictObject({ schema: z.string(), name: z.string(), rows: z.string().regex(/^\d+$/) }),
    )
    .max(10000),
  verifiedAt: z.iso.datetime(),
});
export const postgresRuntimeSecretsSchema = z.strictObject({
  connection: postgresConnectionInputSchema.omit({ name: true, serverId: true }),
  database: postgresSourceDatabaseSchema,
  schemas: postgresSchemaScope,
  repositoryPath: z.string().min(1),
  repositoryPassword: z.string().min(1),
  repository: repositoryRuntimeSchema.optional(),
});
export type PostgresEvidence = z.infer<typeof postgresEvidenceSchema>;
export type PostgresRuntimeSecrets = z.infer<typeof postgresRuntimeSecretsSchema>;
