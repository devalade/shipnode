import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePackageJson, detectFramework, detectPkgManager, getInstallCommand, getRunCommand } from '../../src/domain/framework/detector.js';
import * as fsExtra from 'fs-extra';
import * as fs from 'fs/promises';

vi.mock('fs-extra');
vi.mock('fs/promises');

describe('parsePackageJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when package.json does not exist', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(false);
    const result = await parsePackageJson('/test');
    expect(result).toBeNull();
  });

  it('parses dependencies and devDependencies', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      dependencies: { express: '^4.18.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));

    const result = await parsePackageJson('/test');
    expect(result).toEqual({
      express: '^4.18.0',
      typescript: '^5.0.0',
    });
  });

  it('returns null on invalid JSON', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue('not json');

    const result = await parsePackageJson('/test');
    expect(result).toBeNull();
  });
});

describe('detectFramework', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects Express as backend', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      dependencies: { express: '^4.18.0' },
    }));

    const result = await detectFramework('/test');
    expect(result.name).toBe('Express');
    expect(result.appType).toBe('backend');
  });

  it('detects NestJS as backend', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      dependencies: { '@nestjs/core': '^10.0.0' },
    }));

    const result = await detectFramework('/test');
    expect(result.name).toBe('NestJS');
    expect(result.appType).toBe('backend');
  });

  it('detects Next.js as backend', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      dependencies: { next: '^14.0.0' },
    }));

    const result = await detectFramework('/test');
    expect(result.name).toBe('Next.js');
    expect(result.appType).toBe('backend');
  });

  it('detects React as frontend', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    }));

    const result = await detectFramework('/test');
    expect(result.name).toBe('React');
    expect(result.appType).toBe('frontend');
  });

  it('detects Vue as frontend', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      dependencies: { vue: '^3.0.0' },
    }));

    const result = await detectFramework('/test');
    expect(result.name).toBe('Vue');
    expect(result.appType).toBe('frontend');
  });

  it('returns unknown when no framework detected', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      dependencies: { lodash: '^4.0.0' },
    }));

    const result = await detectFramework('/test');
    expect(result.name).toBe('unknown');
    expect(result.appType).toBe('unknown');
  });

  it('returns unknown when package.json missing', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(false);

    const result = await detectFramework('/test');
    expect(result.name).toBe('unknown');
    expect(result.appType).toBe('unknown');
  });
});

describe('detectPkgManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects npm from package-lock.json', async () => {
    vi.mocked(fsExtra.pathExists).mockImplementation(async (p: string) => {
      return p === '/test/package-lock.json';
    });

    const result = await detectPkgManager('/test');
    expect(result).toBe('npm');
  });

  it('detects yarn from yarn.lock', async () => {
    vi.mocked(fsExtra.pathExists).mockImplementation(async (p: string) => {
      return p === '/test/yarn.lock';
    });

    const result = await detectPkgManager('/test');
    expect(result).toBe('yarn');
  });

  it('detects pnpm from pnpm-lock.yaml', async () => {
    vi.mocked(fsExtra.pathExists).mockImplementation(async (p: string) => {
      return p === '/test/pnpm-lock.yaml';
    });

    const result = await detectPkgManager('/test');
    expect(result).toBe('pnpm');
  });

  it('detects bun from bun.lockb', async () => {
    vi.mocked(fsExtra.pathExists).mockImplementation(async (p: string) => {
      return p === '/test/bun.lockb';
    });

    const result = await detectPkgManager('/test');
    expect(result).toBe('bun');
  });

  it('returns null when no lock file found', async () => {
    vi.mocked(fsExtra.pathExists).mockResolvedValue(false);

    const result = await detectPkgManager('/test');
    expect(result).toBeNull();
  });
});

describe('getInstallCommand', () => {
  it('returns correct command for npm', () => {
    expect(getInstallCommand('npm')).toBe('npm ci --production');
  });

  it('returns correct command for yarn', () => {
    expect(getInstallCommand('yarn')).toBe('yarn install --production');
  });

  it('returns correct command for pnpm', () => {
    expect(getInstallCommand('pnpm')).toBe('pnpm install --prod');
  });

  it('returns correct command for bun', () => {
    expect(getInstallCommand('bun')).toBe('bun install --production');
  });
});

describe('getRunCommand', () => {
  it('returns correct command for npm', () => {
    expect(getRunCommand('npm')).toBe('npm run');
  });

  it('returns correct command for yarn', () => {
    expect(getRunCommand('yarn')).toBe('yarn');
  });

  it('returns correct command for pnpm', () => {
    expect(getRunCommand('pnpm')).toBe('pnpm');
  });

  it('returns correct command for bun', () => {
    expect(getRunCommand('bun')).toBe('bun run');
  });
});
