import { resolve } from 'path';
import { pathExists } from 'fs-extra';
import { createJiti } from 'jiti';
import type { ShipnodeConfig } from '../shared/types.js';
import { assembleConfig } from './assembly.js';
import { ConfigError } from '../shared/errors.js';
import type { ShipnodeBuilder } from './builder.js';

export async function loadConfig(cwd: string, configPath?: string): Promise<ShipnodeConfig> {
  const file = configPath ?? resolve(cwd, 'shipnode.config.ts');

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
