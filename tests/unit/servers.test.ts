import { describe, expect, it } from 'vitest';
import {
  configForApp,
  configForAppResult,
  getServerTarget,
  getServerTargetResult,
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

  it('returns Result errors for expected target lookup failures', () => {
    const missingApp = configForAppResult(config, 'missing');
    const missingTarget = getServerTargetResult(config, 'missing');

    expect(missingApp.isErr()).toBe(true);
    if (missingApp.isErr()) expect(missingApp.error._tag).toBe('UnknownAppError');
    expect(missingTarget.isErr()).toBe(true);
    if (missingTarget.isErr()) expect(missingTarget.error._tag).toBe('UnknownServerTargetError');
  });
});
