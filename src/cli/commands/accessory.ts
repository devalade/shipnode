import { Result, type Result as ResultType } from 'better-result';
import { loadConfig } from '../../config/loader.js';
import { configForServer, getServerTargetResult } from '../../domain/servers.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import { AccessoryService } from '../../services/accessory.service.js';
import type { ShipnodeConfig } from '../../shared/types.js';
import {
  NoAccessoriesConfiguredError,
  UnknownAccessoryError,
  type AccessoryCommandError,
} from '../../shared/result-errors.js';
import { ui } from '../ui.js';

function getAccessoryNames(
  config: ShipnodeConfig,
  name?: string,
): ResultType<string[], AccessoryCommandError> {
  const accessories = config.accessories ?? {};
  if (name) {
    if (!accessories[name]) return Result.err(new UnknownAccessoryError({ name }));
    return Result.ok([name]);
  }
  const names = Object.keys(accessories);
  return names.length > 0 ? Result.ok(names) : Result.err(new NoAccessoriesConfiguredError());
}

async function runAccessoryCommand(
  cwd: string,
  options: { config?: string; name?: string },
  command: (service: AccessoryService, name: string | undefined, serverName: string) => Promise<void>,
): Promise<void> {
  try {
    const config = await loadConfig(cwd, options.config);
    const names = getAccessoryNames(config, options.name);
    if (names.isErr()) {
      ui.error(names.error.message);
      process.exit(1);
      return;
    }

    const grouped = new Map<string, string[]>();
    for (const name of names.value) {
      const accessory = config.accessories![name]!;
      const target = getServerTargetResult(config, accessory.on);
      if (target.isErr()) {
        ui.error(target.error.message);
        process.exit(1);
        return;
      }
      grouped.set(target.value.name, [...(grouped.get(target.value.name) ?? []), name]);
    }

    for (const [serverName, accessoryNames] of grouped) {
      const serverConfig = configForServer(config, serverName);
      const ssh = new SshConnection();
      try {
        await ssh.connect(serverConfig.ssh);
        const service = new AccessoryService(ssh, serverConfig);
        await command(service, options.name ? accessoryNames[0] : undefined, serverName);
      } finally {
        ssh.disconnect();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  }
}

export async function cmdAccessoryStatus(cwd: string, options: { config?: string; name?: string }): Promise<void> {
  await runAccessoryCommand(cwd, options, async (service, name, serverName) => {
    ui.heading(`Accessories: ${serverName}`);
    console.log(await service.status(name));
  });
}

export async function cmdAccessoryLogs(cwd: string, name: string, options: { config?: string; lines?: number }): Promise<void> {
  await runAccessoryCommand(cwd, { config: options.config, name }, async (service) => {
    const output = await service.logs(name, options.lines ?? 100);
    if (output) console.log(output);
  });
}

export async function cmdAccessoryRestart(cwd: string, name: string, options: { config?: string }): Promise<void> {
  await runAccessoryCommand(cwd, { config: options.config, name }, async (service) => {
    await service.restart(name);
    ui.success(`Accessory '${name}' restarted`);
  });
}

export async function cmdAccessoryStop(cwd: string, name: string, options: { config?: string }): Promise<void> {
  await runAccessoryCommand(cwd, { config: options.config, name }, async (service) => {
    await service.stop(name);
    ui.success(`Accessory '${name}' stopped`);
  });
}

export async function cmdAccessoryHealth(cwd: string, name: string, options: { config?: string }): Promise<void> {
  await runAccessoryCommand(cwd, { config: options.config, name }, async (service) => {
    const result = await service.health(name);
    if (result.isErr()) {
      ui.error(result.error.message);
      process.exit(1);
      return;
    }
    ui.success(`Accessory '${name}' health check passed`);
  });
}
