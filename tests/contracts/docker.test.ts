import { expect, test } from 'vitest';
import * as contracts from '../../packages/contracts/src/index.js';
import { randomUUID } from 'node:crypto';
test('Docker operations select an exact catalog identity and never accept shell, host paths or replacement without confirmation', () => {
  expect('dockerSelectionSchema' in contracts).toBe(true);
  if (!('dockerSelectionSchema' in contracts)) return;
  const schema = contracts.dockerSelectionSchema as {
    safeParse: (v: unknown) => { success: boolean };
  };
  expect(
    schema.safeParse({ serverId: randomUUID(), kind: 'volume', identity: 'emails' }).success,
  ).toBe(true);
  expect(
    schema.safeParse({ serverId: randomUUID(), kind: 'directory', identity: '../etc' }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      serverId: randomUUID(),
      kind: 'volume',
      identity: 'emails',
      args: ['--privileged'],
    }).success,
  ).toBe(false);
});
