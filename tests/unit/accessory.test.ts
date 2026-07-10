import { describe, expect, it } from 'vitest';
import { buildAccessoryRunCommand } from '../../src/services/accessory.service.js';

describe('buildAccessoryRunCommand', () => {
  it('logs into the registry, pulls, and runs the accessory container', () => {
    const cmd = buildAccessoryRunCommand('redis', {
      image: 'ghcr.io/acme/redis:7',
      port: '127.0.0.1:6379:6379',
      directories: ['redis-data:/data'],
      env: { REDIS_MODE: 'primary' },
    }, {
      server: 'ghcr.io',
      username: 'acme',
      passwordEnv: 'REGISTRY_TOKEN',
    });

    expect(cmd).toContain('sudo docker login');
    expect(cmd).toContain('$REGISTRY_TOKEN');
    expect(cmd).toContain("sudo docker pull 'ghcr.io/acme/redis:7'");
    expect(cmd).toContain('sudo docker run');
    expect(cmd).toContain("--name 'shipnode-redis'");
    expect(cmd).toContain("-p '127.0.0.1:6379:6379'");
    expect(cmd).toContain("-v 'redis-data:/data'");
    expect(cmd).toContain("-e 'REDIS_MODE=primary'");
  });
});
