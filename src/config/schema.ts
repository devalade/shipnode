import { z } from 'zod';
import { isValidIpOrHostname, isValidDomain, isValidPm2Name } from '../domain/validation/ip.js';

export const SshConfigSchema = z.object({
  host: z.string().refine(isValidIpOrHostname, 'Must be a valid IP address or hostname'),
  user: z.string().min(1, 'SSH user is required'),
  port: z.number().int().min(1).max(65535).default(22),
  identityFile: z.string().optional(),
  proxyMode: z.enum(['cloudflare']).optional(),
  proxyCommand: z.string().optional(),
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
}).optional();

export const CloudflareConfigSchema = z.object({
  zone: z.string().min(1, 'Cloudflare zone is required'),
  appHostname: z.string().optional(),
  sshHostname: z.string().optional(),
  tunnelName: z.string().optional(),
  lockdownFirewall: z.boolean().default(false),
  accessEmails: z.array(z.string().email()).optional(),
  bootstrapSshHost: z.string().optional(),
}).optional();

export const HooksConfigSchema = z.object({
  preDeploy: z.function().args(z.any()).returns(z.promise(z.void()).or(z.void())).optional(),
  postDeploy: z.function().args(z.any()).returns(z.promise(z.void()).or(z.void())).optional(),
}).optional();

export const ShipnodeConfigSchema = z.object({
  app: z.enum(['backend', 'frontend']),
  ssh: SshConfigSchema,
  remotePath: z.string().min(1, 'Remote path is required'),
  pm2: Pm2ConfigSchema.optional(),
  domain: z.string().refine(isValidDomain, 'Must be a valid domain (no protocol)').optional(),
  keepReleases: z.number().int().min(1).default(5),
  healthCheck: HealthCheckConfigSchema,
  envFile: z.string().default('.env'),
  nodeVersion: z.string().default('lts'),
  pkgManager: z.enum(['npm', 'yarn', 'pnpm', 'bun']).optional(),
  buildDir: z.string().optional(),
  sharedDirs: z.array(z.string()).optional(),
  sharedFiles: z.array(z.string()).optional(),
  database: DatabaseConfigSchema,
  redis: RedisConfigSchema,
  backup: BackupConfigSchema,
  cloudflare: CloudflareConfigSchema,
  hooks: HooksConfigSchema,
}).refine(
  (cfg) => !(cfg.app === 'frontend' && cfg.pm2),
  { message: 'frontend apps cannot declare pm2 (frontends are static files served by Caddy)', path: ['pm2'] },
).refine(
  (cfg) => {
    if (!cfg.domain || cfg.app !== 'backend') return true;
    const hasWebApp = cfg.pm2?.apps.some((a) => a.port !== undefined);
    return hasWebApp ?? false;
  },
  { message: 'domain requires a web app: one pm2.apps entry must declare a port', path: ['domain'] },
);

export type ShipnodeConfigSchema = z.infer<typeof ShipnodeConfigSchema>;
