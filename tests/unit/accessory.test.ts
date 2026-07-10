import { describe, expect, it } from 'vitest';
import { AccessoryService, buildAccessoryRunCommand } from '../../src/services/accessory.service.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

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

  it('adds hardened docker options and prepares named volumes and networks', () => {
    const cmd = buildAccessoryRunCommand('redis', {
      image: 'redis:7',
      directories: ['redis-data:/data', '/srv/redis:/srv/redis'],
      networks: ['shipnode-private'],
      command: ['redis-server', '--appendonly', 'yes'],
      labels: { 'com.shipnode.role': 'cache' },
      restart: 'always',
      resources: { memory: '512m', memoryReservation: '256m', cpus: '0.5' },
      stopTimeout: 20,
    });

    expect(cmd).toContain("sudo docker volume inspect 'redis-data'");
    expect(cmd).toContain("sudo docker volume create 'redis-data'");
    expect(cmd).not.toContain("sudo docker volume inspect '/srv/redis'");
    expect(cmd).toContain("sudo docker network inspect 'shipnode-private'");
    expect(cmd).toContain("sudo docker network create 'shipnode-private'");
    expect(cmd).toContain("--restart 'always'");
    expect(cmd).toContain("--network 'shipnode-private'");
    expect(cmd).toContain("--label 'com.shipnode.role=cache'");
    expect(cmd).toContain("--memory '512m'");
    expect(cmd).toContain("--memory-reservation '256m'");
    expect(cmd).toContain("--cpus '0.5'");
    expect(cmd).toContain('--stop-timeout 20');
    expect(cmd).toContain("'redis:7' 'redis-server' '--appendonly' 'yes'");
  });

  it('fails with a clear message when registry password env is missing remotely', () => {
    const cmd = buildAccessoryRunCommand('redis', {
      image: 'ghcr.io/acme/redis:7',
    }, {
      server: 'ghcr.io',
      username: 'acme',
      passwordEnv: 'REGISTRY_TOKEN',
    });

    expect(cmd).toContain('Registry password env REGISTRY_TOKEN is not set on the remote host');
  });

  it('runs accessory health checks and lifecycle commands through docker', async () => {
    const executor = new FakeRemoteExecutor();
    const config: ShipnodeConfig = {
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      servers: { default: { host: '1.2.3.4', user: 'deploy', port: 22 } },
      remotePath: '/var/www/app',
      nodeVersion: 'lts',
      apps: [{
        name: 'api',
        appType: 'backend',
        healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
      }],
      accessories: {
        redis: {
          image: 'redis:7',
          healthCheck: { command: 'redis-cli ping' },
        },
      },
    };

    const service = new AccessoryService(executor, config);
    await service.ensureAll();
    await service.restart('redis');
    await service.stop('redis');
    const health = await service.health('redis');

    const commands = executor.getHistory().map((entry) => entry.command);
    expect(health.isOk()).toBe(true);
    expect(commands.some((cmd) => cmd.includes('sudo docker exec') && cmd.includes('redis-cli ping'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("sudo docker restart 'shipnode-redis'"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("sudo docker stop 'shipnode-redis'"))).toBe(true);
  });

  it('returns a Result error when a health check is not configured', async () => {
    const executor = new FakeRemoteExecutor();
    const config: ShipnodeConfig = {
      ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
      servers: { default: { host: '1.2.3.4', user: 'deploy', port: 22 } },
      remotePath: '/var/www/app',
      nodeVersion: 'lts',
      apps: [],
      accessories: { redis: { image: 'redis:7' } },
    };

    const result = await new AccessoryService(executor, config).health('redis');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe('MissingAccessoryHealthCheckError');
  });
});
