import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import { configForServer } from '../../src/domain/servers.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

const api = vi.hoisted(() => ({
  dns: [] as Array<{ type: string; name: string; content: string }>,
  createdTunnels: [] as string[],
}));

vi.mock('../../src/infrastructure/cloudflare/api.js', () => ({
  CloudflareApi: class {
    async getAccountId() {
      return 'account-1';
    }
    async getZoneId() {
      return 'zone-1';
    }
    async findTunnel() {
      return null;
    }
    async createTunnel(_accountId: string, name: string) {
      api.createdTunnels.push(name);
      return { id: `id-${name}`, name };
    }
    async upsertDnsRecord(_zoneId: string, record: { type: string; name: string; content: string }) {
      api.dns.push(record);
      return record;
    }
    async getCloudflareIps() {
      return { ipv4_cidrs: [], ipv6_cidrs: [] };
    }
    async verifyToken() {}
  },
}));

const { CloudflareOrchestrator } = await import('../../src/services/cloudflare.orchestrator.js');

const baseApp = {
  appType: 'backend' as const,
  healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
  envFile: '.env',
  keepReleases: 5,
  zeroDowntime: false,
  blueGreenRetention: 'rollback' as const,
};

const workspace: ShipnodeConfig = {
  ssh: { host: 'edge.example', user: 'deploy', port: 22 },
  servers: {
    edge: { host: 'edge.example', user: 'deploy', port: 22 },
    other: { host: 'other.example', user: 'deploy', port: 22 },
  },
  remotePath: '/var/www/app',
  nodeVersion: 'lts',
  cloudflare: { zone: 'example.com', sshHostname: 'ssh.example.com' },
  apps: [
    { ...baseApp, name: 'api', on: 'edge', domain: 'api.example.com', pm2: { apps: [{ name: 'api', port: 3000 }] } },
    { ...baseApp, name: 'web', on: 'other', domain: 'web.example.com', pm2: { apps: [{ name: 'web', port: 4000 }] } },
  ],
} as ShipnodeConfig;

beforeEach(() => {
  api.dns.length = 0;
  api.createdTunnels.length = 0;
});

describe('CloudflareOrchestrator DNS scoping', () => {
  it('only creates DNS records for apps on the connected host', async () => {
    // Handed the whole workspace, every server's init would repoint *every*
    // domain at its own tunnel — the last one to run wins and the other
    // server's apps start 404ing through the tunnel catch-all.
    const executor = new FakeRemoteExecutor();
    const scoped = configForServer(workspace, 'edge');

    await new CloudflareOrchestrator(executor, scoped, 'token').init();

    expect(api.dns.map((record) => record.name)).toEqual(['api.example.com', 'ssh.example.com']);
  });

  it('points each host at its own tunnel', async () => {
    const edge = new FakeRemoteExecutor();
    await new CloudflareOrchestrator(edge, configForServer(workspace, 'edge'), 'token').init();
    const edgeRecord = api.dns.find((record) => record.name === 'api.example.com');

    api.dns.length = 0;
    const other = new FakeRemoteExecutor();
    await new CloudflareOrchestrator(other, configForServer(workspace, 'other'), 'token', {
      manageSshHostname: false,
    }).init();
    const otherRecord = api.dns.find((record) => record.name === 'web.example.com');

    expect(api.createdTunnels).toEqual(['shipnode-edge-example', 'shipnode-other-example']);
    expect(edgeRecord?.content).not.toBe(otherRecord?.content);
  });

  it('gives the ssh hostname to a single tunnel', async () => {
    // sshHostname is one workspace-level name; two tunnels claiming it means
    // whichever ran last silently steals SSH access.
    const executor = new FakeRemoteExecutor();

    await new CloudflareOrchestrator(executor, configForServer(workspace, 'other'), 'token', {
      manageSshHostname: false,
    }).init();

    expect(api.dns.map((record) => record.name)).toEqual(['web.example.com']);
  });
});
