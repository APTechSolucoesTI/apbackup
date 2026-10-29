import { z } from 'zod';
import {
  adapterSchema,
  consistencySchema,
  publicReferenceSchema,
  restoreCapabilitySchema,
  uuidSchema,
} from './common.js';
import {
  destinationKindSchema,
  destinationStatusSchema,
  connectorCapabilitiesSchema,
  destinationConfigurationSchema,
  destinationCredentialSchema,
} from './destinations.js';
import { dependencySchema, resourceKindSchema } from './resources.js';
import { profileVersionSchema } from './profiles.js';
import { retentionPolicySchema, scheduleSchema } from './operations.js';
export const configurationKindSchema = z.enum([
  'servers',
  'resources',
  'systems',
  'destinations',
  'plans',
]);
export type ConfigurationKind = z.infer<typeof configurationKindSchema>;
const name = z.string().trim().min(1, 'Informe um nome.').max(200, 'Use até 200 caracteres.');
const hostname = z
  .string()
  .trim()
  .max(253)
  .regex(/^[a-zA-Z0-9.-]*$/, 'Informe um hostname ou endereço válido.')
  .nullable()
  .default(null);
export const serverInputSchema = z.strictObject({
  name,
  externalIdentity: publicReferenceSchema,
  hostname,
});
export const resourceInputSchema = z.strictObject({
  name,
  serverId: uuidSchema,
  kind: resourceKindSchema,
  externalIdentity: publicReferenceSchema,
  dependencies: z
    .array(z.strictObject({ dependsOnResourceId: uuidSchema, shared: z.boolean() }))
    .max(100)
    .default([]),
});
export const profileInputSchema = z.strictObject({
  name,
  serverId: uuidSchema,
  externalIdentity: publicReferenceSchema,
  adapter: adapterSchema,
  consistency: consistencySchema,
  resources: z
    .array(z.strictObject({ resourceId: uuidSchema, required: z.boolean() }))
    .min(1, 'Selecione ao menos um recurso.')
    .max(200),
  restoreCapabilities: z
    .array(restoreCapabilitySchema)
    .min(1, 'Selecione ao menos um escopo de restauração.'),
});
export const destinationInputSchema = z.strictObject({
  name,
  host: hostname,
  kind: destinationKindSchema.nullable().default(null),
  engine: z.enum(['restic', 'pbs']).nullable().default(null),
  rootPath: publicReferenceSchema.nullable().default(null),
  status: destinationStatusSchema.default('aguardando_configuracao'),
  configuration: destinationConfigurationSchema.nullable().default(null),
  credential: destinationCredentialSchema.optional(),
});
export const planInputSchema = z.strictObject({
  name,
  profileVersionId: uuidSchema,
  destinations: z
    .array(z.strictObject({ destinationId: uuidSchema, required: z.boolean() }))
    .min(1, 'Selecione ao menos um destino.')
    .max(100),
  retention: retentionPolicySchema,
  schedule: scheduleSchema.omit({ planId: true, enabled: true }),
  enabled: z.boolean().default(false),
});
export const mutationVersionSchema = z.strictObject({
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
});
export const serverUpdateSchema = serverInputSchema.extend(mutationVersionSchema.shape);
export const resourceUpdateSchema = resourceInputSchema.extend(mutationVersionSchema.shape);
export const profileUpdateSchema = profileInputSchema.extend(mutationVersionSchema.shape);
export const destinationUpdateSchema = destinationInputSchema.extend(mutationVersionSchema.shape);
export const planUpdateSchema = planInputSchema.extend(mutationVersionSchema.shape);
const instant = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.iso.datetime({ offset: true }),
);
export const configurationBaseSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string(),
  createdAt: instant,
  updatedAt: instant,
  archivedAt: instant.nullable(),
});
export const serverReadSchema = configurationBaseSchema.extend({
  externalIdentity: z.string(),
  hostname: z.string().nullable(),
});
export const resourceReadSchema = configurationBaseSchema.extend({
  serverId: uuidSchema,
  externalIdentity: z.string(),
  kind: resourceKindSchema,
  dependencies: z.array(dependencySchema),
});
export const profileReadSchema = configurationBaseSchema.extend({
  serverId: uuidSchema,
  externalIdentity: z.string(),
  versionId: uuidSchema,
  version: z.number().int().positive(),
  definition: profileVersionSchema,
});
export const systemProfileSchema = profileReadSchema.extend({
  resourceDetails: z.array(resourceReadSchema),
});
export const destinationReadSchema = configurationBaseSchema.extend({
  configuration: destinationConfigurationSchema.nullable().default(null),
  host: z.string().nullable(),
  kind: destinationKindSchema.nullable(),
  engine: z.enum(['restic', 'pbs']).nullable(),
  rootPath: z.string().nullable(),
  status: destinationStatusSchema,
  hasCredential: z.boolean(),
  repositoryId: uuidSchema,
  coverage: z.boolean(),
  assessment: z
    .object({
      configurationRevision: z.number().int().positive(),
      assessedAt: instant,
      capabilities: connectorCapabilitiesSchema,
    })
    .nullable(),
});
export const planReadSchema = configurationBaseSchema.extend({
  serverId: uuidSchema,
  profileVersionId: uuidSchema,
  enabled: z.boolean(),
  destinations: z.array(
    z.object({ destinationId: uuidSchema, repositoryId: uuidSchema, required: z.boolean() }),
  ),
  retention: retentionPolicySchema,
  schedule: scheduleSchema.omit({ planId: true }),
});
export const coverageSummarySchema = z.object({
  serverId: uuidSchema,
  covered: z.boolean(),
  resourceCount: z.number().int().nonnegative(),
  protectedResourceCount: z.number().int().nonnegative(),
  verifiedPointCount: z.number().int().nonnegative(),
  latestVerifiedAt: instant.nullable(),
});
export const optionSchema = z.object({
  destinationKind: destinationKindSchema.nullable().optional(),
  localCapture: z.boolean().optional(),
  id: uuidSchema,
  label: z.string(),
  detail: z.string(),
  serverId: uuidSchema.nullable(),
});
export const optionsResultSchema = z.object({
  items: z.array(optionSchema),
  total: z.number().int().nonnegative(),
});
export type ServerInput = z.infer<typeof serverInputSchema>;
export type ResourceInput = z.infer<typeof resourceInputSchema>;
export type ProfileInput = z.infer<typeof profileInputSchema>;
export type DestinationInput = z.infer<typeof destinationInputSchema>;
export type PlanInput = z.infer<typeof planInputSchema>;
export type SystemProfile = z.infer<typeof systemProfileSchema>;
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;
