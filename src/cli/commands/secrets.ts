import { loadConfig } from '../../config/loader.js';
import { getServerTargetResult } from '../../domain/servers.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import type { RegistryConfig, ShipnodeConfig } from '../../shared/types.js';
import { ui } from '../ui.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function assertValidEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid secret name '${name}'. Use a valid shell environment variable name.`);
  }
}

function secretSetCommand(name: string, value: string): string {
  const quotedAssignment = shellQuote(`export ${name}=${shellQuote(value)}`);
  return [
    'mkdir -p ~/.shipnode',
    'touch ~/.shipnode/secrets.env',
    `grep -v '^export ${name}=' ~/.shipnode/secrets.env > ~/.shipnode/secrets.env.tmp || true`,
    `printf '%s\\n' ${quotedAssignment} >> ~/.shipnode/secrets.env.tmp`,
    'mv ~/.shipnode/secrets.env.tmp ~/.shipnode/secrets.env',
    'chmod 600 ~/.shipnode/secrets.env',
    'grep -q "shipnode/secrets.env" ~/.profile 2>/dev/null || printf \'\\n# shipnode secrets\\n[ -f ~/.shipnode/secrets.env ] && . ~/.shipnode/secrets.env\\n\' >> ~/.profile',
  ].join(' && ');
}

function registryLoginCommand(registry: RegistryConfig): string {
  return `. ~/.shipnode/secrets.env 2>/dev/null || true; ` +
    `if [ -z "$${registry.passwordEnv}" ]; then echo "Registry password env ${registry.passwordEnv} is not set on the remote host" >&2; exit 1; fi; ` +
    `printf '%s' "$${registry.passwordEnv}" | sudo docker login ${shellQuote(registry.server)} --username ${shellQuote(registry.username)} --password-stdin`;
}

async function runOnTarget(
  config: ShipnodeConfig,
  targetName: string | undefined,
  command: string,
): Promise<string> {
  const target = getServerTargetResult(config, targetName);
  if (target.isErr()) return target.error.message;

  const ssh = new SshConnection();
  try {
    await ssh.connect(target.value.ssh);
    await ssh.execOrThrow(command);
    return '';
  } finally {
    ssh.disconnect();
  }
}

export async function cmdSecretSet(
  cwd: string,
  name: string,
  value: string | undefined,
  options: { config?: string; on?: string },
): Promise<void> {
  try {
    assertValidEnvName(name);
    const secretValue = value ?? process.env[name];
    if (secretValue === undefined) throw new Error(`Secret value missing. Pass value or set local ${name}.`);

    const config = await loadConfig(cwd, options.config);
    const error = await runOnTarget(config, options.on, secretSetCommand(name, secretValue));
    if (error) {
      ui.error(error);
      process.exit(1);
      return;
    }
    ui.success(`Secret '${name}' set`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  }
}

export async function cmdRegistryLogin(cwd: string, options: { config?: string; on?: string }): Promise<void> {
  try {
    const config = await loadConfig(cwd, options.config);
    if (!config.registry) throw new Error('No workspace registry configured.');

    const value = process.env[config.registry.passwordEnv];
    if (value !== undefined) {
      const setError = await runOnTarget(config, options.on, secretSetCommand(config.registry.passwordEnv, value));
      if (setError) {
        ui.error(setError);
        process.exit(1);
        return;
      }
    }

    const loginError = await runOnTarget(config, options.on, registryLoginCommand(config.registry));
    if (loginError) {
      ui.error(loginError);
      process.exit(1);
      return;
    }
    ui.success(`Logged in to ${config.registry.server}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  }
}
