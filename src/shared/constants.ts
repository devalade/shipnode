export const DEFAULTS = {
  SSH_PORT: 22,
  BACKEND_PORT: 3000,
  NODE_VERSION: 'lts',
  ZERO_DOWNTIME: true,
  KEEP_RELEASES: 5,
  HEALTH_CHECK_ENABLED: true,
  HEALTH_CHECK_PATH: '/health',
  HEALTH_CHECK_TIMEOUT: 30,
  HEALTH_CHECK_RETRIES: 3,
  HEALTH_CHECK_STARTUP_DELAY: 3,
  ENV_FILE: '.env',
  PM2_INSTANCES: 1,
  PM2_MAX_MEMORY: '512M',
} as const;

export const RSYNC_DEFAULT_EXCLUDES = [
  'node_modules',
  '.env',
  '.git',
  '.gitignore',
  'shipnode.config.ts',
  '*.log',
  '.shipnode',
  'dist',
  '.DS_Store',
] as const;

export const FRAMEWORK_PATTERNS = {
  Express: { deps: ['express'], appType: 'backend' as const },
  NestJS: { deps: ['@nestjs/core'], appType: 'backend' as const },
  Fastify: { deps: ['fastify'], appType: 'backend' as const },
  Koa: { deps: ['koa'], appType: 'backend' as const },
  Hapi: { deps: ['@hapi/hapi'], appType: 'backend' as const },
  Hono: { deps: ['hono'], appType: 'backend' as const },
  AdonisJS: { deps: ['@adonisjs/core'], appType: 'backend' as const },
  'Next.js': { deps: ['next'], appType: 'backend' as const },
  Nuxt: { deps: ['nuxt'], appType: 'backend' as const },
  Remix: { deps: ['@remix-run'], appType: 'backend' as const },
  Astro: { deps: ['astro'], appType: 'backend' as const },
  React: { deps: ['react'], appType: 'frontend' as const },
  'React Router': { deps: ['react-router'], appType: 'frontend' as const },
  'TanStack Router': { deps: ['@tanstack/react-router'], appType: 'frontend' as const },
  Vue: { deps: ['vue'], appType: 'frontend' as const },
  Svelte: { deps: ['svelte'], appType: 'frontend' as const },
  SolidJS: { deps: ['solid-js'], appType: 'frontend' as const },
  Angular: { deps: ['@angular/core'], appType: 'frontend' as const },
} as const;

export const ORM_PATTERNS = {
  Prisma: {
    deps: ['prisma', '@prisma/client'],
    migrateCmd: 'npx prisma migrate deploy',
    generateCmd: 'npx prisma generate',
  },
  Drizzle: {
    deps: ['drizzle-orm'],
    migrateCmd: 'npx drizzle-kit migrate',
    generateCmd: 'npx drizzle-kit generate',
  },
  TypeORM: {
    deps: ['typeorm'],
    migrateCmd: 'npx typeorm migration:run',
    generateCmd: '',
  },
  Sequelize: {
    deps: ['sequelize'],
    migrateCmd: 'npx sequelize-cli db:migrate',
    generateCmd: '',
  },
  Knex: {
    deps: ['knex'],
    migrateCmd: 'npx knex migrate:latest',
    generateCmd: '',
  },
  Mongoose: {
    deps: ['mongoose'],
    migrateCmd: '',
    generateCmd: '',
  },
} as const;

export const PKG_MANAGER_COMMANDS: Record<string, { install: string; run: string }> = {
  npm: { install: 'npm ci --production', run: 'npm run' },
  yarn: { install: 'yarn install --production', run: 'yarn' },
  pnpm: { install: 'pnpm install --prod', run: 'pnpm' },
  bun: { install: 'bun install --production', run: 'bun run' },
} as const;
