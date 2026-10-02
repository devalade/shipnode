import { writeFile, readFile as readFileNode } from 'node:fs/promises';
import { ensureDir, pathExists } from 'fs-extra';
import { resolve } from 'path';
import { text, select, confirm, isCancel } from '@clack/prompts';
import { detectFramework, detectPkgManager } from '../../domain/framework/detector.js';
import { isValidIpOrHostname, isValidPort } from '../../domain/validation/ip.js';
import { ui } from '../ui.js';
import type { DatabaseType } from '../../shared/types.js';

function cancelIfNeeded(v: unknown): asserts v is string | boolean | number {
  if (isCancel(v)) {
    ui.warn('Cancelled.');
    process.exit(0);
  }
}

interface InitOptions {
  nonInteractive?: boolean;
  print?: boolean;
  host?: string;
  domain?: string;
}

/**
 * Ask only what shipnode cannot work out by itself: where the server is, and
 * the domain if there is one. Everything else — app type, port, package
 * manager — is detected, and the rest takes a default the developer can change
 * in the generated file. Power-user options (workers, watt, fleets, users) live
 * in the config, not in a questionnaire every newcomer has to sit through.
 */
export async function cmdInit(cwd: string, options: InitOptions): Promise<void> {
  const configPath = resolve(cwd, 'shipnode.config.ts');
  if (!options.print && (await pathExists(configPath))) {
    ui.warn('shipnode.config.ts already exists — edit it, or delete it to start over.');
    return;
  }

  const detection = await detectFramework(cwd);
  const pkgManager = await detectPkgManager(cwd);
  const appName = await getAppName(cwd);
  const defaultPort = detection.port ?? 3000;

  if (options.host !== undefined && !isValidIpOrHostname(options.host)) {
    ui.error('Invalid --host. Must be an IP address or hostname.');
    process.exit(1);
  }

  if (options.nonInteractive || options.print) {
    const config = generateConfig({
      app: detection.appType === 'backend' ? 'backend' : 'frontend',
      appName,
      sshHost: options.host,
      backendPort: defaultPort,
      domain: options.domain,
      pkgManager: pkgManager ?? undefined,
    });

    if (options.print) {
      console.log(config);
      return;
    }

    await writeFile(configPath, config, 'utf-8');
    ui.success('Created shipnode.config.ts');
    if (!options.host) ui.warn("Set your server's IP in .ssh({ host }) before running shipnode setup.");
    await generateShipnodeDir(cwd);
    return;
  }

  ui.banner();
  ui.note(
    `Detected: ${detection.name} (${detection.appType})` +
    (detection.orm ? `\nORM: ${detection.orm}` : ''),
    'Project',
  );

  const appTypeVal = await select({
    message: 'What are you deploying?',
    initialValue: detection.appType === 'backend' ? 'backend' : 'frontend',
    options: [
      { value: 'backend', label: 'A Node.js server', hint: 'API, SSR, Express, Fastify, Nest…' },
      { value: 'frontend', label: 'A static site', hint: 'Vite, SPA, docs — built locally, served by Caddy' },
    ],
  });
  cancelIfNeeded(appTypeVal);
  const appType = appTypeVal as 'backend' | 'frontend';

  const sshHost = options.host ?? await text({
    message: "Server IP address",
    placeholder: '1.2.3.4',
    validate: (value) => (isValidIpOrHostname(value ?? '') ? undefined : 'Enter an IP address or hostname'),
  });
  cancelIfNeeded(sshHost);

  let backendPort = defaultPort;
  if (appType === 'backend') {
    const portVal = await text({
      message: 'Which port does your app listen on?',
      initialValue: String(defaultPort),
      validate: (value) => (isValidPort(parseInt(value ?? '', 10)) ? undefined : 'Enter a port number'),
    });
    cancelIfNeeded(portVal);
    backendPort = parseInt(portVal as string, 10);
  }

  const domainVal = options.domain ?? await text({
    message: 'Domain (leave empty to skip — you get HTTPS automatically when set)',
    placeholder: appType === 'backend' ? 'api.example.com' : 'example.com',
  });
  cancelIfNeeded(domainVal);
  const domain = (domainVal as string | undefined)?.trim() || undefined;

  let dbType: DatabaseType | undefined;
  let hasRedis = false;
  if (appType === 'backend') {
    const dbVal = await select({
      message: 'Install a database on the server?',
      initialValue: 'none',
      options: [
        { value: 'none', label: 'No' },
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
        { value: 'mongodb', label: 'MongoDB' },
        { value: 'sqlite', label: 'SQLite', hint: 'a file, nothing to install' },
      ],
    });
    cancelIfNeeded(dbVal);
    dbType = dbVal === 'none' ? undefined : (dbVal as DatabaseType);

    const redisVal = await confirm({ message: 'Install Redis on the server?', initialValue: false });
    cancelIfNeeded(redisVal);
    hasRedis = redisVal as boolean;
  }

  const config = generateConfig({
    app: appType,
    appName,
    sshHost: sshHost as string,
    backendPort,
    domain,
    pkgManager: pkgManager ?? undefined,
    dbType,
    redis: hasRedis,
  });

  await writeFile(configPath, config, 'utf-8');
  ui.success('Created shipnode.config.ts');
  await generateShipnodeDir(cwd);

  ui.note(
    [
      'shipnode setup    # once: installs Node, PM2, Caddy… on the server',
      'shipnode deploy   # every time you ship',
    ].join('\n'),
    'Next',
  );
  if (domain) ui.info(`Point ${domain}'s DNS A record at ${sshHost as string} before deploying.`);
  ui.outro('Ready!');
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
  backendPort?: number;
  domain?: string;
  pkgManager?: string;
  dbType?: DatabaseType;
  redis?: boolean;
}

