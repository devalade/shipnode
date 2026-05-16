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

export const Pm2ConfigSchema = z.object({
  name: z.string().refine(isValidPm2Name, 'PM2 name must be alphanumeric, dash, or underscore (max 64 chars)'),
  instances: z.number().int().min(1).optional(),
  maxMemory: z.string().optional(),
});

export const BackendConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
});

export const HealthCheckConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('/health'),
  timeout: z.number().int().min(1).default(30),
  retries: z.number().int().min(1).default(3),
  startupDelay: z.number().int().min(0).default(3),
}).default({});

export const DatabaseConfigSchema = z.object({
  type: z.enum(['postgres', 'mysql', 'sqlite', 'mongodb']),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  name: z.string(),
  user: z.string(),
  password: z.string().optional(),
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
  backend: BackendConfigSchema.optional(),
  domain: z.string().refine(isValidDomain, 'Must be a valid domain (no protocol)').optional(),
  zeroDowntime: z.boolean().default(true),
  keepReleases: z.number().int().min(1).default(5),
  healthCheck: HealthCheckConfigSchema,
  envFile: z.string().default('.env'),
  nodeVersion: z.string().default('lts'),
  pkgManager: z.enum(['npm', 'yarn', 'pnpm', 'bun']).optional(),
  sharedDirs: z.array(z.string()).optional(),
  sharedFiles: z.array(z.string()).optional(),
  database: DatabaseConfigSchema,
  hooks: HooksConfigSchema,
});

export type ShipnodeConfigSchema = z.infer<typeof ShipnodeConfigSchema>;
