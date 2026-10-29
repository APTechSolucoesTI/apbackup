import { z } from 'zod';
import {
  adapterSchema,
  artifactPathSchema,
  consistencySchema,
  publicReferenceSchema,
  restoreCapabilitySchema,
  sha256Schema,
  uuidSchema,
} from './common.js';
import { dependencySchema, resourceKindSchema } from './resources.js';

export const manifestComponentSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  resourceId: uuidSchema,
  kind: resourceKindSchema,
  artifactPath: artifactPathSchema,
  sha256: sha256Schema,
  sizeBytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    organizationId: uuidSchema,
    serverId: uuidSchema,
    profileId: uuidSchema,
    profileVersion: z.int().positive(),
    adapter: adapterSchema,
    capturedAt: z.iso.datetime({ offset: true }),
    consistency: consistencySchema,
    requiredComponentIds: z.array(z.string().min(1)).min(1),
    components: z.array(manifestComponentSchema).min(1),
    images: z.array(
      z.strictObject({
        reference: publicReferenceSchema,
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      }),
    ),
    encryptedConfiguration: z
      .strictObject({
        artifactPath: artifactPathSchema,
        sha256: sha256Schema,
        keyReference: publicReferenceSchema,
      })
      .nullable(),
    dependencies: z.array(dependencySchema),
    restoreCapabilities: z.array(restoreCapabilitySchema).min(1),
  })
  .superRefine((manifest, context) => {
    if (
      manifest.encryptedConfiguration === null &&
      !['postgresql', 'docker-resource'].includes(manifest.adapter.name)
    )
      context.addIssue({
        code: 'custom',
        message: 'Encrypted configuration required for this adapter',
        path: ['encryptedConfiguration'],
      });
    const ids = manifest.components.map((component) => component.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        message: 'Component identities must be unique',
        path: ['components'],
      });
    if (new Set(manifest.requiredComponentIds).size !== manifest.requiredComponentIds.length)
      context.addIssue({
        code: 'custom',
        message: 'Required component identities must be unique',
        path: ['requiredComponentIds'],
      });
    for (const id of manifest.requiredComponentIds) {
      if (!ids.includes(id))
        context.addIssue({
          code: 'custom',
          message: `Missing required component: ${id}`,
          path: ['components'],
        });
    }
  });
export type ManifestComponent = z.infer<typeof manifestComponentSchema>;
export type RecoveryManifest = z.infer<typeof manifestSchema>;
