import { writeFile, readFile as readFileNode, chmod } from 'node:fs/promises';
import { ensureDir, pathExists } from 'fs-extra';
import { resolve } from 'path';
import { text, select, confirm, isCancel, group } from '@clack/prompts';
import { detectFramework, detectPkgManager } from '../../domain/framework/detector.js';
import { isValidIpOrHostname, isValidPort } from '../../domain/validation/ip.js';
import { ORM_PATTERNS } from '../../shared/constants.js';
import { ui } from '../ui.js';
import type { DatabaseType } from '../../shared/types.js';

function cancelIfNeeded(v: unknown): asserts v is string | boolean | number {
  if (isCancel(v)) {
    ui.warn('Cancelled.');
    process.exit(0);
  }
}

export async function cmdInit(cwd: string, options: { nonInteractive?: boolean; print?: boolean }): Promise<void> {
  const detection = await detectFramework(cwd);
  const pkgManager = await detectPkgManager(cwd);
  const isBackend = detection.appType === 'backend';
  const appName = await getAppName(cwd);
  const defaultPort = detection.port ?? 3000;

  if (options.nonInteractive || options.print) {
    const config = generateConfig({
      app: isBackend ? 'backend' : 'frontend',
      appName,
      backendPort: defaultPort,
      pkgManager: pkgManager ?? undefined,
    });

    if (options.print) {
      console.log(config);
      return;
    }

    const configPath = resolve(cwd, 'shipnode.config.ts');
    if (await pathExists(configPath)) {
      ui.warn('shipnode.config.ts already exists. Use --force to overwrite.');
      return;
    }

    await writeFile(configPath, config, 'utf-8');
    ui.success('Created shipnode.config.ts');
    await generateShipnodeDir(cwd, detection.orm);
    return;
  }

  ui.banner();
  ui.note(
    `Detected: ${detection.name} (${detection.appType})` +
    (detection.orm ? `\nORM: ${detection.orm}` : ''),
    'Project',
  );

  // ── Server ─────────────────────────────────────────────────────
  const appTypeVal = await select({
    message: 'App type',
    initialValue: isBackend ? 'backend' : 'frontend',
    options: [
      { value: 'backend', label: 'Backend', hint: 'Node.js server, PM2 managed' },
      { value: 'frontend', label: 'Frontend', hint: 'Static files, served by Caddy' },
    ],
  });
  cancelIfNeeded(appTypeVal);
  const appType = appTypeVal as string;

  const sshHost = await text({ message: 'SSH host', placeholder: '1.2.3.4' });
  cancelIfNeeded(sshHost);
  if (!isValidIpOrHostname(sshHost as string)) {
    ui.error('Invalid host. Must be an IP address or hostname.');
    process.exit(1);
  }

  const sshUser = await text({ message: 'SSH user', initialValue: 'deploy' });
  cancelIfNeeded(sshUser);

  const sshPortStr = await text({ message: 'SSH port', initialValue: '22' });
  cancelIfNeeded(sshPortStr);
  const sshPort = parseInt(sshPortStr as string, 10);
  if (!isValidPort(sshPort)) {
    ui.error('Invalid port number.');
    process.exit(1);
  }

  const remotePath = await text({ message: 'Remote deploy path', initialValue: `/var/www/${appName}` });
  cancelIfNeeded(remotePath);

  let pm2Name = '';
  let backendPort = defaultPort;
  let domain = '';
  let healthCheckPath = '/health';
  let dbType: DatabaseType | undefined;
  let dbHost: string | undefined;
  let dbPort: number | undefined;
  let dbName: string | undefined;
  let dbUser: string | undefined;
  let dbPassword: string | undefined;
  let redisHost: string | undefined;
  let redisPort: number | undefined;
  let redisPassword: string | undefined;

  if (appType === 'backend') {
    const pm2Val = await text({ message: 'PM2 app name', initialValue: appName });
    cancelIfNeeded(pm2Val);
    pm2Name = pm2Val as string;

    const portVal = await text({ message: 'Backend port', initialValue: String(defaultPort) });
    cancelIfNeeded(portVal);
    backendPort = parseInt(portVal as string, 10);

    const domainVal = await text({ message: 'Domain', placeholder: 'api.example.com (optional)' });
    cancelIfNeeded(domainVal);
    domain = domainVal as string;

    const hcVal = await text({ message: 'Health check path', initialValue: '/health' });
    cancelIfNeeded(hcVal);
    healthCheckPath = hcVal as string;

    const hasDb = await confirm({ message: 'Configure a database?', initialValue: false });
    cancelIfNeeded(hasDb);

    if (hasDb) {
      const dbTypeVal = await select({
        message: 'Database type',
        options: [
          { value: 'postgres', label: 'PostgreSQL', hint: 'port 5432' },
          { value: 'mysql', label: 'MySQL', hint: 'port 3306' },
          { value: 'sqlite', label: 'SQLite', hint: 'file-based' },
          { value: 'mongodb', label: 'MongoDB', hint: 'port 27017' },
        ],
      });
      cancelIfNeeded(dbTypeVal);
      dbType = dbTypeVal as DatabaseType;

      if (dbType !== 'sqlite') {
        const defaultDbPort = dbType === 'postgres' ? '5432' : dbType === 'mysql' ? '3306' : '27017';
        const dbVals = await group({
          dbHost: () => text({ message: 'Database host', initialValue: 'localhost' }),
          dbPort: () => text({ message: 'Database port', initialValue: defaultDbPort }),
          dbName: () => text({ message: 'Database name', initialValue: appName }),
          dbUser: () => text({ message: 'Database user', initialValue: appName }),
          dbPassword: () => text({ message: 'Database password', placeholder: 'optional' }),
        });
        dbHost = dbVals.dbHost as string;
        dbPort = parseInt(dbVals.dbPort as string, 10);
        dbName = dbVals.dbName as string;
        dbUser = dbVals.dbUser as string;
        dbPassword = (dbVals.dbPassword as string) || undefined;
      } else {
        const sqliteVal = await text({ message: 'SQLite file path', initialValue: './data.db' });
        cancelIfNeeded(sqliteVal);
        dbName = sqliteVal as string;
      }
    }

    const hasRedis = await confirm({ message: 'Configure Redis?', initialValue: false });
    cancelIfNeeded(hasRedis);

    if (hasRedis) {
      const redisVals = await group({
        redisHost: () => text({ message: 'Redis host', initialValue: 'localhost' }),
        redisPort: () => text({ message: 'Redis port', initialValue: '6379' }),
        redisPassword: () => text({ message: 'Redis password', placeholder: 'optional' }),
      });
      redisHost = redisVals.redisHost as string;
      redisPort = parseInt(redisVals.redisPort as string, 10);
      redisPassword = (redisVals.redisPassword as string) || undefined;
    }
  } else {
    const domainVal = await text({ message: 'Domain', placeholder: 'example.com (optional)' });
    cancelIfNeeded(domainVal);
    domain = domainVal as string;
  }

  // ── Users ──────────────────────────────────────────────────────
  const users: Array<{ username: string; publicKey: string; sudo: boolean }> = [];
  const addUsers = await confirm({ message: 'Add SSH users to the server?', initialValue: false });
  cancelIfNeeded(addUsers);

  if (addUsers) {
    let addMore = true;
    while (addMore) {
      const username = await text({ message: 'Username' });
      cancelIfNeeded(username);
      if (!(username as string)) break;
      const publicKey = await text({ message: `Public key for ${username as string}`, placeholder: 'ssh-ed25519 AAAA...' });
      cancelIfNeeded(publicKey);
      const sudo = await confirm({ message: `Grant sudo to ${username as string}?`, initialValue: false });
      cancelIfNeeded(sudo);
      users.push({ username: username as string, publicKey: publicKey as string, sudo: sudo as boolean });
      const more = await confirm({ message: 'Add another user?', initialValue: false });
      cancelIfNeeded(more);
      addMore = more as boolean;
    }
  }

  const config = generateConfig({
    app: appType as 'backend' | 'frontend',
    appName,
    sshHost: sshHost as string,
    sshUser: sshUser as string,
    sshPort,
    remotePath: remotePath as string,
    pm2Name,
    backendPort,
    domain: domain || undefined,
    healthCheckPath,
    pkgManager: pkgManager ?? undefined,
    dbType,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    dbPassword: dbPassword || undefined,
    redisHost,
    redisPort,
    redisPassword: redisPassword || undefined,
  });

  const configPath = resolve(cwd, 'shipnode.config.ts');
  if (await pathExists(configPath)) {
    ui.warn('shipnode.config.ts already exists. Use --force to overwrite.');
    return;
  }

  await writeFile(configPath, config, 'utf-8');
  await generateShipnodeDir(cwd, detection.orm, users);

  ui.outro('Ready! Run shipnode setup to provision your server.');
}

