import { Result, type Result as ResultType } from 'better-result';
import type { AccessoryConfig, RegistryConfig, ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';
import { MissingAccessoryHealthCheckError, type AccessoryCommandError } from '../shared/result-errors.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function registryLoginCommand(registry: RegistryConfig): string {
  return `. ~/.shipnode/secrets.env 2>/dev/null || true; ` +
    `if [ -z "$${registry.passwordEnv}" ]; then echo "Registry password env ${registry.passwordEnv} is not set on the remote host" >&2; exit 1; fi; ` +
    `printf '%s' "$${registry.passwordEnv}" | sudo docker login ${shellQuote(registry.server)} ` +
    `--username ${shellQuote(registry.username)} --password-stdin`;
}

function arrayOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function namedVolumeFromMount(mount: string): string | undefined {
  const [source] = mount.split(':');
  if (!source) return undefined;
  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) return undefined;
  return source;
}

/** Prefer `directories`; fall back to Compose-style `volumes`. */
export function accessoryMounts(accessory: AccessoryConfig): string[] {
  return accessory.directories ?? accessory.volumes ?? [];
}

export function buildAccessoryRunCommand(
  name: string,
  accessory: AccessoryConfig,
  workspaceRegistry?: RegistryConfig,
): string {
  const mounts = accessoryMounts(accessory);
  const ports = arrayOf(accessory.port).map((port) => `-p ${shellQuote(port)}`);
  const volumes = mounts.map((dir) => `-v ${shellQuote(dir)}`);
  const networks = (accessory.networks ?? []).map((network) => `--network ${shellQuote(network)}`);
  const env = Object.entries(accessory.env ?? {}).map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`);
  const labels = Object.entries(accessory.labels ?? {}).map(([key, value]) => `--label ${shellQuote(`${key}=${value}`)}`);
  const resources = [
    accessory.resources?.memory ? `--memory ${shellQuote(accessory.resources.memory)}` : undefined,
    accessory.resources?.memoryReservation ? `--memory-reservation ${shellQuote(accessory.resources.memoryReservation)}` : undefined,
    accessory.resources?.cpus ? `--cpus ${shellQuote(accessory.resources.cpus)}` : undefined,
  ].flatMap((arg) => arg === undefined ? [] : [arg]);
  const stopTimeout = accessory.stopTimeout === undefined ? [] : [`--stop-timeout ${accessory.stopTimeout}`];
  const args = [
    ...ports,
    ...volumes,
    ...networks,
    ...env,
    ...labels,
    ...resources,
    ...stopTimeout,
  ].join(' ');
  const containerName = `shipnode-${name}`;
  const registry = accessory.registry ?? workspaceRegistry;
  const login = registry ? `${registryLoginCommand(registry)} && ` : '';
  const namedVolumes = mounts.flatMap((mount) => {
    const volume = namedVolumeFromMount(mount);
    return volume === undefined ? [] : [volume];
  });
  const volumeSetup = namedVolumes.map((volume) =>
    `sudo docker volume inspect ${shellQuote(volume)} >/dev/null 2>&1 || sudo docker volume create ${shellQuote(volume)} >/dev/null; `,
  );
  const networkSetup = (accessory.networks ?? []).map((network) =>
    `sudo docker network inspect ${shellQuote(network)} >/dev/null 2>&1 || sudo docker network create ${shellQuote(network)} >/dev/null; `,
  );
  const command = arrayOf(accessory.command).map(shellQuote).join(' ');

  return [
    login,
    ...volumeSetup,
    ...networkSetup,
    `sudo docker pull ${shellQuote(accessory.image)} && `,
    `sudo docker rm -f ${shellQuote(containerName)} >/dev/null 2>&1 || true; `,
    `sudo docker run -d --restart ${shellQuote(accessory.restart ?? 'unless-stopped')} --name ${shellQuote(containerName)} `,
    args ? `${args} ` : '',
    shellQuote(accessory.image),
    command ? ` ${command}` : '',
  ].join('');
}

export function getAccessoryContainerName(name: string): string {
  return `shipnode-${name}`;
}

export class AccessoryService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  async ensureAll(): Promise<void> {
    for (const [name, accessory] of Object.entries(this.config.accessories ?? {})) {
      await this.executor.execOrThrow(buildAccessoryRunCommand(name, accessory, this.config.registry));
      if (accessory.healthCheck) {
        await this.executor.execOrThrow(
          `sudo docker exec ${shellQuote(getAccessoryContainerName(name))} sh -lc ${shellQuote(accessory.healthCheck.command)}`,
        );
      }
    }
  }

  async status(name?: string): Promise<string> {
    const names = name ? [name] : Object.keys(this.config.accessories ?? {});
    if (names.length === 0) return 'No accessories configured.';
    const containers = names.map((item) => shellQuote(getAccessoryContainerName(item))).join(' ');
    const result = await this.executor.exec(
      `sudo docker inspect --format '{{.Name}} {{.State.Status}} {{.Config.Image}}' ${containers} 2>/dev/null || true`,
    );
    return result.stdout || 'No accessory containers found.';
  }

  async logs(name: string, lines: number): Promise<string> {
    const result = await this.executor.exec(
      `sudo docker logs --tail ${lines} ${shellQuote(getAccessoryContainerName(name))} 2>&1`,
    );
    return result.stdout || result.stderr;
  }

  async restart(name: string): Promise<void> {
    await this.executor.execOrThrow(`sudo docker restart ${shellQuote(getAccessoryContainerName(name))}`);
  }

  async stop(name: string): Promise<void> {
    await this.executor.execOrThrow(`sudo docker stop ${shellQuote(getAccessoryContainerName(name))}`);
  }

  async health(name: string): Promise<ResultType<void, AccessoryCommandError>> {
    const accessory = this.config.accessories?.[name];
    if (!accessory?.healthCheck) {
      return Result.err(new MissingAccessoryHealthCheckError({ name }));
    }
    await this.executor.execOrThrow(
      `sudo docker exec ${shellQuote(getAccessoryContainerName(name))} sh -lc ${shellQuote(accessory.healthCheck.command)}`,
    );
    return Result.ok();
  }
}
