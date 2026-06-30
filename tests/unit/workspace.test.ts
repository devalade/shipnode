import { describe, it, expect } from 'vitest';
import { getActiveApp } from '../../src/domain/workspace.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

function makeConfig(overrides?: Partial<ShipnodeConfig>): ShipnodeConfig {
  return {
    ssh: { host: 'x', user: 'x', port: 22 },
    remotePath: '/remote',
    nodeVersion: '22',
    apps: [
      { name: 'api', appType: 'backend', envFile: '.env', healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 }, keepReleases: 5 },
      { name: 'web', appType: 'frontend', envFile: '.env.web', healthCheck: { enabled: false, path: '/health', timeout: 30, retries: 3, startupDelay: 3 }, keepReleases: 3 },
    ],
    ...overrides,
  } as ShipnodeConfig;
}

describe('getActiveApp', () => {
  it('returns apps[0] when no name is given', () => {
    const config = makeConfig();
    const app = getActiveApp(config);
    expect(app.name).toBe('api');
    expect(app.appType).toBe('backend');
  });

  it('returns the named app when name matches', () => {
    const config = makeConfig();
    const app = getActiveApp(config, 'web');
    expect(app.name).toBe('web');
    expect(app.appType).toBe('frontend');
  });

  it('throws when name does not match any app', () => {
    const config = makeConfig();
    expect(() => getActiveApp(config, 'nonexistent')).toThrow('No app named "nonexistent"');
  });
});
