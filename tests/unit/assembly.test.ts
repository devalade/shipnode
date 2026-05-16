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
    expect(config.zeroDowntime).toBe(true);
    expect(config.keepReleases).toBe(5);
    expect(config.healthCheck.enabled).toBe(true);
    expect(config.healthCheck.path).toBe('/health');
    expect(config.healthCheck.timeout).toBe(30);
    expect(config.healthCheck.retries).toBe(3);
    expect(config.healthCheck.startupDelay).toBe(3);
    expect(config.envFile).toBe('.env');
    expect(config.nodeVersion).toBe('lts');
    expect(config.backend?.port).toBe(3000);
  });

  it('preserves explicitly provided values', () => {
    const config = assembleConfig({
      app: 'frontend',
      ssh: { host: 'example.com', user: 'deploy', port: 2222 },
      remotePath: '/opt/app',
      zeroDowntime: false,
      keepReleases: 10,
      healthCheck: { enabled: true, path: '/api/health', timeout: 60, retries: 5, startupDelay: 10 },
      envFile: '.env.production',
      nodeVersion: '22',
      backend: { port: 8080 },
    });

    expect(config.app).toBe('frontend');
    expect(config.ssh.port).toBe(2222);
    expect(config.remotePath).toBe('/opt/app');
    expect(config.zeroDowntime).toBe(false);
    expect(config.keepReleases).toBe(10);
    expect(config.healthCheck.path).toBe('/api/health');
    expect(config.healthCheck.timeout).toBe(60);
    expect(config.envFile).toBe('.env.production');
    expect(config.nodeVersion).toBe('22');
    expect(config.backend?.port).toBe(8080);
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
