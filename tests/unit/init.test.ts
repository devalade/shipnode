import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateConfig } from '../../src/cli/commands/init.js';
import { loadConfig } from '../../src/config/loader.js';

// Every config `init` can write must load as-is: a generated file that fails
// validation is the first thing a newcomer sees go wrong.
describe('init — generated config', () => {
  let dir: string;
  const builder = join(process.cwd(), 'src/config/builder.ts').replace(/\\/g, '/');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shipnode-init-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The exported `shipnode` is a single mutable builder, so loading several
  // configs in one process would leak state between them. Each gets its own.
  async function load(source: string, name: string) {
    const isolated = source.replace(
      "import { shipnode } from '@devalade/shipnode';",
      `import { ShipnodeBuilder } from '${builder}';\nconst shipnode = new ShipnodeBuilder();`,
    );
    expect(isolated).not.toBe(source);
    await writeFile(join(dir, name), isolated);
    return loadConfig(dir, name);
  }

  it('writes a backend that deploys as the deploy user and probes leniently', async () => {
    const source = generateConfig({ app: 'backend', appName: 'shop', sshHost: '1.2.3.4', backendPort: 4000, pkgManager: 'pnpm' });
    const config = await load(source, 'backend.config.ts');

    expect(config.ssh).toMatchObject({ host: '1.2.3.4', user: 'deploy', port: 22 });
    expect(config.remotePath).toBe('/var/www/shop');
    expect(config.apps[0].pm2?.apps[0]).toMatchObject({ name: 'shop', port: 4000 });
    expect(config.apps[0].envFile).toBe('.env');
    expect(config.apps[0].healthCheck).toMatchObject({ enabled: true, strict: false });
    expect(source).not.toContain('healthCheck');
  });

  it('writes a backend with a domain, a database and Redis', async () => {
    const source = generateConfig({
      app: 'backend', appName: 'shop', sshHost: '1.2.3.4', backendPort: 3000,
      domain: 'api.example.com', dbType: 'postgres', redis: true,
    });
    const config = await load(source, 'full.config.ts');

    expect(config.apps[0].domain).toBe('api.example.com');
    expect(config.database).toMatchObject({ type: 'postgres', host: 'localhost', port: 5432, name: 'shop', user: 'shop' });
    expect(config.redis).toMatchObject({ host: 'localhost', port: 6379 });
  });

  it('writes a static site', async () => {
    const config = await load(
      generateConfig({ app: 'frontend', appName: 'site', sshHost: '1.2.3.4', domain: 'example.com' }),
      'frontend.config.ts',
    );

    expect(config.apps[0].appType).toBe('frontend');
    expect(config.apps[0].domain).toBe('example.com');
  });

  it('writes SQLite without a server to install', async () => {
    const config = await load(
      generateConfig({ app: 'backend', appName: 'shop', sshHost: '1.2.3.4', dbType: 'sqlite' }),
      'sqlite.config.ts',
    );

    expect(config.database).toMatchObject({ type: 'sqlite', name: './data.db' });
  });
});
