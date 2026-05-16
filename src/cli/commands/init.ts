import { writeFile, pathExists } from 'fs-extra';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { detectFramework, detectPkgManager } from '../../domain/framework/detector.js';
import { isValidIpOrHostname, isValidPort } from '../../domain/validation/ip.js';
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
}

async function getAppName(cwd: string): Promise<string> {
  try {
    const { readFile } = await import('fs/promises');
    const pkgPath = resolve(cwd, 'package.json');
    const content = await readFile(pkgPath, 'utf-8');
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

function generateConfig(opts: ConfigOptions): string {
  const lines = [
    "import { shipnode } from 'shipnode';",
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

  if (opts.backendPort && opts.backendPort !== 3000) {
    lines.push(`  .port(${opts.backendPort})`);
  }

  if (opts.domain) {
    lines.push(`  .domain('${opts.domain}')`);
  }

  if (opts.zeroDowntime !== false) {
    lines.push('  .zeroDowntime()');
  }

  if (opts.healthCheckPath && opts.healthCheckPath !== '/health') {
    lines.push(`  .healthCheck('${opts.healthCheckPath}')`);
  } else if (opts.healthCheckPath) {
    lines.push(`  .healthCheck('${opts.healthCheckPath}')`);
  }

  lines.push('');
  return lines.join('\n');
}
