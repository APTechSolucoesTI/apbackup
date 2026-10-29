const sensitiveKey =
  /password|passwd|secret|token|authorization|cookie|credential|private.?key|backup.?codes|dsn/i;
function clean(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s&;"']+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, '[REDACTED]');
}
export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function walk(item: unknown): unknown {
    if (typeof item === 'string') return clean(item);
    if (!item || typeof item !== 'object') return typeof item === 'bigint' ? item.toString() : item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (item instanceof Error) return { name: item.name, message: clean(item.message) };
    if (Array.isArray(item)) return item.map(walk);
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : walk(entry),
      ]),
    );
  }
  return walk(value);
}