async function getAppName(cwd: string): Promise<string> {
  try {
    const pkgPath = resolve(cwd, 'package.json');
    const content = await readFileNode(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    if (pkg.name) {
      return pkg.name.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9._-]/g, '-');
    }
  } catch {
    // ignore
  }
  return cwd.split('/').pop() ?? 'myapp';
}

interface ConfigOptions {
  app: 'backend' | 'frontend';
  appName: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number;
  remotePath?: string;
  pm2Name?: string;
  backendPort?: number;
  domain?: string;
  healthCheckPath?: string;
  pkgManager?: string;
  dbType?: DatabaseType;
  dbHost?: string;
  dbPort?: number;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
}

async function generateShipnodeDir(
  cwd: string,
  detectedOrm?: string,
  users: Array<{ username: string; publicKey: string; sudo: boolean }> = [],
): Promise<void> {
  const dir = resolve(cwd, '.shipnode');
  await ensureDir(dir);

  const preDeployPath = resolve(dir, 'pre-deploy.sh');
  const postDeployPath = resolve(dir, 'post-deploy.sh');
  const ignorePath = resolve(cwd, '.shipnodeignore');

  if (!(await pathExists(preDeployPath))) {
    await writeFile(preDeployPath, generatePreDeployHook(detectedOrm), 'utf-8');
    await chmod(preDeployPath, 0o755);
  }

  if (!(await pathExists(postDeployPath))) {
    await writeFile(postDeployPath, generatePostDeployHook(), 'utf-8');
    await chmod(postDeployPath, 0o755);
  }

  if (!(await pathExists(ignorePath))) {
    await writeFile(ignorePath, generateShipnodeIgnore(), 'utf-8');
  }

  if (users.length > 0) {
    const usersPath = resolve(dir, 'users.yml');
    const yaml = users.map((u) => [
      `- username: ${u.username}`,
      `  publicKey: ${u.publicKey}`,
      `  sudo: ${u.sudo}`,
    ].join('\n')).join('\n') + '\n';
    await writeFile(usersPath, yaml, 'utf-8');
    ui.success(`Created .shipnode/users.yml with ${users.length} user(s)`);
  }

  const ormMsg = detectedOrm ? ` with ${detectedOrm} commands` : '';
  ui.success(`Generated .shipnode/ hooks${ormMsg} and .shipnodeignore`);
}

