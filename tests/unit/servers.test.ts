import { describe, expect, it } from 'vitest';
import {
  configForApp,
  configForAppResult,
  configForServer,
  getServerTarget,
  getServerTargetResult,
  getServerTargets,
  resolveServerName,
} from '../../src/domain/servers.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

const config: ShipnodeConfig = {
  ssh: { host: '1.1.1.1', user: 'deploy', port: 22 },
  servers: {
    app: { host: '1.1.1.1', user: 'deploy', port: 22 },
    data: { host: '2.2.2.2', user: 'deploy', port: 22 },
  },
  remotePath: '/var/www/app',
  nodeVersion: 'lts',
  apps: [{
    name: 'api',
    appType: 'backend',
    on: 'app',
    healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
    envFile: '.env',
    keepReleases: 5,
  }],
  accessories: {
    redis: { image: 'redis:7', on: 'data' },
  },
};

describe('server target resolution', () => {
  it('resolves app configs to the app server only', () => {
    const appConfig = configForApp(config, 'api');

    expect(appConfig.ssh.host).toBe('1.1.1.1');
    expect(appConfig.apps.map((app) => app.name)).toEqual(['api']);
    expect(appConfig.accessories).toEqual({});
  });

  it('resolves a single named server when default is absent', () => {
    const oneServer = { ...config, servers: { app: config.servers.app } };

    expect(resolveServerName(oneServer)).toBe('app');
    expect(getServerTarget(oneServer).name).toBe('app');
  });

  it('gives managed services only to the server that hosts them', () => {
    // Without this scoping, `shipnode setup` installs Postgres on every server
    // in the workspace — same user, same database name, once per host.
    const withServices: ShipnodeConfig = {
      ...config,
      database: { type: 'postgres', on: 'data', host: 'localhost', port: 5432, name: 'app', user: 'app' },
      redis: { on: 'data', host: 'localhost', port: 6379 },
    };

    expect(configForServer(withServices, 'data').database).toBeDefined();
    expect(configForServer(withServices, 'data').redis).toBeDefined();
    expect(configForServer(withServices, 'app').database).toBeUndefined();
    expect(configForServer(withServices, 'app').redis).toBeUndefined();
  });

  it('keeps an untargeted service on the default server', () => {
    const withDefault: ShipnodeConfig = {
      ...config,
      servers: { default: config.servers.app, data: config.servers.data },
      apps: [{ ...config.apps[0], on: 'default' }],
      database: { type: 'postgres', host: 'localhost', port: 5432, name: 'app', user: 'app' },
    };

    expect(configForServer(withDefault, 'default').database).toBeDefined();
    expect(configForServer(withDefault, 'data').database).toBeUndefined();
  });

  it('keeps declaration order when nothing crosses servers', () => {
    expect(getServerTargets(config).map((target) => target.name)).toEqual(['app', 'data']);
  });

  it('visits an accessory host before the apps that depend on it', () => {
    // `app` is declared first, but api needs redis, which lives on `data`.
    // Deploying in declaration order health-checks api before redis exists.
    const withDependency: ShipnodeConfig = {
      ...config,
      apps: [{ ...config.apps[0], dependsOn: ['redis'] }],
    };

    expect(getServerTargets(withDependency).map((target) => target.name)).toEqual(['data', 'app']);
  });

  it('ignores same-server dependencies', () => {
    // The orchestrator already starts a server's own accessories before its
    // apps, so a local dependsOn must not perturb the order.
    const local: ShipnodeConfig = {
      ...config,
      accessories: { redis: { image: 'redis:7', on: 'app' } },
      apps: [{ ...config.apps[0], dependsOn: ['redis'] }],
    };

    expect(getServerTargets(local).map((target) => target.name)).toEqual(['app', 'data']);
  });

  it('falls back to declaration order for a dependency cycle', () => {
    const cyclic: ShipnodeConfig = {
      ...config,
      accessories: {
        redis: { image: 'redis:7', on: 'data' },
        cache: { image: 'memcached', on: 'app' },
      },
      apps: [
        { ...config.apps[0], on: 'app', dependsOn: ['redis'] },
        { ...config.apps[0], name: 'jobs', on: 'data', dependsOn: ['cache'] },
      ],
    };

    expect(getServerTargets(cyclic).map((target) => target.name)).toEqual(['app', 'data']);
  });

  it('returns Result errors for expected target lookup failures', () => {
    const missingApp = configForAppResult(config, 'missing');
    const missingTarget = getServerTargetResult(config, 'missing');

    expect(missingApp.isErr()).toBe(true);
    if (missingApp.isErr()) expect(missingApp.error._tag).toBe('UnknownAppError');
    expect(missingTarget.isErr()).toBe(true);
    if (missingTarget.isErr()) expect(missingTarget.error._tag).toBe('UnknownServerTargetError');
  });
});
