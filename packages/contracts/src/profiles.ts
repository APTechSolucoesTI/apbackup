import { z } from 'zod';
import { adapterSchema, consistencySchema, restoreCapabilitySchema, uuidSchema } from './common.js';
import { dependencySchema } from './resources.js';

export const profileVersionSchema = z
  .strictObject({
    profileId: uuidSchema,
    version: z.int().positive(),
    adapter: adapterSchema,
    consistency: consistencySchema,
    resources: z.array(z.strictObject({ resourceId: uuidSchema, required: z.boolean() })).min(1),
    dependencies: z.array(dependencySchema),
    restoreCapabilities: z.array(restoreCapabilitySchema).min(1),
  })
  .superRefine((profile, context) => {
    const ids = profile.resources.map((resource) => resource.resourceId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        message: 'Profile resources must be unique',
        path: ['resources'],
      });
  });
export type ProfileVersion = z.infer<typeof profileVersionSchema>;
