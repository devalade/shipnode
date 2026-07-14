import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ci github', () => {
  it('writes a root workflow with the exact scoped Shipnode version and no paths filter', async () => {
    const root = await temporaryDirectory('shipnode-ci-');
    await initialiseGitRepository(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));

    await cmdCiGithub(root);

    const workflow = await readWorkflow(root);
    expect(workflow).toContain('npm install -g @devalade/shipnode@3.2.0-alpha.0');
    expect(workflow).not.toContain('paths:');
    expect(workflow).not.toContain('working-directory:');
  });

  it('writes at the Git root and runs only deploy from a nested app directory', async () => {
    const root = await temporaryDirectory('shipnode-monorepo-');
    const appDirectory = join(root, 'apps', 'api');
    await mkdir(appDirectory, { recursive: true });
    await initialiseGitRepository(root);
    await writeFile(join(root, 'package.json'), '{}');

    await cmdCiGithub(appDirectory);

    const workflow = await readWorkflow(root);
    expect(workflow).toContain("working-directory: 'apps/api'");
    expect(workflow.match(/working-directory:/g)).toHaveLength(1);
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
