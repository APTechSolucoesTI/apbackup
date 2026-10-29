import { mkdtemp, writeFile, rm, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
test('safe paths reject traversal, prefix confusion and symlink escapes', async () => {
  const { safePath } = await import('../../packages/connectors/src/runtime/safe-path.js');
  const root = await mkdtemp(join(tmpdir(), 'apbackup-safe-'));
  try {
    await writeFile(join(root, 'ok'), 'ok');
    expect(await safePath(root, 'ok')).toBe(await realpath(join(root, 'ok')));
    await expect(safePath(root, '../outside')).rejects.toThrow();
    await expect(safePath(root, '/etc/passwd')).rejects.toThrow();
    await mkdir(join(root, 'folder'));
    if (process.platform !== 'win32') {
      await symlink('/etc', join(root, 'escape'));
      await expect(safePath(root, 'escape/passwd')).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('wire contracts reject generic tool arguments and preserve bigint fencing', async () => {
  const { agentCommandSchema } = await import('../../packages/contracts/src/runtime.js');
  expect(
    agentCommandSchema.safeParse({ tool: 'docker', args: ['run', '--privileged'] }).success,
  ).toBe(false);
  const { spawnTool } = await import('../../packages/connectors/src/runtime/spawn-tool.js');
  await expect(
    spawnTool('arbitrary' as never, [], {
      cwd: process.cwd(),
      timeoutMs: 100,
      diagnosticLimit: 100,
    }),
  ).rejects.toThrow();
});
