import { expect, test } from 'vitest';
import {
  dockerPostgresTransport,
  consumeDockerFrames,
} from '../../packages/connectors/src/postgresql-docker.js';

test('Docker PostgreSQL fails closed before touching a socket for unapproved containers', () => {
  expect(() =>
    dockerPostgresTransport(
      { container: 'neighbor', username: 'postgres' },
      { dockerSocketPath: '/var/run/docker.sock', allowedDockerContainers: ['supabase-db'] },
      crypto.randomUUID(),
      new AbortController().signal,
      Date.now() + 10000,
    ),
  ).toThrow(/approved/);
});

test('Docker binary frame decoder preserves fragmented binary stdout and bounds errors', async () => {
  const body = Buffer.from([0, 255, 10, 42, 128]),
    frame = Buffer.alloc(8 + body.length);
  frame[0] = 1;
  frame.writeUInt32BE(body.length, 4);
  body.copy(frame, 8);
  const chunks: Buffer[] = [];
  await consumeDockerFrames(
    (async function* () {
      for (const b of frame) yield Buffer.from([b]);
    })(),
    async (b) => {
      chunks.push(Buffer.from(b));
    },
  );
  expect(Buffer.concat(chunks)).toEqual(body);
  await expect(
    consumeDockerFrames(
      (async function* () {
        yield frame.subarray(0, 9);
      })(),
      async () => {},
    ),
  ).rejects.toThrow(/Incomplete/);
  const bad = Buffer.alloc(8);
  bad[0] = 1;
  bad.writeUInt32BE(16777217, 4);
  await expect(
    consumeDockerFrames(
      (async function* () {
        yield bad;
      })(),
      async () => {},
    ),
  ).rejects.toThrow(/frame/);
  const err = Buffer.alloc(8 + 65537);
  err[0] = 2;
  err.writeUInt32BE(65537, 4);
  await expect(
    consumeDockerFrames(
      (async function* () {
        yield err;
      })(),
      async () => {},
    ),
  ).rejects.toThrow(/diagnostic/);
});
