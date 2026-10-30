import { request, type IncomingMessage } from 'node:http';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import type { PostgresQueryClient } from './postgresql-schemas.js';

/** Docker's non-TTY framing is binary. Neither archive data nor SQL diagnostics are logged. */
export async function consumeDockerFrames(
  stream: AsyncIterable<Uint8Array>,
  stdout: (data: Buffer) => Promise<void>,
) {
  let pending = Buffer.alloc(0),
    diagnostics = 0;
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (pending.length >= 8) {
      const length = pending.readUInt32BE(4),
        channel = pending[0];
      if (length > 16777216 || ![1, 2].includes(channel!) || pending[1] || pending[2] || pending[3])
        throw new Error('Invalid Docker frame');
      if (pending.length < length + 8) break;
      const content = pending.subarray(8, length + 8);
      if (channel === 1) await stdout(content);
      else diagnostics += length;
      if (diagnostics > 65536) throw new Error('Docker diagnostic limit');
      pending = pending.subarray(length + 8);
    }
  }
  if (pending.length) throw new Error('Incomplete Docker stream');
}

export interface PostgresDockerPolicy {
  dockerSocketPath?: string | undefined;
  allowedDockerContainers?: readonly string[] | undefined;
}

export function dockerPostgresTransport(
  config: { container?: string | undefined; username: string },
  policy: PostgresDockerPolicy,
  operationId: string,
  signal: AbortSignal,
  expiresAt: number,
) {
  const container = config.container;
  if (!container || !policy.allowedDockerContainers?.includes(container))
    throw new Error('Docker PostgreSQL container is not approved');
  if (process.platform !== 'linux' || !policy.dockerSocketPath?.startsWith('/'))
    throw new Error('Trusted Linux Docker socket required');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container) ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/.test(config.username) ||
    !/^[a-f0-9-]{36}$/.test(operationId)
  )
    throw new Error('Invalid Docker PostgreSQL scope');
  const application = `apbackup:${operationId}`;
  const encode = encodeURIComponent;
  let containerId: string | undefined;
  function active() {
    signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('PostgreSQL deadline elapsed');
  }
  async function metadata(
    method: string,
    path: string,
    body?: unknown,
    scopedSignal = signal,
  ): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          socketPath: policy.dockerSocketPath!,
          path: `/v1.47${path}`,
          method,
          signal: scopedSignal,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {},
        },
        resolve,
      );
      req.on('error', reject);
      req.end(payload);
    });
    if (!response.statusCode || response.statusCode < 200 || response.statusCode > 299) {
      response.resume();
      throw new Error('Docker PostgreSQL request refused');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const b = Buffer.from(chunk as Uint8Array);
      size += b.length;
      if (size > 65536) {
        response.destroy();
        throw new Error('Docker metadata limit');
      }
      chunks.push(b);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  }
  async function bind() {
    active();
    if (!containerId) {
      const found = z
        .object({
          Id: z.string().regex(/^[a-f0-9]{64}$/),
          Name: z.string(),
          State: z.object({ Running: z.literal(true) }),
        })
        .parse(await metadata('GET', `/containers/${encode(container!)}/json`));
      if (found.Name !== `/${container}`) throw new Error('Docker container identity mismatch');
      containerId = found.Id;
    }
    return containerId;
  }
  async function start(execId: string, input: string | undefined, scopedSignal: AbortSignal) {
    return new Promise<Duplex>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
      const req = request({
        socketPath: policy.dockerSocketPath!,
        method: 'POST',
        path: `/v1.47/exec/${encode(execId)}/start`,
        signal: scopedSignal,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'tcp',
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      });
      req.on('error', reject);
      req.on('response', (res) => {
        res.resume();
        reject(new Error('Docker exec did not establish a stream'));
      });
      req.on('upgrade', (res, socket, head) => {
        if (res.statusCode !== 101) {
          socket.destroy();
          reject(new Error('Docker exec stream refused'));
          return;
        }
        if (head.length) socket.unshift(head);
        const abort = () => socket.destroy(new Error('PostgreSQL command cancelled'));
        scopedSignal.addEventListener('abort', abort, { once: true });
        socket.once('close', () => scopedSignal.removeEventListener('abort', abort));
        if (input) {
          const source = createReadStream(input, { signal: scopedSignal });
          source.on('error', (e) => socket.destroy(e));
          source.pipe(socket);
          socket.once('close', () => source.destroy());
        }
        resolve(socket);
      });
      req.end(payload);
    });
  }
  async function execute(
    tool: 'psql' | 'pg_dump' | 'pg_restore',
    args: string[],
    options: { database: string; artifact?: string | undefined; input?: string | undefined },
    scopedSignal = signal,
  ) {
    if (scopedSignal === signal) active();
    const identity = scopedSignal === signal ? await bind() : containerId;
    if (!identity) throw new Error('Docker container unavailable');
    const remaining =
      scopedSignal === signal ? Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)) : 5;
    const exec = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(
      await metadata(
        'POST',
        `/containers/${encode(identity)}/exec`,
        {
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: !!options.input,
          Tty: false,
          Cmd: ['timeout', '-s', 'TERM', '-k', '5', String(remaining), tool, ...args],
          Env: [
            'PGHOST=/var/run/postgresql',
            `PGUSER=${config.username}`,
            `PGDATABASE=${options.database}`,
            `PGAPPNAME=${scopedSignal === signal ? application : 'apbackup-cancel'}`,
            'PGCONNECT_TIMEOUT=10',
            `PGOPTIONS=-c statement_timeout=${Math.min(remaining * 1000, 2147483647)} -c standard_conforming_strings=on`,
            'PGSSLMODE=disable',
            'PGPASSWORD=',
          ],
        },
        scopedSignal,
      ),
    );
    const file = options.artifact ? await open(options.artifact, 'wx', 0o600) : undefined,
      chunks: Buffer[] = [];
    let socket: Duplex | undefined;
    let size = 0;
    try {
      socket = await start(exec.Id, options.input, scopedSignal);
      await consumeDockerFrames(socket, async (chunk) => {
        size += chunk.length;
        if (size > (file ? 100 * 1024 ** 3 : 8 * 1024 ** 2))
          throw new Error('PostgreSQL output limit');
        if (file) await file.writeFile(chunk);
        else chunks.push(Buffer.from(chunk));
      });
      const result = z
        .object({ Running: z.literal(false), ExitCode: z.literal(0) })
        .safeParse(await metadata('GET', `/exec/${encode(exec.Id)}/json`, undefined, scopedSignal));
      if (!result.success) throw new Error('Docker PostgreSQL tool failed');
      await file?.sync();
      if (scopedSignal === signal) active();
      return Buffer.concat(chunks).toString();
    } catch (error) {
      if (scopedSignal === signal) cancel();
      throw error;
    } finally {
      socket?.destroy();
      await file?.close();
    }
  }
  // Docker cannot signal an exec process. The timeout fences the process itself;
  // cancellation also terminates only this command's tagged PostgreSQL sessions.
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    if (!containerId || cancellation) return;
    cancellation = execute(
      'psql',
      [
        '-X',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `select pg_terminate_backend(pid) from pg_stat_activity where application_name='${application}' and pid<>pg_backend_pid()`,
      ],
      { database: 'postgres' },
      AbortSignal.timeout(7000),
    ).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const client = (
    database: string,
  ): PostgresQueryClient & { connect(): Promise<void>; end(): Promise<void> } => ({
    connect: async () => {
      await bind();
    },
    end: async () => {},
    async query<T extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
      const literal = (v: unknown): string => {
        if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
        if (Array.isArray(v) && v.every((e) => typeof e === 'string'))
          return `ARRAY[${v.map(literal).join(',')}]::text[]`;
        throw new Error('Unsupported PostgreSQL parameter');
      };
      const statement = sql.replace(/\$(\d+)/g, (_match, n: string) =>
        literal(parameters?.[Number(n) - 1]),
      );
      const select = /^\s*select\b/i.test(statement);
      const output = await execute(
        'psql',
        [
          '-X',
          '-q',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          select
            ? `select coalesce(json_agg(apbackup_row),'[]'::json) from (${statement}) apbackup_row`
            : statement,
        ],
        { database },
      );
      const rows = select
        ? (z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(output)) as T[])
        : [];
      return { rows, rowCount: rows.length };
    },
  });
  return {
    execute,
    client,
    async close() {
      signal.removeEventListener('abort', cancel);
      await cancellation;
    },
  };
}
