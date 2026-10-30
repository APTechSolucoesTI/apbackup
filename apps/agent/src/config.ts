import { z } from 'zod';
import { lstat, open, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { uuidSchema } from '@apbackup/contracts';
import { trustedDirectory } from '../../../packages/connectors/src/runtime/safe-path.js';
const absolutePath = z
  .string()
  .min(1)
  .refine((v) => v === resolve(v));
export const agentConfigSchema = z.strictObject({
  baseURL: z.url().refine((v) => new URL(v).protocol === 'https:'),
  agentId: uuidSchema,
  organizationId: uuidSchema,
  identity: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  journalDirectory: absolutePath,
  artifactRoot: absolutePath,
  docker: z
    .strictObject({
      socketPath: absolutePath,
      helperImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      repositoryRoot: absolutePath,
      directories: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/), absolutePath),
      dynamicOverlayNetworks: z
        .record(
          z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
          z.string().regex(/^[a-zA-Z0-9]{12,64}$/),
        )
        .optional(),
    })
    .optional(),
  postgresql: z
    .strictObject({
      allowedHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).default([]),
      dockerSocketPath: absolutePath.optional(),
      allowedDockerContainers: z
        .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/))
        .max(100)
        .default([]),
      repositoryRoot: absolutePath,
    })
    .optional(),
  repositories: z
    .strictObject({
      repositoryRoot: absolutePath,
      mountedRoots: z.array(absolutePath).default([]),
      allowedHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).default([]),
    })
    .optional(),
  resources: z.record(
    uuidSchema,
    z.strictObject({
      root: absolutePath,
      units: z.array(z.string().regex(/^[a-zA-Z0-9@_.-]+\.service$/)),
    }),
  ),
});
export async function readAgentConfig(path: string) {
  await trustedDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.size > 65536 || (process.platform !== 'win32' && (s.mode & 0o077) !== 0))
      throw new Error('Agent configuration must be private');
    return agentConfigSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}
export async function saveAgentConfig(path: string, value: unknown) {
  const config = agentConfigSchema.parse(value),
    directory = dirname(path);
  await trustedDirectory(directory, { create: true });
  try {
    await lstat(path);
    throw new Error('Configuration exists; revoke old identity before replacing');
  } catch (e) {
    if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e;
  }
  const temporary = path + '.' + randomUUID();
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(config));
    await file.sync();
  } finally {
    await file.close();
  }
  // Atomic publication with no replacement of an existing enrolled identity.
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary);
  }
  if (process.platform !== 'win32') {
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
