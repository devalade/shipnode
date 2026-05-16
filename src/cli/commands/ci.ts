import { resolve } from 'path';
import { readFile, writeFile } from 'node:fs/promises';
import { pathExists, ensureDir } from 'fs-extra';
import { execa } from 'execa';
import { loadConfig } from '../../config/loader.js';
import { confirm } from '../prompt.js';
import { ui } from '../ui.js';

// ── Package manager detection ─────────────────────────────────────────────────

type PkgManagerId = 'pnpm' | 'yarn' | 'bun' | 'npm';

interface PkgManagerInfo {
  id: PkgManagerId;
  cacheKey: string;
  setupAction: string;
  installCmd: string;
}

async function detectPkgManager(cwd: string): Promise<PkgManagerInfo> {
  if (await pathExists(resolve(cwd, 'pnpm-lock.yaml'))) {
    return {
      id: 'pnpm',
      cacheKey: 'pnpm',
      setupAction: 'pnpm/action-setup@v4',
      installCmd: 'pnpm install --frozen-lockfile',
    };
  }
  if (await pathExists(resolve(cwd, 'yarn.lock'))) {
    return {
      id: 'yarn',
      cacheKey: 'yarn',
      setupAction: '',
      installCmd: 'yarn install --frozen-lockfile',
    };
  }
  if (await pathExists(resolve(cwd, 'bun.lockb'))) {
    return {
      id: 'bun',
      cacheKey: 'bun',
      setupAction: 'oven-sh/setup-bun@v2',
      installCmd: 'bun install',
    };
  }
  return {
    id: 'npm',
    cacheKey: 'npm',
    setupAction: '',
    installCmd: 'npm ci',
  };
}

async function hasBuildScript(cwd: string): Promise<boolean> {
  const pkgPath = resolve(cwd, 'package.json');
  if (!(await pathExists(pkgPath))) return false;
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
}

function generateWorkflow(pm: PkgManagerInfo, withBuild: boolean): string {
  const setupPmStep = pm.setupAction
    ? `      - name: Setup ${pm.id}\n        uses: ${pm.setupAction}\n\n`
    : '';

  const buildStep = withBuild
    ? `\n      - name: Build\n        run: ${pm.id} run build\n`
    : '';

  return `name: Deploy via Shipnode

on:
  push:
    branches:
      - main
      - master
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: '${pm.cacheKey}'

${setupPmStep}      - name: Install dependencies
        run: ${pm.installCmd}
${buildStep}
      - name: Setup SSH agent
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: \${{ secrets.SHIPNODE_SSH_KEY }}

      - name: Add server to known hosts
        run: |
          mkdir -p ~/.ssh
          echo "\${{ secrets.SHIPNODE_KNOWN_HOSTS }}" >> ~/.ssh/known_hosts

      - name: Install Shipnode
        run: npm install -g shipnode

      - name: Deploy
        run: shipnode deploy
`;
}

// ── cmdCiGithub ───────────────────────────────────────────────────────────────

export async function cmdCiGithub(cwd: string): Promise<void> {
  const pm = await detectPkgManager(cwd);
  const withBuild = await hasBuildScript(cwd);

  ui.info(`Detected package manager: ${pm.id}`);
  if (withBuild) {
    ui.info('Found scripts.build in package.json — build step will be included.');
  }

  const workflowDir = resolve(cwd, '.github', 'workflows');
  const workflowPath = resolve(workflowDir, 'shipnode-deploy.yml');

  if (await pathExists(workflowPath)) {
    const overwrite = await confirm(`${workflowPath} already exists. Overwrite?`);
    if (!overwrite) {
      ui.info('Aborted — existing workflow file kept.');
      return;
    }
  }

  await ensureDir(workflowDir);
  const content = generateWorkflow(pm, withBuild);
  await writeFile(workflowPath, content, 'utf8');

  ui.success(`Workflow written to .github/workflows/shipnode-deploy.yml`);
  ui.heading('Required GitHub Secrets');
  console.log('  Add the following secrets in your GitHub repository settings:');
  console.log('  (Settings → Secrets and variables → Actions → New repository secret)');
  console.log('');
  console.log('  SHIPNODE_SSH_KEY        Your SSH private key for server access');
  console.log('  SHIPNODE_KNOWN_HOSTS    Known hosts entry for your server');
  console.log('                          (run: ssh-keyscan -H YOUR_HOST)');
  console.log('');
  console.log('  Note: Host, user, and port are read from shipnode.config.ts (committed to repo).');
  console.log('  Only the private key must be kept as a secret.');
}

// ── cmdCiEnvSync ──────────────────────────────────────────────────────────────

interface EnvVar {
  key: string;
  value: string;
}

function parseEnvFile(content: string): EnvVar[] {
  const vars: EnvVar[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) vars.push({ key, value });
  }
  return vars;
}

async function setGhSecret(key: string, value: string): Promise<boolean> {
  try {
    await execa('gh', ['secret', 'set', key, '--body', value]);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('command not found') || msg.includes('ENOENT')) {
      throw new Error(
        'GitHub CLI (gh) not found. Install it from https://cli.github.com/ and authenticate with `gh auth login`.',
      );
    }
    return false;
  }
}

export async function cmdCiEnvSync(
  cwd: string,
  options: { all?: boolean },
): Promise<void> {
  const config = await loadConfig(cwd, undefined);

  const envPath = resolve(cwd, config.envFile);
  if (!(await pathExists(envPath))) {
    ui.error(`Env file not found: ${config.envFile}`);
    process.exit(1);
  }

  const content = await readFile(envPath, 'utf8');
  const envVars = parseEnvFile(content);

  if (envVars.length === 0) {
    ui.warn('No variables found in env file.');
  } else if (!options.all) {
    console.log('\nVariables to sync from env file:');
    for (const { key } of envVars) {
      console.log(`  ${key}`);
    }
    console.log('');
    const proceed = await confirm(`Sync ${envVars.length} variable(s) to GitHub Secrets?`);
    if (!proceed) {
      ui.info('Sync cancelled.');
      return;
    }
  }

  let set = 0;
  let failed = 0;

  // Sync env file vars
  for (const { key, value } of envVars) {
    const ok = await setGhSecret(key, value);
    if (ok) {
      ui.success(`Set: ${key}`);
      set++;
    } else {
      ui.warn(`Failed: ${key}`);
      failed++;
    }
  }

  // Sync Shipnode connection vars from config
  const shipnodeSecrets: EnvVar[] = [
    { key: 'SHIPNODE_SSH_HOST', value: config.ssh.host },
    { key: 'SHIPNODE_SSH_USER', value: config.ssh.user },
    { key: 'SHIPNODE_SSH_PORT', value: String(config.ssh.port) },
  ];

  ui.info('Syncing Shipnode connection secrets...');
  for (const { key, value } of shipnodeSecrets) {
    const ok = await setGhSecret(key, value);
    if (ok) {
      ui.success(`Set: ${key}`);
      set++;
    } else {
      ui.warn(`Failed: ${key}`);
      failed++;
    }
  }

  ui.heading('Sync Summary');
  ui.info(`Set: ${set}  Skipped: 0  Failed: ${failed}`);
}
