import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { load } from 'js-yaml';
import { cmdCiGithub } from '../../src/cli/commands/ci.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function initialiseGitRepository(directory: string): Promise<void> {
  await execa('git', ['init', '--quiet'], { cwd: directory });
}

async function readWorkflow(root: string): Promise<string> {
  return readFile(join(root, '.github', 'workflows', 'shipnode-deploy.yml'), 'utf8');
}

async function currentPackageSpec(): Promise<string> {
  const metadata: unknown = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8'),
  );
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('name' in metadata) ||
    !('version' in metadata) ||
    typeof metadata.name !== 'string' ||
    typeof metadata.version !== 'string'
  ) {
    throw new Error('Invalid package metadata in test fixture');
  }
  return `${metadata.name}@${metadata.version}`;
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ci github', () => {
  it('writes a root workflow with the exact scoped Shipnode version and no paths filter', async () => {
    const root = await temporaryDirectory('shipnode-ci-');
    await initialiseGitRepository(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));

    await cmdCiGithub(root);

    const workflow = await readWorkflow(root);
    expect(() => load(workflow)).not.toThrow();
    expect(workflow).toContain(`npm install -g ${await currentPackageSpec()}`);
    expect(workflow).not.toContain('paths:');
    expect(workflow).not.toContain('working-directory:');
    expect(workflow).not.toContain('- name: Build');
    expect(workflow).not.toContain('SHIPNODE_ENV');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain("environment: 'production'");
    expect(workflow).toContain('group: shipnode-production');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('writes at the Git root and runs only deploy from a nested app directory', async () => {
    const root = await temporaryDirectory('shipnode-monorepo-');
    const appDirectory = join(root, 'apps', 'api');
    await mkdir(appDirectory, { recursive: true });
    await initialiseGitRepository(root);
    await writeFile(join(root, 'package.json'), '{}');

    await cmdCiGithub(appDirectory);

    const workflow = await readWorkflow(root);
    expect(() => load(workflow)).not.toThrow();
    expect(workflow).toContain("working-directory: 'apps/api'");
    expect(workflow.match(/working-directory:/g)).toHaveLength(1);
  });

  it('materializes and uploads one environment-scoped app secret when env sync is enabled', async () => {
    const root = await temporaryDirectory('shipnode-ci-env-');
    await initialiseGitRepository(root);
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'shipnode.config.ts'), `
      export default {
        ssh: { host: 'example.com', user: 'deploy' },
        nodeVersion: '22',
        apps: [{ name: 'api', appType: 'backend', envFile: 'config/.env.production' }],
      };
    `);

    await cmdCiGithub(root, {
      app: 'api',
      environment: 'staging',
      syncEnv: true,
    });

    const workflow = await readWorkflow(root);
    expect(() => load(workflow)).not.toThrow();
    expect(workflow).toContain("environment: 'staging'");
    expect(workflow).toContain("node-version: '22'");
    expect(workflow).toContain('group: shipnode-staging-api');
    expect(workflow).toContain('SHIPNODE_ENV_STAGING_API');
    expect(workflow).toContain('Missing GitHub Environment secret: SHIPNODE_ENV_STAGING_API');
    expect(workflow).toContain("printf '%s' \"$SHIPNODE_ENV_FILE\" > 'config/.env.production'");
    expect(workflow).toContain("shipnode env --app 'api' --file 'config/.env.production' --no-reload");
    expect(workflow).toContain("shipnode deploy --app 'api'");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("rm -f 'config/.env.production'");
  });

  it('requires an app target before enabling env sync in a multi-app workspace', async () => {
    const root = await temporaryDirectory('shipnode-ci-multi-env-');
    await initialiseGitRepository(root);
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'shipnode.config.ts'), `
      export default {
        ssh: { host: 'example.com', user: 'deploy' },
        apps: [
          { name: 'api', appType: 'backend', envFile: '.env.api' },
          { name: 'web', appType: 'frontend', envFile: '.env.web' },
        ],
      };
    `);

    await cmdCiGithub(root, { syncEnv: true });

    expect(process.exitCode).toBe(1);
    await expect(readWorkflow(root)).rejects.toThrow();
  });

  it('rejects environment names that could alter generated YAML', async () => {
    const root = await temporaryDirectory('shipnode-ci-invalid-environment-');
    await initialiseGitRepository(root);
    await writeFile(join(root, 'package.json'), '{}');

    await cmdCiGithub(root, { environment: 'production\npermissions: write-all' });

    expect(process.exitCode).toBe(1);
    await expect(readWorkflow(root)).rejects.toThrow();
  });

  it('quotes a nested deployment path containing spaces', async () => {
    const root = await temporaryDirectory('shipnode path with spaces-');
    const appDirectory = join(root, 'apps', 'public api');
    await mkdir(appDirectory, { recursive: true });
    await initialiseGitRepository(root);

    await cmdCiGithub(appDirectory);

    expect(await readWorkflow(root)).toContain("working-directory: 'apps/public api'");
  });

  it('falls back to the current directory outside a Git repository', async () => {
    const directory = await temporaryDirectory('shipnode-no-git-');

    await cmdCiGithub(directory);

    expect(await readWorkflow(directory)).toContain('run: shipnode deploy');
  });
});
