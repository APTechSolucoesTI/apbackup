import { z } from 'zod';
import { uuidSchema } from './common.js';
export const dokployConnectionInputSchema = z.strictObject({
  serverId: uuidSchema,
  name: z.string().trim().min(1).max(200),
  endpoint: z
    .url()
    .max(500)
    .refine((v) => {
      const u = new URL(v);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/' &&
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))
      );
    }, 'Use a origem HTTPS do Dokploy.'),
  apiKey: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\0]+$/),
});
export const dokployConnectionSchema = dokployConnectionInputSchema
  .omit({ apiKey: true })
  .extend({ id: uuidSchema });
export const dokployServiceTypeSchema = z.enum(['application', 'compose', 'postgres']);
export const dokployCatalogSchema = z.strictObject({
  version: z.string().max(50),
  supported: z.boolean(),
  resources: z
    .array(
      z.strictObject({
        id: z.string().max(128),
        kind: dokployServiceTypeSchema,
        name: z.string().max(200),
        appName: z.string().max(200),
        project: z.string().max(200),
        environment: z.string().max(200),
        mounts: z
          .array(
            z.strictObject({
              id: z.string(),
              type: z.string(),
              volumeName: z.string().nullable(),
              mountPath: z.string(),
            }),
          )
          .max(100),
      }),
    )
    .max(1000),
  limitations: z.array(z.string()),
});
export const dokployNativeSelectionSchema = z.strictObject({
  connectionId: uuidSchema,
  kind: z.enum(['postgres', 'volume']),
  configurationId: z.string().min(1).max(128),
  resourceId: z.string().min(1).max(128),
  resourceType: dokployServiceTypeSchema,
});
export const dokployNativeConfigurationSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['postgres', 'volume']),
  resourceId: z.string(),
  resourceType: dokployServiceTypeSchema,
  name: z.string(),
  destinationId: z.string(),
  prefix: z.string(),
  enabled: z.boolean(),
  schedule: z.string(),
  volumeName: z.string().nullable(),
  turnOff: z.boolean(),
});
