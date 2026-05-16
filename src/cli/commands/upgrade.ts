import { execSync } from 'child_process';
import { ui } from '../ui.js';

const PACKAGE_NAME = 'shipnode';

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
  if (!res.ok) throw new Error(`npm registry request failed: ${res.status}`);
  const data = await res.json() as { version: string };
  return data.version;
}

function currentVersion(): string {
  try {
    const out = execSync('shipnode --version 2>/dev/null', { encoding: 'utf8' }).trim();
    return out.replace(/^v/, '');
  } catch {
    return 'unknown';
  }
}

export async function cmdUpgrade(): Promise<void> {
  ui.info('Checking for updates...');

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    ui.error(`Failed to fetch latest version: ${(err as Error).message}`);
    process.exit(1);
  }

  const current = currentVersion();
  ui.info(`Current: ${current}  Latest: ${latest}`);

  if (current === latest) {
    ui.success('Already up to date.');
    return;
  }

  ui.info(`Upgrading ${PACKAGE_NAME} to v${latest}...`);

  const installCmd = detectInstallCmd();

  try {
    execSync(installCmd, { stdio: 'inherit' });
    ui.success(`Upgraded to v${latest}`);
  } catch {
    ui.error('Upgrade failed. Try manually:');
    console.log(`  npm install -g ${PACKAGE_NAME}@latest`);
    process.exit(1);
  }
}

function detectInstallCmd(): string {
  try {
    const path = execSync('which shipnode 2>/dev/null', { encoding: 'utf8' }).trim();
    if (path.includes('pnpm')) return `pnpm add -g ${PACKAGE_NAME}@latest`;
    if (path.includes('yarn')) return `yarn global add ${PACKAGE_NAME}@latest`;
    if (path.includes('bun')) return `bun add -g ${PACKAGE_NAME}@latest`;
  } catch {
    // fall through to npm
  }
  return `npm install -g ${PACKAGE_NAME}@latest`;
}
