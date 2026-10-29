import { lstat, realpath, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, resolve, parse } from 'node:path';
export async function trustedDirectory(
  directory: string,
  options: { create?: boolean; private?: boolean } = {},
) {
  if (!isAbsolute(directory)) throw new Error('Absolute local policy path required');
  const absolute = resolve(directory),
    root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (e) {
      if (!options.create || !(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT'))
        throw e;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Directory symlink refused');
  }
  const final = await lstat(absolute);
  if (
    process.platform !== 'win32' &&
    ((final.mode & (options.private ? 0o077 : 0o022)) !== 0 ||
      ![0, process.getuid?.()].includes(final.uid))
  )
    throw new Error('Unsafe directory ownership or permissions');
  return realpath(absolute);
}
export async function safePath(root: string, path: string): Promise<string> {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('Unsafe path');
  const canonical = await trustedDirectory(root);
  let current = canonical;
  for (const part of path.split('/')) {
    current = join(current, part);
    const s = await lstat(current);
    if (s.isSymbolicLink()) throw new Error('Symlink refused');
  }
  const actual = await realpath(current),
    r = relative(canonical, actual);
  if (r === '..' || r.startsWith('..' + sep) || isAbsolute(r)) throw new Error('Path outside root');
  return actual;
}
