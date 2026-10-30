import { z } from 'zod';
import { publicReferenceSchema, uuidSchema } from './common.js';

export const destinationKindSchema = z.enum(['local', 'sftp', 'smb', 'google_drive', 's3', 'pbs']);
export const destinationStatusSchema = z.enum([
  'aguardando_configuracao',
  'ativo',
  'indisponivel',
  'desabilitado',
]);
export const connectorCapabilitiesSchema = z.strictObject({
  encrypted: z.boolean(),
  platformRetention: z.boolean(),
  restrictedDeletion: z.boolean(),
  independentSnapshot: z.boolean(),
  immutable: z.boolean(),
});
export const destinationSchema = z
  .strictObject({
    id: uuidSchema,
    organizationId: uuidSchema,
    name: z.string().trim().min(1).max(200),
    kind: destinationKindSchema.nullable(),
    host: z
      .string()
      .regex(/^[a-zA-Z0-9.-]+$/)
      .optional(),
    status: destinationStatusSchema.default('aguardando_configuracao'),
    rootPath: publicReferenceSchema.optional(),
    credentialReference: uuidSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.status === 'ativo' && (!value.kind || !value.rootPath || !value.credentialReference))
      context.addIssue({
        code: 'custom',
        message: 'Configure dedicated path and credential reference before activation',
        path: ['status'],
      });
  });
export type DestinationKind = z.infer<typeof destinationKindSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export type ConnectorCapabilities = z.infer<typeof connectorCapabilitiesSchema>;
const line = z
  .string()
  .max(4096)
  .regex(/^[^\r\n\0]*$/);
export const destinationConfigurationSchema = z.strictObject({
  backend: z.enum(['mounted', 's3', 'sftp', 'smb', 'google_drive']),
  endpoint: z
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/' &&
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))
      );
    }, 'Use HTTPS sem credenciais ou parâmetros.')
    .optional(),
  bucket: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  region: line.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  share: z
    .string()
    .regex(/^[A-Za-z0-9_. -]{1,100}$/)
    .optional(),
  domain: line.optional(),
  rootFolderId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
  hostKey: z
    .string()
    .regex(/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+$/)
    .optional(),
});
export const destinationCredentialSchema = z.strictObject({
  secret: line.min(1),
  username: line.optional(),
  password: line.optional(),
  accessKey: line.optional(),
  secretKey: line.optional(),
  sessionToken: line.optional(),
  clientId: line.optional(),
  clientSecret: line.optional(),
  driveToken: z
    .strictObject({
      access_token: line.min(1),
      token_type: z.literal('Bearer'),
      refresh_token: line.min(1),
      expiry: z.iso.datetime({ offset: true }),
      expires_in: z.number().int().positive().optional(),
    })
    .optional(),
});
export const repositoryRuntimeSchema = z.strictObject({
  repositoryId: uuidSchema,
  destinationId: uuidSchema,
  configurationRevision: z.number().int().positive(),
  kind: destinationKindSchema,
  host: z.string().nullable(),
  rootPath: z.string().min(1),
  configuration: destinationConfigurationSchema.nullable(),
  credential: destinationCredentialSchema,
  nativeRepositoryId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type RepositoryRuntime = z.infer<typeof repositoryRuntimeSchema>;
export const pointDestinationsResultSchema = z.object({
  capturedAt: z.iso.datetime({ offset: true }),
  items: z.array(
    z.object({
      repositoryId: uuidSchema,
      name: z.string(),
      status: z.enum([
        'aguardando',
        'verificando',
        'capturando',
        'enviando',
        'verificando_destino',
        'concluida',
        'falhas_parciais',
        'falhou',
        'cancelada',
        'exige_intervencao',
        'expirado',
        'retencao_pendente',
      ]),
      verifiedAt: z.iso.datetime({ offset: true }).nullable(),
      snapshotId: z.string().nullable(),
    }),
  ),
});