function generatePreDeployHook(detectedOrm?: string): string {
  const ormCommands = Object.entries(ORM_PATTERNS)
    .filter(([, p]) => p.migrateCmd)
    .map(([name, p]) => {
      const active = name === detectedOrm;
      const prefix = active ? '' : '# ';
      const lines = [`${prefix}# ${name}${active ? ' (detected)' : ''}`];
      if (p.generateCmd) lines.push(`${prefix}${p.generateCmd}`);
      lines.push(`${prefix}${p.migrateCmd}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return `#!/bin/bash
# ShipNode Pre-Deploy Hook
# Runs BEFORE the new release is activated. Exit non-zero to abort.
#
# Env vars: RELEASE_PATH  REMOTE_PATH  PM2_APP_NAME  BACKEND_PORT  SHARED_ENV_PATH
set -e

if [ -f "$SHARED_ENV_PATH" ]; then
  set -a; source "$SHARED_ENV_PATH"; set +a
fi

echo "Pre-deploy: \${RELEASE_PATH}"

# ── Database migrations ──────────────────────────────────────────
${ormCommands}
# ────────────────────────────────────────────────────────────────

echo "Pre-deploy hook complete"
`;
}

function generatePostDeployHook(): string {
  return `#!/bin/bash
# ShipNode Post-Deploy Hook
# Runs AFTER deployment. Failure is logged but does NOT trigger rollback.
#
# Env vars: RELEASE_PATH  RELEASE_TIMESTAMP  REMOTE_PATH  PM2_APP_NAME  BACKEND_PORT
set -e

echo "Post-deploy: \${RELEASE_PATH}"

# Examples:
#   curl -s http://localhost:\${BACKEND_PORT}/api/warmup
#   npm run cache:clear

echo "Post-deploy hook complete"
`;
}

function generateShipnodeIgnore(): string {
  return `# .shipnodeignore — files excluded from rsync (same syntax as .gitignore)
node_modules/
.env
.env.*
.git/
*.log
dist/
build/
coverage/
.DS_Store
`;
}

function generateConfig(opts: ConfigOptions): string {
  const lines = [
    "import { shipnode } from '@devalade/shipnode';",
    '',
    'export default shipnode',
    `  .${opts.app}()`,
  ];

  const sshOpts: string[] = [];
  if (opts.sshHost) sshOpts.push(`host: '${opts.sshHost}'`);
  if (opts.sshUser) sshOpts.push(`user: '${opts.sshUser}'`);
  sshOpts.push(`port: ${opts.sshPort ?? 22}`);

  if (sshOpts.length > 0) {
    lines.push(`  .ssh({ ${sshOpts.join(', ')} })`);
  }

  if (opts.remotePath) {
    lines.push(`  .deployTo('${opts.remotePath}')`);
  }

  if (opts.pm2Name) {
    lines.push(`  .pm2('${opts.pm2Name}')`);
  }

  if (opts.app === 'backend') {
    lines.push(`  .port(${opts.backendPort ?? 3000})`);
  }

  if (opts.domain) {
    lines.push(`  .domain('${opts.domain}')`);
  }

  if (opts.healthCheckPath) {
    lines.push(`  .healthCheck('${opts.healthCheckPath}')`);
  }

  if (opts.pkgManager) {
    lines.push(`  .pkgManager('${opts.pkgManager}')`);
  }

  if (opts.dbType) {
    if (opts.dbType === 'sqlite') {
      lines.push(`  .database({ type: 'sqlite', host: 'localhost', port: 0, name: '${opts.dbName ?? './data.db'}', user: '' })`);
    } else {
      const dbOpts = [
        `type: '${opts.dbType}'`,
        `host: '${opts.dbHost ?? 'localhost'}'`,
        `port: ${opts.dbPort ?? 5432}`,
        `name: '${opts.dbName ?? ''}'`,
        `user: '${opts.dbUser ?? ''}'`,
        ...(opts.dbPassword ? [`password: process.env.DB_PASSWORD ?? '${opts.dbPassword}'`] : [`// password: process.env.DB_PASSWORD`]),
      ];
      lines.push(`  .database({ ${dbOpts.join(', ')} })`);
    }
  }

  if (opts.redisHost !== undefined || opts.redisPort !== undefined) {
    const redisOpts = [
      `host: '${opts.redisHost ?? 'localhost'}'`,
      `port: ${opts.redisPort ?? 6379}`,
      ...(opts.redisPassword ? [`password: process.env.REDIS_PASSWORD ?? '${opts.redisPassword}'`] : [`// password: process.env.REDIS_PASSWORD`]),
    ];
    lines.push(`  .redis({ ${redisOpts.join(', ')} })`);
  }

  lines.push('  .build();');
  lines.push('');
  return lines.join('\n');
}
