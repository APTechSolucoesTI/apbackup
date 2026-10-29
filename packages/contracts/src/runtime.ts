import { repositoryRuntimeSchema } from './destinations.js';
import { z } from 'zod';
import { uuidSchema, artifactPathSchema, sha256Schema } from './common.js';
import {
  dockerNameSchema,
  dockerEvidenceSchema,
  dockerRestoredSchema,
  type DockerRuntime,
} from './docker.js';
import {
  postgresDatabaseNameSchema,
  postgresEvidenceSchema,
  postgresRestoreEvidenceSchema,
  type PostgresRuntimeSecrets,
} from './postgresql.js';
export const fencingTokenSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const operationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('repository_copy'),
    recoveryPointId: uuidSchema,
    repositoryId: uuidSchema,
    sourceRepositoryId: uuidSchema,
    snapshotId: sha256Schema,
    repositoryRevisions: z.record(uuidSchema, z.number().int().positive()),
  }),
  z.strictObject({
    kind: z.literal('repository_test'),
    repositoryId: uuidSchema,
    repositoryRevisions: z.record(uuidSchema, z.number().int().positive()),
  }),
  z.strictObject({
    kind: z.literal('repository_retention'),
    repositoryId: uuidSchema,
    repositoryRevisions: z.record(uuidSchema, z.number().int().positive()),
  }),
  z.strictObject({
    kind: z.literal('docker_backup'),
    repositoryId: uuidSchema,
    repositoryIds: z.array(uuidSchema).max(10).optional(),
    repositoryRevisions: z.record(uuidSchema, z.number().int().positive()).optional(),
  }),
  z.strictObject({
    kind: z.literal('docker_restore'),
    repositoryId: uuidSchema,
    recoveryPointId: uuidSchema,
    snapshotId: sha256Schema,
    nativeRepositoryId: sha256Schema,
    sha256: sha256Schema,
    targetName: dockerNameSchema,
    replaceContainer: z.boolean(),
    targetContainerId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    targetServices: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9]{6,64}$/),
          version: z.number().int().nonnegative(),
        }),
      )
      .max(3)
      .optional(),
    redeployGuardConfirmed: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('postgresql_backup'),
    repositoryId: uuidSchema,
    repositoryIds: z.array(uuidSchema).max(10).optional(),
    repositoryRevisions: z.record(uuidSchema, z.number().int().positive()).optional(),
  }),
  z.strictObject({
    kind: z.literal('postgresql_restore'),
    repositoryId: uuidSchema,
    recoveryPointId: uuidSchema,
    snapshotId: sha256Schema,
    nativeRepositoryId: sha256Schema,
    sha256: sha256Schema,
    targetDatabase: postgresDatabaseNameSchema,
  }),
  z.strictObject({ kind: z.literal('inspect'), path: artifactPathSchema }),
  z.strictObject({
    kind: z.literal('archive_files'),
    path: artifactPathSchema,
    artifact: artifactPathSchema,
  }),
  z.strictObject({
    kind: z.literal('service_pause'),
    unit: z.string().regex(/^[a-zA-Z0-9@_.-]+\.service$/),
  }),
  z.strictObject({
    kind: z.literal('service_resume'),
    unit: z.string().regex(/^[a-zA-Z0-9@_.-]+\.service$/),
  }),
]);
export const agentCommandSchema = z.strictObject({
  version: z.literal(1),
  commandId: uuidSchema,
  organizationId: uuidSchema,
  executionId: uuidSchema,
  profileVersionId: uuidSchema,
  agentId: uuidSchema,
  resourceId: uuidSchema,
  fencingToken: fencingTokenSchema,
  expiresAt: z.iso.datetime(),
  operation: operationSchema,
});
export const agentResultSchema = z.strictObject({
  commandId: uuidSchema,
  sequence: z.literal(1),
  outcome: z.enum(['completed', 'failed', 'unknown', 'rejected']),
  code: z.enum([
    'ok',
    'execution_failed',
    'effect_unknown',
    'command_rejected',
    'watchdog_incident',
  ]),
  postgres: postgresEvidenceSchema.optional(),
  docker: dockerEvidenceSchema.optional(),
  dockerRestored: dockerRestoredSchema.optional(),
  restored: postgresRestoreEvidenceSchema.optional(),
  failureStage: z
    .enum([
      'connection',
      'capture',
      'archive',
      'repository',
      'snapshot',
      'verification',
      'target',
      'restore',
    ])
    .optional(),
  staging: z.enum(['cleaned', 'retained']).optional(),
  replications: z
    .array(
      z.strictObject({
        repositoryId: uuidSchema,
        status: z.enum(['concluida', 'falhou']),
        nativeRepositoryId: sha256Schema.optional(),
        snapshotId: sha256Schema.optional(),
        verifiedAt: z.iso.datetime().optional(),
      }),
    )
    .max(10)
    .optional(),
  repository: z
    .strictObject({
      repositoryId: uuidSchema,
      nativeRepositoryId: sha256Schema,
      verifiedAt: z.iso.datetime(),
    })
    .optional(),
  retention: z
    .strictObject({
      repositoryId: uuidSchema,
      forgotten: z.array(sha256Schema).max(1000),
      protected: z.array(sha256Schema).max(1000),
      pruned: z.boolean(),
    })
    .optional(),
  artifact: z
    .strictObject({
      path: artifactPathSchema,
      sha256: sha256Schema,
      sizeBytes: z.string().regex(/^\d+$/),
    })
    .optional(),
});
export type AgentCommand = z.infer<typeof agentCommandSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;
export interface ExecutionContext {
  organizationId: string;
  executionId: string;
  profileVersionId: string;
  agentId: string;
  fencingToken: string;
  signal: AbortSignal;
  /** Trusted transport callback, never serialized; mandatory for a mutable host effect. */
  authorizeEffect?: (command: AgentCommand) => Promise<boolean>;
  resolveRepositories?: (command: AgentCommand) => Promise<{
    repositories: z.infer<typeof repositoryRuntimeSchema>[];
    files: { name: string; sha256: string }[];
    cleanup?: { executionId: string; commandId: string } | undefined;
    retention?: { forget: string[]; protect: string[] } | undefined;
  }>;
  resolvePostgres?: (command: AgentCommand) => Promise<PostgresRuntimeSecrets>;
  resolveDocker?: (command: AgentCommand) => Promise<DockerRuntime>;
}
export interface Connector {
  readonly name: string;
  readonly version: string;
  run(command: AgentCommand, context: ExecutionContext): Promise<AgentResult>;
}
