import { z } from 'zod';
import { isValidIpOrHostname, isValidDomain, isValidPm2Name } from '../domain/validation/ip.js';
import type { HookFn } from '../shared/types.js';

export const SshConfigSchema = z.object({
  host: z.string().refine(isValidIpOrHostname, 'Must be a valid IP address or hostname'),
  user: z.string().min(1, 'SSH user is required'),
  port: z.number().int().min(1).max(65535).default(22),
  identityFile: z.string().optional(),
  proxyMode: z.enum(['cloudflare']).optional(),
  proxyCommand: z.string().optional(),
});

export const RegistryConfigSchema = z.object({
  server: z.string().min(1, 'Registry server is required'),
  username: z.string().min(1, 'Registry username is required'),
  passwordEnv: z.string().min(1, 'Registry passwordEnv is required'),
});

export const AccessoryConfigSchema = z.object({
  image: z.string().min(1, 'Accessory image is required'),
  on: z.string().min(1).optional(),
  port: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  directories: z.array(z.string().min(1)).optional(),
  networks: z.array(z.string().min(1)).optional(),
  command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  labels: z.record(z.string().min(1), z.string()).optional(),
  restart: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).optional(),
  resources: z.object({
    memory: z.string().min(1).optional(),
    memoryReservation: z.string().min(1).optional(),
    cpus: z.string().min(1).optional(),
  }).optional(),
  stopTimeout: z.number().int().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  registry: RegistryConfigSchema.optional(),
  healthCheck: z.object({
    command: z.string().min(1, 'Accessory health check command is required'),
  }).optional(),
});

export const Pm2AppSchema = z.object({
  name: z.string().refine(isValidPm2Name, 'PM2 app name must be alphanumeric, dash, or underscore (max 64 chars)'),
  command: z.string().min(1).optional(),
  instances: z.number().int().min(1).optional(),
  maxMemory: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const Pm2ConfigSchema = z.object({
  apps: z.array(Pm2AppSchema).min(1, 'pm2.apps must contain at least one entry'),
}).refine(
  (cfg) => cfg.apps.filter((a) => a.port !== undefined).length <= 1,
  { message: 'at most one pm2.apps entry may declare a port (the web app)' },
).refine(
  (cfg) => new Set(cfg.apps.map((a) => a.name)).size === cfg.apps.length,
  { message: 'pm2.apps entries must have unique names' },
);

export const HealthCheckConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('/health'),
  timeout: z.number().int().min(1).default(30),
  retries: z.number().int().min(1).default(3),
  startupDelay: z.number().int().min(0).default(3),
}).default({});

const networkDbFields = {
  host: z.string().min(1, 'Database host is required'),
  port: z.number().int().min(1).max(65535),
  name: z.string().min(1, 'Database name is required'),
  user: z.string().min(1, 'Database user is required'),
  password: z.string().optional(),
};

export const DatabaseConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sqlite'), name: z.string().min(1, 'SQLite file path is required') }),
  z.object({ type: z.literal('postgres'), ...networkDbFields }),
  z.object({ type: z.literal('mysql'), ...networkDbFields }),
  z.object({ type: z.literal('mongodb'), ...networkDbFields }),
]).optional();

export const RedisConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().min(1).max(65535).default(6379),
  password: z.string().optional(),
}).optional();

export const BackupConfigSchema = z.object({
  s3Bucket: z.string().min(1, 'S3 bucket is required'),
  s3Prefix: z.string().optional(),
  s3Endpoint: z.string().optional(),
  schedule: z.enum(['hourly', 'daily', 'weekly']).default('daily'),
  retentionDays: z.number().int().min(1).default(14),
  // 'snapshot' (default) does full pg_dump + tar.gz snapshots each run — cheap
  // to reason about, no client-side state, but full-size every backup.
  // 'restic' uses block-level dedup + encryption via a client-side repository,
  // so daily deltas are typically 1-5% of full size. Works with Cloudflare R2
  // by setting s3Endpoint to https://<account-id>.r2.cloudflarestorage.com.
  strategy: z.enum(['snapshot', 'restic']).default('snapshot'),
  // Restic retention (ignored by snapshot strategy).
  keepDaily: z.number().int().min(1).default(7),
  keepWeekly: z.number().int().min(1).default(4),
  keepMonthly: z.number().int().min(1).default(6),
}).optional();

export const CloudflareConfigSchema = z.object({
  zone: z.string().min(1, 'Cloudflare zone is required'),
  sshHostname: z.string().optional(),
  tunnelName: z.string().optional(),
  lockdownFirewall: z.boolean().default(false),
  accessEmails: z.array(z.string().email()).optional(),
  bootstrapSshHost: z.string().optional(),
}).optional();

// z.custom<HookFn> rather than z.function(): we only need a runtime "is it callable" check;
// z.function() wraps the user's function in a validator-wrapper, breaking reference equality
// and making `hooks.postDeploy === userFn` false after parse. The wrap is deprecated in zod 4
// anyway. We validate callable-ness with a refine.
const HookFnSchema = z
  .custom<HookFn>((fn) => typeof fn === 'function', { message: 'hook must be a function' });

export const HooksConfigSchema = z.object({
  preDeploy: HookFnSchema.optional(),
  postDeploy: HookFnSchema.optional(),
}).optional();

