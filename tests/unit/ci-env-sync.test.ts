import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCiEnvSync } from '../../src/cli/commands/ci.js';

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createProject(root: string, envContent: string): Promise<void> {
  await writeFile(join(root, 'shipnode.config.ts'), `
    export default {
      ssh: { host: 'example.com', user: 'deploy' },
      apps: [{ name: 'api', appType: 'backend', envFile: '.env.production' }],
    };
  `);
  await writeFile(join(root, '.env.production'), envContent);
}

async function installRecordingGh(root: string): Promise<{ argsFile: string; bodyFile: string }> {
  const binDirectory = join(root, 'bin');
  const argsFile = join(root, 'gh-args');
  const bodyFile = join(root, 'gh-body');
  await mkdir(binDirectory);
  const ghPath = join(binDirectory, 'gh');
  await writeFile(
    ghPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$GH_ARGS_FILE"\ncase "$*" in *--body*) : > "$GH_BODY_FILE" ;; *) cat > "$GH_BODY_FILE" ;; esac\n',
  );
  await chmod(ghPath, 0o755);
  process.env.PATH = `${binDirectory}:${originalPath ?? ''}`;
  process.env.GH_ARGS_FILE = argsFile;
  process.env.GH_BODY_FILE = bodyFile;
  return { argsFile, bodyFile };
}

afterEach(async () => {
  process.exitCode = undefined;
  process.env.PATH = originalPath;
  delete process.env.GH_ARGS_FILE;
  delete process.env.GH_BODY_FILE;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ci env-sync', () => {
  it('stores the complete dotenv file as one GitHub Environment secret via stdin', async () => {
    const root = await temporaryDirectory('shipnode-ci-env-sync-');
    const envContent = 'GREETING="hello world"\nEMPTY=\nMULTILINE="first\nsecond"\n';
    await createProject(root, envContent);
    const recording = await installRecordingGh(root);

    await cmdCiEnvSync(root, {
      all: true,
      app: 'api',
      environment: 'production',
      file: '.env.production',
    });

    expect(await readFile(recording.argsFile, 'utf8')).toBe(
      'secret set SHIPNODE_ENV_PRODUCTION_API --env production\n',
    );
    expect(await readFile(recording.bodyFile, 'utf8')).toBe(envContent);
  });

  it('rejects dotenv files larger than the GitHub secret limit before invoking gh', async () => {
    const root = await temporaryDirectory('shipnode-ci-env-large-');
    await createProject(root, `VALUE=${'x'.repeat(48 * 1024)}\n`);
    const recording = await installRecordingGh(root);

    await cmdCiEnvSync(root, {
      all: true,
      app: 'api',
      environment: 'production',
    });

    expect(process.exitCode).toBe(1);
    await expect(readFile(recording.argsFile, 'utf8')).rejects.toThrow();
  });

  it('supports a dry run without invoking gh', async () => {
    const root = await temporaryDirectory('shipnode-ci-env-dry-run-');
    await createProject(root, 'API_KEY=secret\n');
    const recording = await installRecordingGh(root);

    await cmdCiEnvSync(root, {
      app: 'api',
      environment: 'staging',
      dryRun: true,
    });

    expect(process.exitCode).toBeUndefined();
    await expect(readFile(recording.argsFile, 'utf8')).rejects.toThrow();
  });

  it('returns exit code 1 when GitHub CLI authentication is required', async () => {
    const root = await temporaryDirectory('shipnode-ci-env-auth-');
    await createProject(root, 'API_KEY=secret\n');
    const binDirectory = join(root, 'bin');
    await mkdir(binDirectory);
    const ghPath = join(binDirectory, 'gh');
    await writeFile(
      ghPath,
      '#!/bin/sh\ncat >/dev/null\necho "run gh auth login" >&2\nexit 1\n',
    );
    await chmod(ghPath, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ''}`;

    await cmdCiEnvSync(root, {
      all: true,
      app: 'api',
      environment: 'production',
    });

    expect(process.exitCode).toBe(1);
  });

  it('returns exit code 1 when GitHub CLI is unavailable', async () => {
    const root = await temporaryDirectory('shipnode-ci-env-no-gh-');
    await createProject(root, 'API_KEY=secret\n');
    const emptyBinDirectory = join(root, 'empty-bin');
    await mkdir(emptyBinDirectory);
    process.env.PATH = emptyBinDirectory;

    await cmdCiEnvSync(root, {
      all: true,
      app: 'api',
      environment: 'production',
    });

    expect(process.exitCode).toBe(1);
  });
});
