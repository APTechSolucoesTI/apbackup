import { z } from 'zod';

export const uuidSchema = z.uuid();
// Public identifiers are references, never DSNs, OAuth tokens, PEM keys or authenticated URLs.
export const publicReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/(:\/\/|\bBearer\s|-----BEGIN|\b(password|passwd|token|secret|api[_-]?key)\s*[=:]|eyJ[A-Za-z0-9_-]+\.)/i.test(
        value,
      ),
    'Use an opaque reference without credentials',
  );
export const artifactPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes(':') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Artifact path must stay inside its recovery set',
  );
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const adapterSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
});
export const consistencySchema = z.enum([
  'application_consistent',
  'transactional',
  'crash_consistent',
  'file_consistent',
]);
export const restoreCapabilitySchema = z.enum([
  'system',
  'database',
  'files',
  'vm',
  'host_configuration',
]);
export const roleSchema = z.enum([
  'administrator',
  'backup_operator',
  'restore_operator',
  'viewer',
]);
export type Role = z.infer<typeof roleSchema>;

// Hashable catalog JSON: recursive UTF-16 key ordering, original array order, JSON values only.
export function canonicalJson(value: unknown): string {
  function normalize(current: unknown): unknown {
    if (current === null || typeof current === 'string' || typeof current === 'boolean')
      return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current;
    if (Array.isArray(current)) return current.map(normalize);
    if (
      current &&
      typeof current === 'object' &&
      (Object.getPrototypeOf(current) === Object.prototype ||
        Object.getPrototypeOf(current) === null)
    )
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .map((key) => [key, normalize((current as Record<string, unknown>)[key])]),
      );
    throw new TypeError('Only JSON values can be hashed');
  }
  return JSON.stringify(normalize(value));
}
