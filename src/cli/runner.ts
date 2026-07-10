import type { ShipnodeConfig } from '../shared/types.js';
import { SshConnection } from '../infrastructure/ssh/connection.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { loadConfig } from '../config/loader.js';
import { ui } from './ui.js';
import { configForServer, configForAppResult, getServerTargets } from '../domain/servers.js';

/**
 * A command that operates against a remote host through an executor.
 *
 * Implementations are pure business logic: they do not manage
 * connection lifecycle or process exit. The runner owns both.
 */
export interface RemoteCommand {
  (ctx: { config: ShipnodeConfig; executor: RemoteExecutor }): Promise<void>;
}

/**
 * Run a remote command with full lifecycle management.
 *
 * Loads config, establishes an SSH connection, delegates to the
 * command, and guarantees cleanup. If the command throws, the error
 * is presented and the process exits with code 1.
 */
export async function runRemoteCommand(
  cwd: string,
  command: RemoteCommand,
  options: { configPath?: string } = {},
): Promise<void> {
  const config = await loadConfig(cwd, options.configPath);
  const ssh = new SshConnection();

  try {
    await ssh.connect(config.ssh);
    await command({ config, executor: ssh });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  } finally {
    ssh.disconnect();
  }
}

export async function runRemoteCommandForTargets(
  cwd: string,
  command: (ctx: { config: ShipnodeConfig; executor: RemoteExecutor; serverName: string }) => Promise<void>,
  options: { configPath?: string; includeEmpty?: boolean; appName?: string } = {},
): Promise<void> {
  const config = await loadConfig(cwd, options.configPath);
  if (options.appName) {
    const selected = configForAppResult(config, options.appName);
    if (selected.isErr()) {
      ui.error(selected.error.message);
      process.exit(1);
      return;
    }
  }

  try {
    for (const target of getServerTargets(config)) {
      const targetConfig = configForServer(config, target.name);
      if (!options.includeEmpty && targetConfig.apps.length === 0 && Object.keys(targetConfig.accessories ?? {}).length === 0) {
        continue;
      }

      const ssh = new SshConnection();
      try {
        await ssh.connect(target.ssh);
        await command({ config: targetConfig, executor: ssh, serverName: target.name });
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

export async function runRemoteCommandForConfig(
  config: ShipnodeConfig,
  command: (ctx: { config: ShipnodeConfig; executor: RemoteExecutor }) => Promise<void>,
): Promise<void> {
  const ssh = new SshConnection();

  try {
    await ssh.connect(config.ssh);
    await command({ config, executor: ssh });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  } finally {
    ssh.disconnect();
  }
}

/**
 * Run a local command that does not need a remote connection.
 *
 * Loads config and delegates to the command. Handles errors
 * and process exit consistently with remote commands.
 */
export async function runLocalCommand(
  cwd: string,
  command: (config: ShipnodeConfig) => Promise<void>,
  options: { configPath?: string } = {},
): Promise<void> {
  const config = await loadConfig(cwd, options.configPath);

  try {
    await command(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  }
}
