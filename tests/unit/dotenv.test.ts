import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithDotenv } from '../../src/domain/deploy/dotenv.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runWithDotenv', () => {
  it('passes shell-sensitive and multiline values as data without executing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shipnode-dotenv-'));
    temporaryDirectories.push(directory);
    const envFile = join(directory, '.env');
    const marker = join(directory, 'must-not-exist');
    await writeFile(envFile, `TOKEN="safe; touch ${marker}"\nMULTILINE="first\\nsecond"\n`);

    const command = runWithDotenv(
      envFile,
      "node -e 'process.stdout.write(JSON.stringify({ token: process.env.TOKEN, multiline: process.env.MULTILINE }))'",
    );
    const result = await execa('bash', ['-c', command]);

    expect(result.stdout).toBe(JSON.stringify({ token: `safe; touch ${marker}`, multiline: 'first\nsecond' }));
    await expect(execa('test', ['-e', marker])).rejects.toMatchObject({ exitCode: 1 });
  });

  it('lets explicit process values override dotenv values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shipnode-dotenv-'));
    temporaryDirectories.push(directory);
    const envFile = join(directory, '.env');
    await writeFile(envFile, 'PORT=3000\n');

    const command = runWithDotenv(envFile, "node -e 'process.stdout.write(process.env.PORT)'", { PORT: 13000 });
    const result = await execa('bash', ['-c', command]);

    expect(result.stdout).toBe('13000');
  });
});