async function generateShipnodeDir(cwd: string): Promise<void> {
  await ensureDir(resolve(cwd, '.shipnode'));

  const ignorePath = resolve(cwd, '.shipnodeignore');
  if (!(await pathExists(ignorePath))) {
    await writeFile(ignorePath, generateShipnodeIgnore(), 'utf-8');
    ui.success('Generated .shipnodeignore');
  }
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

const DEFAULT_DB_PORT: Record<Exclude<DatabaseType, 'sqlite'>, number> = {
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
};

export function generateConfig(opts: ConfigOptions): string {
  const lines = [
    "import { shipnode } from '@devalade/shipnode';",
    '',
    'export default shipnode',
    `  .${opts.app}()`,
    // 'deploy' is the user `shipnode setup` creates. Setup itself logs in as
    // root the first time, while that user does not exist yet.
    `  .ssh({ host: '${opts.sshHost ?? 'YOUR_SERVER_IP'}', user: 'deploy' })`,
    `  .deployTo('/var/www/${opts.appName}')`,
  ];

  if (opts.app === 'backend') {
    lines.push(`  .pm2('${opts.appName}')`);
    lines.push(`  .port(${opts.backendPort ?? 3000})`);
  }

  if (opts.domain) {
    lines.push(`  .domain('${opts.domain}')`);
  }

  if (opts.pkgManager) {
    lines.push(`  .pkgManager('${opts.pkgManager}')`);
  }

  if (opts.dbType === 'sqlite') {
    lines.push(`  .database({ type: 'sqlite', name: './data.db' })`);
  } else if (opts.dbType) {
    lines.push(
      `  .database({ type: '${opts.dbType}', host: 'localhost', port: ${DEFAULT_DB_PORT[opts.dbType]}, ` +
      `name: '${opts.appName}', user: '${opts.appName}', password: process.env.DB_PASSWORD })`,
    );
  }

  if (opts.redis) {
    lines.push(`  .redis({ host: 'localhost', port: 6379, password: process.env.REDIS_PASSWORD })`);
  }

  lines.push('  .build();');
  lines.push('');
  return lines.join('\n');
}
