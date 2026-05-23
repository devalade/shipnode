import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { pathExists } from 'fs-extra';
import type { FrameworkDetectionResult, PkgManager } from '../../shared/types.js';
import { FRAMEWORK_PATTERNS, PKG_MANAGER_COMMANDS } from '../../shared/constants.js';

export async function parsePackageJson(cwd: string): Promise<Record<string, string> | null> {
  const pkgPath = resolve(cwd, 'package.json');
  const exists = await pathExists(pkgPath);
  if (!exists) return null;

  try {
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    return {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
  } catch {
    return null;
  }
}

export async function detectPkgManager(cwd: string): Promise<PkgManager | null> {
  const lockFiles: [string, PkgManager][] = [
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];

  for (const [file, pm] of lockFiles) {
    if (await pathExists(resolve(cwd, file))) return pm;
  }

  return null;
}

export async function detectFramework(cwd: string): Promise<FrameworkDetectionResult> {
  const deps = await parsePackageJson(cwd);
  if (!deps) {
    return { name: 'unknown', appType: 'unknown' };
  }

  const depKeys = Object.keys(deps);

  for (const [name, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    const matched = pattern.deps.some((d) => depKeys.some((k) => k === d || k.startsWith(d)));
    if (matched) {
      const port = await detectPortFromScripts(cwd);
      const orm = await detectOrm(cwd);
      return { name, appType: pattern.appType, port, orm };
    }
  }

  return { name: 'unknown', appType: 'unknown' };
}

async function detectPortFromScripts(cwd: string): Promise<number | undefined> {
  const pkgPath = resolve(cwd, 'package.json');
  const exists = await pathExists(pkgPath);
  if (!exists) return undefined;

  try {
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    const scripts = [pkg.scripts?.start, pkg.scripts?.dev].filter(Boolean).join(' ');

    const patterns = [
      /PORT=(\d+)/,
      /--port[= ](\d+)/,
      /(?:localhost|127\.0\.0\.1):(\d+)/,
      /listen\(['"]?:(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = scripts.match(pattern);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port >= 1 && port <= 65535) return port;
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function detectOrm(cwd: string): Promise<string | undefined> {
  const deps = await parsePackageJson(cwd);
  if (!deps) return undefined;

  const depKeys = Object.keys(deps);
  const ormMap: Record<string, string> = {
    'prisma': 'Prisma',
    '@prisma/client': 'Prisma',
    'drizzle-orm': 'Drizzle',
    'typeorm': 'TypeORM',
    'sequelize': 'Sequelize',
    'knex': 'Knex',
    'mongoose': 'Mongoose',
    '@adonisjs/lucid': 'AdonisJS Lucid',
  };

  for (const [dep, orm] of Object.entries(ormMap)) {
    if (depKeys.some((k) => k === dep || k.startsWith(dep))) {
      return orm;
    }
  }

  return undefined;
}

export function getInstallCommand(pkgManager: PkgManager): string {
  return PKG_MANAGER_COMMANDS[pkgManager]?.install ?? 'npm ci';
}

export function getRunCommand(pkgManager: PkgManager): string {
  return PKG_MANAGER_COMMANDS[pkgManager]?.run ?? 'npm run';
}
