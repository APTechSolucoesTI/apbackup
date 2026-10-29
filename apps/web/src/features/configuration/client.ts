import { z } from 'zod';
import {
  serverReadSchema,
  resourceReadSchema,
  profileReadSchema,
  destinationReadSchema,
  planReadSchema,
  type ConfigurationKind,
} from '@apbackup/contracts';
export const configurationRecordSchema = z.union([
  serverReadSchema,
  resourceReadSchema,
  profileReadSchema,
  destinationReadSchema,
  planReadSchema,
]);
export type ConfigurationRecord = z.infer<typeof configurationRecordSchema>;
export const readSchemas: Record<ConfigurationKind, z.ZodType<ConfigurationRecord>> = {
  servers: serverReadSchema,
  resources: resourceReadSchema,
  systems: profileReadSchema,
  destinations: destinationReadSchema,
  plans: planReadSchema,
};
export class ConfigurationRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
export async function configurationRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/configuration/${path}`, {
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) window.location.assign('/login');
    const detail = z
      .object({
        error: z.string().max(1000),
        fields: z.record(z.string(), z.string().max(1000)).default({}),
      })
      .safeParse(await response.json().catch(() => null));
    throw new ConfigurationRequestError(
      response.status,
      detail.success ? detail.data.error : 'Não foi possível concluir. Tente novamente.',
      detail.success ? detail.data.fields : {},
    );
  }
  return schema.parse(await response.json());
}
export const entityCopy: Record<
  ConfigurationKind,
  { singular: string; article: string; create: string }
> = {
  servers: { singular: 'servidor', article: 'o', create: 'Cadastrar servidor' },
  resources: { singular: 'recurso', article: 'o', create: 'Cadastrar recurso' },
  systems: { singular: 'sistema', article: 'o', create: 'Cadastrar sistema' },
  destinations: { singular: 'destino', article: 'o', create: 'Cadastrar destino' },
  plans: { singular: 'plano', article: 'o', create: 'Cadastrar plano' },
};
