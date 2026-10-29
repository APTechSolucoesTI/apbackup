import { expect, test } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as archive from '../../packages/connectors/src/docker-archive.js';
function tar(name: string, type = '0', link = '') {
  const b = Buffer.alloc(1536);
  b.write(name);
  b.write('0000644\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write('00000000000\0', 124);
  b.write('00000000000\0', 136);
  b.fill(32, 148, 156);
  b.write(type, 156);
  b.write(link, 157);
  b.write('ustar\0', 257);
  const checksum = b.subarray(0, 512).reduce((a, v) => a + v, 0);
  b.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}
test('real archive bytes reject traversal, links, duplicate paths and database data before Docker extraction', async () => {
  expect(typeof archive.validateDataTar).toBe('function');
  const root = await mkdtemp(join(tmpdir(), 'docker-archive-'));
  try {
    for (const bytes of [
      tar('../escape'),
      tar('/etc/escape'),
      tar('a\\b'),
      tar('link', '2', '/outside'),
      tar('hard', '1', 'outside'),
      tar('PG_VERSION'),
      Buffer.concat([tar('duplicate').subarray(0, 512), tar('duplicate')]),
    ]) {
      const file = join(root, 'bad.tar');
      await writeFile(file, bytes);
      await expect(archive.validateDataTar(file, new AbortController().signal)).rejects.toThrow();
    }
    const good = join(root, 'good.tar');
    await writeFile(good, tar('./ação.txt'));
    expect(await archive.validateDataTar(good, new AbortController().signal)).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