// Per-app fields — anything that differs between two apps deployed to the same server.
// Workspace-level fields (ssh, deployTo, nodeVersion, pkgManager, cloudflare, database,
// redis, backup, aliases) live on ShipnodeConfigSchema. See docs/adr/0004-workspace-multi-app.md
// for the rationale of the split.
export const ShipnodeAppSchema = z.object({
  name: z.string().refine(isValidPm2Name, 'app name must be alphanumeric, dash, or underscore (max 64 chars)').default('app'),
  appType: z.enum(['backend', 'frontend']).default('backend'),
  on: z.string().min(1).optional(),
  appRoot: z.string().optional(),
  domain: z.string().refine(isValidDomain, 'Must be a valid domain (no protocol)').optional(),
  caddy: z.object({
    append: z.string().optional(),
  }).optional(),
  pm2: Pm2ConfigSchema.optional(),
  healthCheck: HealthCheckConfigSchema,
  envFile: z.string().default('.env'),
  keepReleases: z.number().int().min(1).default(5),
  sharedDirs: z.array(z.string()).optional(),
  sharedFiles: z.array(z.string()).optional(),
  buildDir: z.string().optional(),
  hooks: HooksConfigSchema,
  dependsOn: z.array(z.string().min(1)).optional(),
}).refine(
  (cfg) => !(cfg.appType === 'frontend' && cfg.pm2),
  { message: 'frontend apps cannot declare pm2 (frontends are static files served by Caddy)', path: ['pm2'] },
).refine(
  (cfg) => {
    if (!cfg.domain || cfg.appType !== 'backend') return true;
    const hasWebApp = cfg.pm2?.apps.some((a) => a.port !== undefined);
    return hasWebApp ?? false;
  },
  { message: 'domain requires a web app: one pm2.apps entry must declare a port', path: ['domain'] },
);

// A z.preprocess wrapper synthesizes `apps[0]` from the legacy top-level fields when
// the input doesn't carry `apps`. This lets every 2.x config (including the existing
// schema.test.ts cases that call ShipnodeConfigSchema.safeParse directly) parse without
// modification.
const ShipnodeConfigBaseSchema = z.object({
  // workspace-level
  ssh: SshConfigSchema.optional(),
  servers: z.record(z.string().min(1), SshConfigSchema).optional(),
  remotePath: z.string().min(1, 'Remote path is required').default('/var/www/app'),
  nodeVersion: z.string().default('lts'),
  pkgManager: z.enum(['npm', 'yarn', 'pnpm', 'bun']).optional(),
  installCommand: z.string().min(1).optional(),
  database: DatabaseConfigSchema,
  redis: RedisConfigSchema,
  backup: BackupConfigSchema,
  cloudflare: CloudflareConfigSchema,
  aliases: z.record(z.string(), z.string()).optional(),
  registry: RegistryConfigSchema.optional(),
  accessories: z.record(z.string().min(1), AccessoryConfigSchema).optional(),

  // canonical app list (always populated by assembleConfig; .min(1) enforced)
  apps: z.array(ShipnodeAppSchema).min(1, 'workspace must contain at least one app'),
}).superRefine((cfg, ctx) => {
  const servers = cfg.servers ?? (cfg.ssh ? { default: cfg.ssh } : undefined);
  if (!servers) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Either ssh or servers must be configured',
      path: ['ssh'],
    });
    return;
  }

  const serverNames = new Set(Object.keys(servers));
  if (serverNames.size === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one server target must be configured',
      path: ['servers'],
    });
    return;
  }

  const validateTarget = (target: string | undefined, path: (string | number)[]): void => {
    if (!target) {
      if (!serverNames.has('default') && serverNames.size !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Server target is required when no 'default' server is configured",
          path,
        });
      }
      return;
    }
    if (!serverNames.has(target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown server target '${target}'`,
        path,
      });
    }
  };

  cfg.apps.forEach((app, index) => validateTarget(app.on, ['apps', index, 'on']));
  Object.entries(cfg.accessories ?? {}).forEach(([name, accessory]) => {
    validateTarget(accessory.on, ['accessories', name, 'on']);
  });
  const accessoryNames = new Set(Object.keys(cfg.accessories ?? {}));
  cfg.apps.forEach((app, index) => {
    for (const name of app.dependsOn ?? []) {
      if (!accessoryNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown accessory dependency '${name}'`,
          path: ['apps', index, 'dependsOn'],
        });
      }
    }
  });
}).transform((cfg) => {
  const servers = cfg.servers ?? (cfg.ssh === undefined ? undefined : { default: cfg.ssh });
  if (servers === undefined) throw new Error('Either ssh or servers must be configured');

  const firstServer = Object.values(servers)[0];
  if (firstServer === undefined) throw new Error('At least one server target must be configured');

  const ssh = cfg.ssh ?? servers.default ?? firstServer;
  return { ...cfg, ssh, servers };
});

export const ShipnodeConfigSchema = z.preprocess(
  (input: unknown) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
    const obj = input as Record<string, unknown>;
    if (obj.apps !== undefined) return obj;

    // Synthesize apps[0] from legacy top-level fields. The name defaults to the first
    // pm2.apps[].name if there is one (so .pm2('biormin') → app.name === 'biormin').
    const pm2 = obj.pm2 as { apps?: Array<{ name?: string }> } | undefined;
    const pm2Name = pm2?.apps?.[0]?.name;
    return {
      ...obj,
      apps: [{
        name: pm2Name ?? 'app',
        appType: obj.app,
        on: obj.on,
        appRoot: obj.appRoot,
        domain: obj.domain,
        caddy: obj.caddy,
        pm2: obj.pm2,
        healthCheck: obj.healthCheck,
        envFile: obj.envFile,
        keepReleases: obj.keepReleases,
        sharedDirs: obj.sharedDirs,
        sharedFiles: obj.sharedFiles,
        buildDir: obj.buildDir,
        hooks: obj.hooks,
        dependsOn: obj.dependsOn,
      }],
    };
  },
  ShipnodeConfigBaseSchema,
);

export type ShipnodeConfigSchema = z.infer<typeof ShipnodeConfigSchema>;
