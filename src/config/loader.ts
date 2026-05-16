import { resolve } from 'path';
import { readFile } from 'node:fs/promises';
import { pathExists } from 'fs-extra';
import { createJiti } from 'jiti';
import type { ShipnodeConfig } from '../shared/types.js';
import { assembleConfig } from './assembly.js';
import { ConfigError } from '../shared/errors.js';
import type { ShipnodeBuilder } from './builder.js';

async function loadEnvIntoProcess(envFilePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(envFilePath, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function detectEnvFile(configFile: string, cwd: string): Promise<string> {
  try {
    const content = await readFile(configFile, 'utf-8');
    const match = content.match(/\.envFile\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    return resolve(cwd, match ? match[1] : '.env');
  } catch {
    return resolve(cwd, '.env');
  }
}

export async function loadConfig(cwd: string, configPath?: string): Promise<ShipnodeConfig> {
  const file = configPath ?? resolve(cwd, 'shipnode.config.ts');
  await loadEnvIntoProcess(await detectEnvFile(file, cwd));

  const exists = await pathExists(file);
  if (!exists) {
    throw new ConfigError(
      `shipnode.config.ts not found at ${file}.\nRun \`shipnode init\` to create one.`
    );
  }

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = await jiti.import(file);

  const raw = (mod as { default?: unknown }).default ?? mod;

  if (raw && typeof raw === 'object' && 'build' in raw && typeof (raw as ShipnodeBuilder).build === 'function') {
    return (raw as ShipnodeBuilder).build();
  }

  return assembleConfig(raw as Partial<ShipnodeConfig>);
}
