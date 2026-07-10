import type { AccessoryConfig, RegistryConfig, ShipnodeConfig } from '../shared/types.js';
import type { RemoteExecutor } from '../domain/remote/executor.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function registryLoginCommand(registry: RegistryConfig): string {
  return `test -n "$${registry.passwordEnv}" && ` +
    `printf '%s' "$${registry.passwordEnv}" | sudo docker login ${shellQuote(registry.server)} ` +
    `--username ${shellQuote(registry.username)} --password-stdin`;
}

function arrayOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function buildAccessoryRunCommand(
  name: string,
  accessory: AccessoryConfig,
  workspaceRegistry?: RegistryConfig,
): string {
  const ports = arrayOf(accessory.port).map((port) => `-p ${shellQuote(port)}`);
  const volumes = (accessory.directories ?? []).map((dir) => `-v ${shellQuote(dir)}`);
  const env = Object.entries(accessory.env ?? {}).map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`);
  const args = [...ports, ...volumes, ...env].join(' ');
  const containerName = `shipnode-${name}`;
  const registry = accessory.registry ?? workspaceRegistry;
  const login = registry ? `${registryLoginCommand(registry)} && ` : '';

  return [
    login,
    `sudo docker pull ${shellQuote(accessory.image)} && `,
    `sudo docker rm -f ${shellQuote(containerName)} >/dev/null 2>&1 || true; `,
    `sudo docker run -d --restart unless-stopped --name ${shellQuote(containerName)} `,
    args ? `${args} ` : '',
    shellQuote(accessory.image),
  ].join('');
}

export class AccessoryService {
  constructor(
    private executor: RemoteExecutor,
    private config: ShipnodeConfig,
  ) {}

  async ensureAll(): Promise<void> {
    for (const [name, accessory] of Object.entries(this.config.accessories ?? {})) {
      await this.executor.execOrThrow(buildAccessoryRunCommand(name, accessory, this.config.registry));
    }
  }
}
