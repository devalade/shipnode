import { describe, it, expect } from 'vitest';
import { assembleConfig } from '../../src/config/assembly.js';
import { ConfigError } from '../../src/shared/errors.js';

describe('assembleConfig', () => {
  it('applies defaults to a minimal partial config', () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '192.168.1.1', user: 'deploy' },
      remotePath: '/var/www/app',
    });

    expect(config.app).toBe('backend');
    expect(config.ssh.host).toBe('192.168.1.1');
    expect(config.ssh.user).toBe('deploy');
    expect(config.ssh.port).toBe(22);
    expect(config.remotePath).toBe('/var/www/app');
    expect(config.keepReleases).toBe(5);
    expect(config.healthCheck.enabled).toBe(true);
    expect(config.healthCheck.path).toBe('/health');
    expect(config.healthCheck.timeout).toBe(30);
    expect(config.healthCheck.retries).toBe(3);
    expect(config.healthCheck.startupDelay).toBe(3);
    expect(config.envFile).toBe('.env');
    expect(config.nodeVersion).toBe('lts');
    // No pm2 declared → no apps at all.
    expect(config.pm2).toBeUndefined();
  });

  it('preserves explicitly provided values', () => {
    const config = assembleConfig({
      app: 'frontend',
      ssh: { host: 'example.com', user: 'deploy', port: 2222 },
      remotePath: '/opt/app',
      keepReleases: 10,
      healthCheck: { enabled: true, path: '/api/health', timeout: 60, retries: 5, startupDelay: 10 },
      envFile: '.env.production',
      nodeVersion: '22',
    });

    expect(config.app).toBe('frontend');
    expect(config.ssh.port).toBe(2222);
    expect(config.remotePath).toBe('/opt/app');
    expect(config.keepReleases).toBe(10);
    expect(config.healthCheck.path).toBe('/api/health');
    expect(config.healthCheck.timeout).toBe(60);
    expect(config.envFile).toBe('.env.production');
    expect(config.nodeVersion).toBe('22');
  });

  it('folds the legacy pm2/backend input shape onto pm2.apps[0]', () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      pm2: { name: 'api', instances: 2, maxMemory: '1G' },
      backend: { port: 8080 },
    });
    expect(config.pm2?.apps).toHaveLength(1);
    expect(config.pm2?.apps[0]).toMatchObject({ name: 'api', port: 8080, instances: 2, maxMemory: '1G' });
  });

  it('accepts the new pm2.apps input shape directly', () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'api', port: 3000 }, { name: 'worker', command: 'node dist/worker.js' }] },
    });
    expect(config.pm2?.apps).toHaveLength(2);
    expect(config.pm2?.apps[0].name).toBe('api');
    expect(config.pm2?.apps[1].name).toBe('worker');
  });

  it('rejects two pm2.apps entries with ports', () => {
    expect(() => assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'a', port: 3000 }, { name: 'b', port: 3001 }] },
    })).toThrow();
  });

  it('rejects domain without a web app', () => {
    expect(() => assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      domain: 'api.example.com',
      pm2: { apps: [{ name: 'worker', command: 'node dist/worker.js' }] },
    })).toThrow();
  });

  it('preserves aliases through assembly', () => {
    const config = assembleConfig({
      app: 'backend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      aliases: { migrate: 'pnpm db:apply', seed: 'pnpm db:seed' },
    });
    expect(config.aliases).toEqual({ migrate: 'pnpm db:apply', seed: 'pnpm db:seed' });
  });

  it('rejects pm2 on frontend apps', () => {
    expect(() => assembleConfig({
      app: 'frontend',
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
      pm2: { apps: [{ name: 'api', port: 3000 }] },
    })).toThrow();
  });

  it('throws on invalid SSH host', () => {
    expect(() => {
      assembleConfig({
        app: 'backend',
        ssh: { host: 'invalid host!', user: 'deploy' },
        remotePath: '/var/www/app',
      });
    }).toThrow();
  });

  it('throws on missing required fields', () => {
    expect(() => {
      assembleConfig({});
    }).toThrow();
  });

  it('defaults app to backend when not specified', () => {
    const config = assembleConfig({
      ssh: { host: '1.2.3.4', user: 'deploy' },
      remotePath: '/var/www/app',
    });

    expect(config.app).toBe('backend');
  });
});
