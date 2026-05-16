import { writeFile, readFile as readFileNode } from 'node:fs/promises';
import { ensureDir, pathExists } from 'fs-extra';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { detectFramework, detectPkgManager } from '../../domain/framework/detector.js';
import { isValidIpOrHostname, isValidPort } from '../../domain/validation/ip.js';
import { ORM_PATTERNS } from '../../shared/constants.js';
import { ui } from '../ui.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export async function cmdInit(cwd: string, options: { nonInteractive?: boolean; print?: boolean }): Promise<void> {
  ui.info('Initializing ShipNode configuration...');

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
    const exists = await pathExists(configPath);
    if (exists) {
      ui.warn('shipnode.config.ts already exists. Use --force to overwrite.');
      return;
    }

    await writeFile(configPath, config, 'utf-8');
    ui.success('Created shipnode.config.ts');
    await generateShipnodeDir(cwd, detection.orm);
    return;
  }

  ui.info(`Detected: ${detection.name} (${detection.appType})`);
  if (detection.orm) {
    ui.info(`ORM: ${detection.orm}`);
  }

  const appType = await ask('App type', isBackend ? 'backend' : 'frontend');
  const sshHost = await ask('SSH host');

  if (!isValidIpOrHostname(sshHost)) {
    ui.error('Invalid host. Must be an IP address or hostname.');
    process.exit(1);
  }

  const sshUser = await ask('SSH user', 'deploy');
  const sshPortStr = await ask('SSH port', '22');
  const sshPort = parseInt(sshPortStr, 10);

  if (!isValidPort(sshPort)) {
    ui.error('Invalid port number.');
    process.exit(1);
  }

  const remotePath = await ask('Remote deploy path', `/var/www/${appName}`);

  let pm2Name = '';
  let backendPort = defaultPort;
  let domain = '';
  let zeroDowntime = true;
  let healthCheckPath = '/health';

  if (appType === 'backend') {
    pm2Name = await ask('PM2 app name', appName);
    backendPort = parseInt(await ask('Backend port', String(defaultPort)), 10);
    domain = await ask('Domain (optional)', '');
    const zd = await ask('Enable zero-downtime deployments?', 'yes');
    zeroDowntime = zd.toLowerCase().startsWith('y');
    if (zeroDowntime) {
      healthCheckPath = await ask('Health check path', '/health');
    }
  } else {
    domain = await ask('Domain (optional)', '');
  }

  rl.close();

  const config = generateConfig({
    app: appType as 'backend' | 'frontend',
    appName,
    sshHost,
    sshUser,
    sshPort,
    remotePath,
    pm2Name,
    backendPort,
    domain: domain || undefined,
    zeroDowntime,
    healthCheckPath,
    pkgManager: pkgManager ?? undefined,
  });

  const configPath = resolve(cwd, 'shipnode.config.ts');
  const exists = await pathExists(configPath);
  if (exists) {
    ui.warn('shipnode.config.ts already exists. Use --force to overwrite.');
    return;
  }

  await writeFile(configPath, config, 'utf-8');
  ui.success('Created shipnode.config.ts');

  await generateShipnodeDir(cwd, detection.orm);
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
  zeroDowntime?: boolean;
  healthCheckPath?: string;
  pkgManager?: string;
}

async function generateShipnodeDir(cwd: string, detectedOrm?: string): Promise<void> {
  const dir = resolve(cwd, '.shipnode');
  await ensureDir(dir);

  const preDeployPath = resolve(dir, 'pre-deploy.sh');
  const postDeployPath = resolve(dir, 'post-deploy.sh');
  const ignorePath = resolve(cwd, '.shipnodeignore');

  if (!(await pathExists(preDeployPath))) {
    await writeFile(preDeployPath, generatePreDeployHook(detectedOrm), 'utf-8');
    await import('fs/promises').then((fs) => fs.chmod(preDeployPath, 0o755));
  }

  if (!(await pathExists(postDeployPath))) {
    await writeFile(postDeployPath, generatePostDeployHook(), 'utf-8');
    await import('fs/promises').then((fs) => fs.chmod(postDeployPath, 0o755));
  }

  if (!(await pathExists(ignorePath))) {
    await writeFile(ignorePath, generateShipnodeIgnore(), 'utf-8');
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
  if (opts.sshPort && opts.sshPort !== 22) sshOpts.push(`port: ${opts.sshPort}`);

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

  if (opts.zeroDowntime !== false) {
    lines.push('  .zeroDowntime()');
  }

  if (opts.healthCheckPath) {
    lines.push(`  .healthCheck('${opts.healthCheckPath}')`);
  }

  if (opts.pkgManager) {
    lines.push(`  .pkgManager('${opts.pkgManager}')`);
  }

  lines.push('  .build();');
  lines.push('');
  return lines.join('\n');
}
