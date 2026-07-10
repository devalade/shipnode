import { describe, it, expect } from 'vitest';
import { ShipnodeConfigSchema } from '../../src/config/schema.js';

describe('ShipnodeConfigSchema', () => {
  it('validates a minimal backend config', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '192.168.1.1', user: 'deploy' },
      remotePath: '/var/www/app',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ssh.port).toBe(22);
      expect(result.data.apps[0].keepReleases).toBe(5);
      expect(result.data.apps[0].healthCheck.enabled).toBe(true);
      expect(result.data.apps[0].envFile).toBe('.env');
      expect(result.data.nodeVersion).toBe('lts');
    }
  });

  it('validates a minimal frontend config', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'frontend',
      ssh: { host: 'example.com', user: 'deploy' },
      remotePath: '/var/www/frontend',
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid app type', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'invalid',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown accessory dependencies', () => {
    const result = ShipnodeConfigSchema.safeParse({
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      apps: [{ name: 'api', appType: 'backend', dependsOn: ['redis'] }],
      accessories: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("Unknown accessory dependency 'redis'"))).toBe(true);
    }
  });

  it('rejects invalid SSH host', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: 'not a valid host!!!', user: 'deploy' },
      remotePath: '/var/www/app',
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid SSH port', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy', port: 99999 },
      remotePath: '/var/www/app',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty remote path', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid PM2 name', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      pm2: { name: 'invalid name with spaces' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects domain with protocol', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      domain: 'https://example.com',
    });

    expect(result.success).toBe(false);
  });

  it('accepts valid domain without protocol', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      domain: 'api.example.com',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
    });

    expect(result.success).toBe(true);
  });

  it('applies health check defaults', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apps[0].healthCheck.path).toBe('/health');
      expect(result.data.apps[0].healthCheck.timeout).toBe(30);
      expect(result.data.apps[0].healthCheck.retries).toBe(3);
      expect(result.data.apps[0].healthCheck.startupDelay).toBe(3);
    }
  });

  it('accepts custom health check config', () => {
    const result = ShipnodeConfigSchema.safeParse({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      healthCheck: {
        enabled: true,
        path: '/api/health',
        timeout: 60,
        retries: 5,
        startupDelay: 10,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apps[0].healthCheck.path).toBe('/api/health');
      expect(result.data.apps[0].healthCheck.timeout).toBe(60);
      expect(result.data.apps[0].healthCheck.retries).toBe(5);
      expect(result.data.apps[0].healthCheck.startupDelay).toBe(10);
    }
  });

  it('safeParse returns false instead of throwing when ssh and servers are missing', () => {
    const result = ShipnodeConfigSchema.safeParse({
      remotePath: '/var/www/app',
    });

    expect(result.success).toBe(false);
  });
});
