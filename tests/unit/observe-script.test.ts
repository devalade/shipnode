import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { assembleConfig } from '../../src/config/assembly.js';
import { buildObserveScript } from '../../src/domain/observe/script.js';

const config = assembleConfig({
  app: 'backend',
  ssh: { host: '1.2.3.4', user: 'deploy', port: 22 },
  remotePath: '/var/www/app',
  pm2: { apps: [{ name: 'api', port: 3000 }] },
} as never);

describe('buildObserveScript system section', () => {
  const script = buildObserveScript(config, { apps: [] });

  it('reads memory in megabytes with a single unit flag', () => {
    // procps `free` rejects `-m` combined with `-b` ("Multiple unit options"),
    // which left the memory line empty and the monitor showing 0 / 0 MB.
    expect(script).toContain('free -m |');
    expect(script).not.toMatch(/free -\w*m\w*b|free -\w*b\w*m/);
  });

  it('emits a well-formed mem line wherever `free -m` is available', () => {
    const line = /echo "(mem:\$\(free -m \| awk '[^']*'\))"/.exec(script)?.[1];
    expect(line).toBeDefined();
    const probe = spawnSync('bash', ['-c', 'command -v free'], { encoding: 'utf8' });
    if (probe.status !== 0) return; // not Linux; the flag check above still guards the regression
    const out = spawnSync('bash', ['-c', `echo "${line}"`], { encoding: 'utf8' }).stdout.trim();
    expect(out).toMatch(/^mem:\d+ \d+$/);
  });
});
