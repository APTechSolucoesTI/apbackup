import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerClient } from '../../packages/connectors/src/docker-client.js';
const containerId = 'a'.repeat(64);
function inspectFixture() {
  return {
    Id: containerId,
    Name: '/application',
    Image: 'sha256:' + 'b'.repeat(64),
    Config: {
      Image: 'application:fixture',
      Env: [],
      Cmd: ['node', 'app.js'],
      Entrypoint: null,
      WorkingDir: '',
      User: '',
      Labels: {},
      Tty: false,
      OpenStdin: false,
    },
    HostConfig: {
      Privileged: false,
      NetworkMode: 'default',
      PidMode: '',
      IpcMode: 'private',
      CapAdd: null,
      Devices: [],
      CapDrop: null,
      ReadonlyRootfs: false,
      Dns: [],
      ExtraHosts: [],
      VolumesFrom: null,
      SecurityOpt: null,
      Memory: 0,
      MemorySwap: 0,
      NanoCpus: 0,
      CpuShares: 0,
      CpuQuota: 0,
      CpuPeriod: 0,
      CpusetCpus: '',
      CpusetMems: '',
      Ulimits: null,
      GroupAdd: null,
      Binds: null,
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      PidsLimit: null as number | null,
      MemoryReservation: 0,
    },
    State: { Running: true, Status: 'running' },
    Mounts: [
      {
        Type: 'volume',
        Name: 'attachments',
        Source: '/var/lib/docker/volumes/attachments/_data',
        Destination: '/data',
        RW: true,
      },
    ],
    NetworkSettings: {
      Ports: {},
      Networks: { bridge: { Aliases: null, IPAMConfig: null } } as Record<string, unknown>,
    },
  };
}
type Scenario = {
  diffStatus?: number;
  info?: unknown;
  infoStatus?: number;
  services?: unknown;
  serviceStatus?: number;
  disconnectServices?: boolean;
  mutate?: (v: ReturnType<typeof inspectFixture>) => void;
};
async function fixture(
  scenario: Scenario,
  check: (client: ReturnType<typeof dockerClient>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'docker-eligibility-')),
    socketPath = join(root, 'daemon.sock'),
    inspect = inspectFixture();
  scenario.mutate?.(inspect);
  const server = createServer((req, res) => {
    const path = req.url?.replace('/v1.47', '');
    let body: unknown;
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (path === '/containers/json?all=1') body = [{ Id: containerId, Labels: {} }];
    else if (path === `/containers/${containerId}/json`) body = inspect;
    else if (path === `/containers/${containerId}/changes`) {
      res.statusCode = scenario.diffStatus ?? 200;
      body = null;
    } else if (path === '/volumes') body = { Volumes: [{ Name: 'attachments' }] };
    else if (path === '/info') {
      res.statusCode = scenario.infoStatus ?? 200;
      body = scenario.info ?? { Swarm: { LocalNodeState: 'inactive', ControlAvailable: false } };
    } else if (path === '/services') {
      if (scenario.disconnectServices) {
        req.socket.destroy();
        return;
      }
      res.statusCode = scenario.serviceStatus ?? 503;
      body = scenario.services ?? { message: 'not a manager' };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    await check(
      dockerClient(
        {
          socketPath,
          helperImage: 'sha256:' + 'c'.repeat(64),
          repositoryRoot: root,
          directories: {},
        },
        AbortSignal.timeout(5000),
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
const active = { Swarm: { LocalNodeState: 'active', ControlAvailable: true } };
test('inventory does not scan the writable layer of an already unsupported runtime', async () => {
  await fixture(
    {
      diffStatus: 503,
      mutate: (c) => {
        c.HostConfig.NetworkMode = 'host';
      },
    },
    async (client) => {
      assert.match(
        (await client.discover()).containers[0]!.blockedReason ?? '',
        /Runtime especial/,
      );
    },
  );
});
for (const [label, scenario] of [
  ['service listing denied', { info: active, serviceStatus: 403 }],
  ['service listing malformed', { info: active, serviceStatus: 200, services: { items: [] } }],
  [
    'service ownership omitted',
    {
      info: active,
      serviceStatus: 200,
      services: [{ ID: 'service', Spec: { Name: 'hidden-owner' } }],
    },
  ],
  ['service listing daemon failure', { info: active, serviceStatus: 500 }],
  ['service transport unknown', { info: active, disconnectServices: true }],
  [
    'Swarm worker is not a manager',
    { info: { Swarm: { LocalNodeState: 'active', ControlAvailable: false } }, serviceStatus: 503 },
  ],
  [
    'Swarm state pending',
    { info: { Swarm: { LocalNodeState: 'pending', ControlAvailable: false } } },
  ],
  ['daemon mode denied', { infoStatus: 403 }],
  ['daemon mode malformed', { info: {} }],
] satisfies [string, Scenario][]) {
  test(`unknown ownership blocks simple container: ${label}`, async () => {
    await fixture(scenario, async (client) => {
      const selected = (await client.discover()).containers[0]!;
      assert.notEqual(
        selected.blockedReason,
        null,
        'Unknown Swarm ownership cannot become an empty owner set',
      );
    });
  });
}
test('positive non-Swarm daemon remains eligible despite unavailable services endpoint', async () => {
  await fixture({}, async (client) =>
    assert.equal((await client.discover()).containers[0]!.blockedReason, null),
  );
});
test('manager with complete empty service inventory remains eligible', async () => {
  await fixture({ info: active, serviceStatus: 200, services: [] }, async (client) =>
    assert.equal((await client.discover()).containers[0]!.blockedReason, null),
  );
});
test('service without a local task still blocks a shared named volume', async () => {
  await fixture(
    {
      info: active,
      serviceStatus: 200,
      services: [
        {
          ID: 'remote-service',
          Spec: {
            Name: 'remote-owner',
            TaskTemplate: {
              ContainerSpec: {
                Mounts: [{ Type: 'volume', Source: 'attachments', Target: '/data' }],
              },
            },
          },
        },
      ],
    },
    async (client) =>
      assert.match((await client.discover()).containers[0]!.blockedReason!, /compartilhado/),
  );
});
for (const [label, mutate] of [
  [
    'PID limit',
    (v: ReturnType<typeof inspectFixture>) => {
      v.HostConfig.PidsLimit = 128;
    },
  ],
  [
    'memory reservation',
    (v: ReturnType<typeof inspectFixture>) => {
      v.HostConfig.MemoryReservation = 67108864;
    },
  ],
  [
    'extra network attachment',
    (v: ReturnType<typeof inspectFixture>) => {
      v.NetworkSettings.Networks['private-application-network'] = { Aliases: ['application'] };
    },
  ],
] satisfies [string, NonNullable<Scenario['mutate']>][]) {
  test(`unsupported runtime blocked before capture/cutover: ${label}`, async () => {
    await fixture({ mutate }, async (client) => {
      assert.notEqual(
        (await client.discover()).containers[0]!.blockedReason,
        null,
        'Unsupported runtime semantics cannot be discarded',
      );
    });
  });
}
test('bounded restart policy retains the complete supported semantics', async () => {
  await fixture(
    {
      mutate: (v) => {
        v.HostConfig.RestartPolicy = { Name: 'on-failure', MaximumRetryCount: 3 };
      },
    },
    async (client) => {
      const value = await client.inspect(containerId);
      assert.deepEqual(value.HostConfig.RestartPolicy, {
        Name: 'on-failure',
        MaximumRetryCount: 3,
      });
      assert.equal((await client.discover()).containers[0]!.blockedReason, null);
    },
  );
});
