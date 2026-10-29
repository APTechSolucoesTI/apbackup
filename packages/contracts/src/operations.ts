import { z } from 'zod';
import { restoreCapabilitySchema, uuidSchema } from './common.js';

export const executionStatusSchema = z.enum([
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
]);
export const operationKindSchema = z.enum([
  'backup',
  'restore',
  'verify',
  'retention',
  'catalog_export',
  'recovery_drill',
]);
export const scheduleSchema = z.strictObject({
  planId: uuidSchema,
  localTime: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .default('03:00'),
  timezone: z
    .string()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('pt-BR', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid IANA timezone')
    .default('America/Sao_Paulo'),
  enabled: z.boolean().default(false),
});
export const retentionPolicySchema = z.strictObject({
  days: z.int().positive().default(7),
  evidenceDays: z.int().positive().default(90),
  protectLastVerified: z.literal(true).default(true),
});
export const restoreScopeSchema = z.strictObject({
  recoveryPointId: uuidSchema,
  capability: restoreCapabilitySchema,
  resourceIds: z.array(uuidSchema).min(1),
  isolated: z.boolean().default(true),
});
export const operationRequestSchema = z
  .strictObject({
    organizationId: uuidSchema,
    kind: operationKindSchema,
    idempotencyKey: z.string().min(1).max(200),
    planId: uuidSchema.optional(),
    restoreScope: restoreScopeSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === 'restore' && !value.restoreScope)
      context.addIssue({
        code: 'custom',
        message: 'Restore scope is required',
        path: ['restoreScope'],
      });
    if (value.kind === 'backup' && !value.planId)
      context.addIssue({ code: 'custom', message: 'Backup plan is required', path: ['planId'] });
  });
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type OperationRequest = z.infer<typeof operationRequestSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RestoreScope = z.infer<typeof restoreScopeSchema>;
