import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
const contextSchema = z
  .object({
    organizationId: z.string().min(1),
    reference: z.string().min(1),
    purpose: z.string().min(1),
  })
  .strict();
export type SecretContext = z.infer<typeof contextSchema>;
const envelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    keyReference: z.string(),
    iv: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 12, 'Vault IV must be 12 bytes'),
    tag: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 16, 'Vault tag must be 16 bytes'),
    ciphertext: z.string(),
  })
  .strict();
export type EncryptedSecret = z.infer<typeof envelopeSchema>;
function custodyVault() {
  const key = process.env.VAULT_KEY_BASE64;
  const reference = process.env.VAULT_KEY_REFERENCE;
  if (!key || !reference) throw new Error('Configure external vault key custody');
  return createVault(Buffer.from(key, 'base64'), reference);
}
export function encryptSecret(plaintext: string, context: SecretContext): EncryptedSecret {
  return custodyVault().encryptSecret(plaintext, context);
}
export function decryptSecret(envelope: EncryptedSecret, context: SecretContext): string {
  return custodyVault().decryptSecret(envelope, context);
}
export function createVault(key: Uint8Array, keyReference: string) {
  if (key.byteLength !== 32 || !keyReference.trim())
    throw new Error('A 32-byte vault key and custody reference are required');
  const keyBytes = Buffer.from(key);
  function aad(context: SecretContext) {
    const c = contextSchema.parse(context);
    return Buffer.from(JSON.stringify([1, keyReference, c.organizationId, c.reference, c.purpose]));
  }
  return {
    encryptSecret(plaintext: string, context: SecretContext): EncryptedSecret {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyBytes, iv, { authTagLength: 16 });
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        version: 1,
        algorithm: 'aes-256-gcm',
        keyReference,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    },
    decryptSecret(value: EncryptedSecret, context: SecretContext): string {
      const envelope = envelopeSchema.parse(value);
      if (envelope.keyReference !== keyReference) throw new Error('Unknown vault key reference');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        keyBytes,
        Buffer.from(envelope.iv, 'base64'),
        { authTagLength: 16 },
      );
      decipher.setAAD(aad(context));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
