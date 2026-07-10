import { describe, expect, it, vi } from 'vitest';
import { cmdDeploy, printDryRun } from '../../src/cli/commands/deploy.js';
import type { ShipnodeConfig } from '../../src/shared/types.js';

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/cli/ui.js', () => ({
  ui: {
    banner: vi.fn(),
    error: vi.fn(),
    note: vi.fn(),
  },
}));

const { ui } = await import('../../src/cli/ui.js');
const { loadConfig } = await import('../../src/config/loader.js');

describe('deploy command dry run', () => {
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

  it('shows the resolved single server target instead of default', () => {
    printDryRun(config, false);

    expect(vi.mocked(ui.note).mock.calls[0]?.[0]).toContain('Server         app');
  });

  it('prints a clean error for an unknown dry-run app', async () => {
    vi.mocked(loadConfig).mockResolvedValue(config);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await cmdDeploy('/tmp/project', { dryRun: true, app: 'missing' });

    expect(ui.error).toHaveBeenCalledWith('No app named "missing" in this workspace');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
