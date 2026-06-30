import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';

const minimalConfig = `
import { shipnode } from '${join(process.cwd(), 'src/config/builder.ts').replace(/\\/g, '/')}';

export default shipnode
  .backend()
  .ssh({ host: '1.2.3.4', user: 'deploy' })
  .deployTo('/var/www/app')
  .pm2('myapp')
  .build();
`;

describe('loadConfig — --config path resolution', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shipnode-loader-'));
    await writeFile(join(dir, 'shipnode.custom.config.ts'), minimalConfig);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves a relative --config path against cwd, not against shipnode dist/', async () => {
    // Previously this threw "Cannot find module './shipnode.custom.config.ts'"
    // because jiti's anchor is the loader file inside dist/.
    const config = await loadConfig(dir, './shipnode.custom.config.ts');
    expect(config.apps[0].appType).toBe('backend');
    expect(config.remotePath).toBe('/var/www/app');
  });

  it('accepts a bare filename as --config (no ./ prefix)', async () => {
    const config = await loadConfig(dir, 'shipnode.custom.config.ts');
    expect(config.apps[0].pm2?.apps[0].name).toBe('myapp');
  });

  it('still accepts an absolute --config path', async () => {
    const config = await loadConfig(dir, join(dir, 'shipnode.custom.config.ts'));
    expect(config.ssh.host).toBe('1.2.3.4');
  });
});
