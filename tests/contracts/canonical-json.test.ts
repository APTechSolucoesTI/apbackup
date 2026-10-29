import { expect, test } from 'vitest';
import { canonicalJson } from '@apbackup/contracts';
test('catalog hashes use stable recursive JSON ordering without changing array order', () => {
  expect(canonicalJson({ z: 1, a: { d: 2, b: [3, 'x'] } })).toBe('{"a":{"b":[3,"x"],"d":2},"z":1}');
  expect(() => canonicalJson({ bad: undefined })).toThrow();
});
