import { test, expect } from 'vitest';
import { composeContainerIdentity } from '../../packages/connectors/src/compose-runtime.js';
import type { ContainerInspect } from '../../packages/connectors/src/docker-client.js';
import { dockerMountsOverlap } from '../../packages/connectors/src/docker-client.js';

test('Compose fencing ignores Docker mount enumeration order, but retains read-only and source identity', () => {
  const container = {
    Id: 'a'.repeat(64),
    Name: '/worker',
    Image: 'sha256:' + 'b'.repeat(64),
    Config: { Env: ['PRIVATE=not-for-logs'] },
    HostConfig: {},
    Mounts: [
      { Type: 'volume', Name: 'files', Source: '/files', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/approved/metrics', Destination: '/metrics', RW: false },
    ],
    NetworkSettings: { Networks: {} },
  } as unknown as ContainerInspect;
  const reordered = structuredClone(container);
  reordered.Mounts.reverse();
  expect(composeContainerIdentity(reordered)).toBe(composeContainerIdentity(container));
  reordered.Mounts[0]!.RW = true;
  expect(composeContainerIdentity(reordered)).not.toBe(composeContainerIdentity(container));
});
test('ownership detects a third-party host bind into a named volume, including nested paths', () => {
  const volume = {
    Type: 'volume',
    Name: 'attachments',
    Source: '/docker/volumes/attachments/_data',
    Destination: '/files',
    RW: true,
  };
  expect(
    dockerMountsOverlap(volume, {
      Type: 'bind',
      Source: '/docker/volumes/attachments/_data/inbox',
      Destination: '/other',
      RW: false,
    }),
  ).toBe(true);
  expect(
    dockerMountsOverlap(volume, {
      Type: 'bind',
      Source: '/docker/volumes/attachments-two/_data',
      Destination: '/other',
      RW: true,
    }),
  ).toBe(false);
});
