import { describe, expect, it, vi } from 'vitest';
import { printDryRun } from '../../src/cli/commands/deploy.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

vi.mock('../../src/cli/ui.js', () => ({
  ui: {
    banner: vi.fn(),
    note: vi.fn(),
  },
}));

const { ui } = await import('../../src/cli/ui.js');

describe('deploy command dry run', () => {
  it('shows the resolved single server target instead of default', () => {
    const config: ShipnodeConfig = {
      ssh: { host: '1.1.1.1', user: 'deploy', port: 22 },
      servers: {
        app: { host: '1.1.1.1', user: 'deploy', port: 22 },
      },
      remotePath: '/var/www/app',
      nodeVersion: 'lts',
      apps: [{
        name: 'api',
        appType: 'backend',
        pm2: { apps: [{ name: 'api', port: 3000 }] },
        healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
        envFile: '.env',
        keepReleases: 5,
      }],
    };

    printDryRun(config, false);

    expect(vi.mocked(ui.note).mock.calls[0]?.[0]).toContain('Server         app');
  });
});
