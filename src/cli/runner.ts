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

/**
 * Run a command against every server the workspace touches.
 *
 * Servers are independent: one failing does not stop the rest, because a
 * half-finished fan-out with no account of what happened is worse than a slow
 * one. Failures are collected and reported together at the end, and the process
 * exits non-zero if any server failed.
 *
 * `appName` both validates the app exists and narrows the traversal to the
 * servers that app actually runs on — otherwise an unrelated server being
 * unreachable would sink a command scoped to one app.
 */
export async function runRemoteCommandForTargets(
  cwd: string,
  command: (ctx: { config: ShipnodeConfig; executor: RemoteExecutor; serverName: string }) => Promise<void>,
  options: { configPath?: string; includeEmpty?: boolean; appName?: string; serverName?: string } = {},
): Promise<void> {
  const workspace = await loadConfig(cwd, options.configPath);

  let config = workspace;
  if (options.appName) {
    const selected = configForAppResult(workspace, options.appName);
    if (selected.isErr()) {
      ui.error(selected.error.message);
      process.exit(1);
      return;
    }
    config = selected.value;
  }

  let targets = getServerTargets(config);
  if (options.serverName) {
    targets = targets.filter((target) => target.name === options.serverName);
    if (targets.length === 0) {
      const known = getServerTargets(config).map((target) => target.name).join(', ') || '(none)';
      ui.error(`Unknown server target '${options.serverName}'. Known targets: ${known}`);
      process.exit(1);
      return;
    }
  }

  const failures: { serverName: string; message: string }[] = [];
  let visited = 0;

  for (const target of targets) {
    const targetConfig = configForServer(config, target.name);
    if (!options.includeEmpty && targetConfig.apps.length === 0 && Object.keys(targetConfig.accessories ?? {}).length === 0) {
      continue;
    }

    visited += 1;
    const ssh = new SshConnection();
    try {
      await ssh.connect(target.ssh);
      await command({ config: targetConfig, executor: ssh, serverName: target.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ui.error(`${target.name}: ${message}`);
      failures.push({ serverName: target.name, message });
    } finally {
      ssh.disconnect();
    }
  }

  if (failures.length > 0) {
    ui.error(
      `Failed on ${failures.length} of ${visited} servers: ` +
      failures.map((failure) => failure.serverName).join(', '),
    );
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
