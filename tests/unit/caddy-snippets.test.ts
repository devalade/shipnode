import { describe, expect, it } from 'vitest';
import { CaddyService } from '../../src/services/caddy.service.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../src/shared/types.js';

const baseApp: ShipnodeApp = {
  name: 'api',
  appType: 'backend',
  domain: 'api.example.com',
  pm2: { apps: [{ name: 'api', port: 3000 }] },
  healthCheck: { enabled: true, path: '/health', timeout: 30, retries: 3, startupDelay: 3 },
  envFile: '.env',
  keepReleases: 5,
};

const config: ShipnodeConfig = {
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
  servers: { default: { host: '1.2.3.4', user: 'deploy', port: 22 } },
  remotePath: '/var/www/app',
  nodeVersion: 'lts',
  apps: [baseApp],
};

describe('CaddyService snippets', () => {
  it('keeps backend output unchanged without snippets', async () => {
    const executor = new FakeRemoteExecutor();
    const caddy = new CaddyService(executor, config);

    await caddy.configureBackend(baseApp);

    expect(executor.getLastCommand()?.command).toContain('$SUDO tee /etc/caddy/conf.d/api.caddy');
    expect(executor.getLastCommand()?.command).toContain(`api.example.com {
    reverse_proxy localhost:3000

    encode gzip

    log {
        output file /var/log/caddy/api.log
    }
}`);
  });

  it('reloads Caddy through sudo and propagates failures', async () => {
    const executor = new FakeRemoteExecutor().when(
      (command) => command.includes('systemctl reload caddy'),
      { stdout: '', stderr: 'reload failed', exitCode: 1 },
    );
    const caddy = new CaddyService(executor, config);

    await expect(caddy.reload()).rejects.toThrow('reload failed');

    expect(executor.getLastCommand()?.command).toContain('$SUDO systemctl reload caddy');
  });

  it('appends non-empty snippets inside the site block', async () => {
    const executor = new FakeRemoteExecutor();
    const caddy = new CaddyService(executor, config);

    await caddy.configureBackend({
      ...baseApp,
      caddy: { append: 'header X-Content-Type-Options "nosniff"' },
    });

    expect(executor.getLastCommand()?.command).toContain('header X-Content-Type-Options "nosniff"');
    expect(executor.getLastCommand()?.command).toContain(`    header X-Content-Type-Options "nosniff"
}`);
  });
});
