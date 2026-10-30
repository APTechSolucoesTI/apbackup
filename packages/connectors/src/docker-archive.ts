import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
/** Restricted POSIX ustar: regular files/directories only. No extraction occurs here. */
export async function inspectDataTar(path: string, signal: AbortSignal) {
  const f = await open(path, 'r');
  try {
    const size = (await f.stat()).size,
      seen = new Set<string>(),
      records: {
        name: string;
        mode: number;
        uid: number;
        gid: number;
        sha256: string;
        length: number;
        type: string;
      }[] = [];
    let offset = 0,
      entries = 0,
      ended = false;
    if (size < 1024 || size % 512 !== 0) throw new Error('Invalid tar size');
    while (offset < size) {
      signal.throwIfAborted();
      const header = Buffer.alloc(512);
      if ((await f.read(header, 0, 512, offset)).bytesRead !== 512)
        throw new Error('Truncated header');
      offset += 512;
      if (header.every((v) => v === 0)) {
        ended = true;
        continue;
      }
      if (ended) throw new Error('Trailing archive data');
      const text = (start: number, length: number) =>
        header
          .subarray(start, start + length)
          .toString('utf8')
          .split('\0')[0]!;
      const octal = (start: number, length: number) => {
        const v = text(start, length).trim();
        if (!/^[0-7]+$/.test(v)) throw new Error('Invalid tar number');
        const n = parseInt(v, 8);
        if (!Number.isSafeInteger(n)) throw new Error('Tar number too large');
        return n;
      };
      const checksum = octal(148, 8),
        actual = header.reduce((sum, v, i) => sum + (i >= 148 && i < 156 ? 32 : v), 0);
      if (checksum !== actual || text(257, 5) !== 'ustar') throw new Error('Invalid ustar header');
      const prefix = text(345, 155),
        raw = (prefix ? prefix + '/' : '') + text(0, 100),
        type = text(156, 1);
      if (!['', '0', '5'].includes(type) || text(157, 100))
        throw new Error('Links and special files are unsupported');
      const name = raw === './' ? '.' : raw.replace(/^\.\//, '').replace(/\/$/, '');
      if (
        name !== '.' &&
        (!name ||
          name.startsWith('/') ||
          name.includes('\\') ||
          name.includes(':') ||
          [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
          name.split('/').some((p) => p === '' || p === '.' || p === '..'))
      )
        throw new Error('Unsafe archive path');
      if (seen.has(name)) throw new Error('Duplicate archive path');
      seen.add(name);
      if (name.split('/').some((p) => ['PG_VERSION', 'ibdata1', 'WiredTiger'].includes(p)))
        throw new Error('Database data requires a logical backup connector');
      if ((octal(100, 8) & 0o7000) !== 0) throw new Error('Special permission bits refused');
      const length = octal(124, 12);
      if (type === '5' && length !== 0) throw new Error('Invalid directory');
      const hash = createHash('sha256');
      let remaining = length,
        position = offset;
      while (remaining) {
        signal.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(1048576, remaining)),
          read = (await f.read(buffer, 0, buffer.length, position)).bytesRead;
        if (!read) throw new Error('Truncated file');
        hash.update(buffer.subarray(0, read));
        remaining -= read;
        position += read;
      }
      records.push({
        name,
        mode: octal(100, 8),
        uid: octal(108, 8),
        gid: octal(116, 8),
        sha256: hash.digest('hex'),
        length,
        type: type === '5' ? 'directory' : 'file',
      });
      offset += Math.ceil(length / 512) * 512;
      if (offset > size) throw new Error('Truncated archive');
      if (++entries > 1000000) throw new Error('Archive entry limit');
    }
    if (!ended) throw new Error('Archive terminator missing');
    records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      entries,
      rootKind: records.some((r) => r.name === '.' && r.type === 'directory')
        ? ('directory' as const)
        : records.length === 1 && records[0]?.name === 'data' && records[0].type === 'file'
          ? ('file' as const)
          : ('other' as const),
      fingerprint: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    };
  } finally {
    await f.close();
  }
}
export async function validateDataTar(path: string, signal: AbortSignal) {
  return (await inspectDataTar(path, signal)).entries;
}
