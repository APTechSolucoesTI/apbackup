import { z } from 'zod';
import { publicReferenceSchema, uuidSchema } from './common.js';

export const resourceKindSchema = z.enum([
  'postgresql',
  'files',
  'compose',
  'swarm',
  'dokploy',
  'redis',
  'supabase_schema',
  'supabase_auth',
  'supabase_storage',
  'vm',
  'proxmox_host',
  'pbs_configuration',
]);
export const resourceSchema = z.strictObject({
  id: uuidSchema,
  organizationId: uuidSchema,
  serverId: uuidSchema,
  name: z.string().trim().min(1).max(200),
  kind: resourceKindSchema,
  externalIdentity: publicReferenceSchema,
});
export const dependencySchema = z
  .strictObject({
    resourceId: uuidSchema,
    dependsOnResourceId: uuidSchema,
    shared: z.boolean().default(false),
  })
  .refine(
    (value) => value.resourceId !== value.dependsOnResourceId,
    'A resource cannot depend on itself',
  );
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type ResourceDependency = z.infer<typeof dependencySchema>;
