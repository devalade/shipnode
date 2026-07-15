import { relative, resolve, sep } from 'path';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { pathExists, ensureDir } from 'fs-extra';
import { ExecaError, execa } from 'execa';
import { Result, type Result as ResultType } from 'better-result';
import { loadConfig } from '../../config/loader.js';
import {
  CiAppTargetRequiredError,
  CiConfigLoadError,
  CiEnvironmentFileNotFoundError,
  CiEnvironmentFileReadError,
  CiEnvironmentNameInvalidError,
  CiEnvironmentSecretTooLargeError,
  GitHubAuthenticationRequiredError,
  GitHubCliUnavailableError,
  GitHubSecretUpdateError,
  UnknownAppError,
} from '../../shared/result-errors.js';
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
      setupAction: 'pnpm/action-setup@v6',
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

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function githubSecretSegment(value: string): string {
  return value
    .toUpperCase()
    .replace(/_/g, '_UNDERSCORE_')
    .replace(/-/g, '_DASH_')
    .replace(/[^A-Z0-9_]/g, '_');
}

function concurrencySegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function parseGitHubEnvironmentName(
  value: string | undefined,
): ResultType<string, CiEnvironmentNameInvalidError> {
  const environment = value ?? 'production';
  if (!environment.trim() || environment !== environment.trim() || /[\u0000-\u001F\u007F]/.test(environment)) {
    return Result.err(new CiEnvironmentNameInvalidError());
  }
  return Result.ok(environment);
}

interface CiGithubOptions {
  app?: string;
  config?: string;
  environment?: string;
  syncEnv?: boolean;
}

interface WorkflowEnvironmentTarget {
  readonly appName: string;
  readonly envFile: string;
  readonly nodeVersion: string;
}

function renderCommandOptions(options: CiGithubOptions): string {
  return [
    ...(options.config ? ['--config', shellSingleQuoted(options.config)] : []),
    ...(options.app ? ['--app', shellSingleQuoted(options.app)] : []),
  ].join(' ');
}

async function resolveWorkflowEnvironmentTarget(
  cwd: string,
  options: CiGithubOptions,
): Promise<ResultType<WorkflowEnvironmentTarget, CiAppSelectionError>> {
  const configResult = await Result.tryPromise({
    try: () => loadConfig(cwd, options.config),
    catch: () => new CiConfigLoadError(),
  });
  if (configResult.isErr()) return configResult;

  if (!options.app && configResult.value.apps.length > 1) {
    return Result.err(new CiAppTargetRequiredError());
  }

  const app = options.app
    ? configResult.value.apps.find((candidate) => candidate.name === options.app)
    : configResult.value.apps[0];
  if (!app) {
    return Result.err(new UnknownAppError({ name: options.app ?? '(default)' }));
  }

  return Result.ok({
    appName: app.name,
    envFile: app.envFile,
    nodeVersion: configResult.value.nodeVersion === 'lts' ? '24' : configResult.value.nodeVersion,
  });
}

function generateWorkflow(
  pm: PkgManagerInfo,
  packageSpec: string,
  deployDirectory?: string,
  options: CiGithubOptions = {},
  envFile?: string,
  nodeVersion = '20',
): string {
  const environment = options.environment ?? 'production';
  const concurrencySuffix = options.app
    ? `${concurrencySegment(environment)}-${concurrencySegment(options.app)}`
    : concurrencySegment(environment);
  const setupPmStep = pm.setupAction
    ? `      - name: Setup ${pm.id}\n        uses: ${pm.setupAction}\n\n`
    : '';

  const stepWorkingDirectory = deployDirectory
    ? `\n        working-directory: ${yamlSingleQuoted(deployDirectory)}`
    : '';
  const commandOptions = renderCommandOptions(options);
  const envSyncSteps = options.syncEnv && envFile && options.app
    ? (() => {
      const secretName = `SHIPNODE_ENV_${githubSecretSegment(environment)}_${githubSecretSegment(options.app)}`;
      const quotedEnvFile = shellSingleQuoted(envFile);
      return `
      - name: Materialize application environment
        env:
          SHIPNODE_ENV_FILE: \${{ secrets.${secretName} }}
        run: |
          [ -n "$SHIPNODE_ENV_FILE" ] || { echo "Missing GitHub Environment secret: ${secretName}" >&2; exit 1; }
          umask 077
          mkdir -p "$(dirname ${quotedEnvFile})"
          printf '%s' "$SHIPNODE_ENV_FILE" > ${quotedEnvFile}${stepWorkingDirectory}

      - name: Upload application environment
        run: shipnode env${commandOptions ? ` ${commandOptions}` : ''} --file ${quotedEnvFile} --no-reload${stepWorkingDirectory}
`;
    })()
    : '';
  const cleanupStep = options.syncEnv && envFile
    ? `
      - name: Remove materialized environment
        if: always()
        run: rm -f ${shellSingleQuoted(envFile)}${stepWorkingDirectory}
`
    : '';

  return `name: Deploy via Shipnode

on:
  push:
    branches:
      - main
      - master
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: shipnode-${concurrencySuffix}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: ${yamlSingleQuoted(environment)}

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: ${yamlSingleQuoted(nodeVersion)}
          cache: '${pm.cacheKey}'

${setupPmStep}      - name: Install dependencies
        run: ${pm.installCmd}

      - name: Setup SSH agent
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: \${{ secrets.SHIPNODE_SSH_KEY }}

      - name: Add server to known hosts
        run: |
          mkdir -p ~/.ssh
          echo "\${{ secrets.SHIPNODE_KNOWN_HOSTS }}" >> ~/.ssh/known_hosts

      - name: Install Shipnode
        run: npm install -g ${packageSpec}
${envSyncSteps}

      - name: Deploy
        run: shipnode deploy${commandOptions ? ` ${commandOptions}` : ''}${stepWorkingDirectory}
${cleanupStep}
`;
}

// ── cmdCiGithub ───────────────────────────────────────────────────────────────

export async function cmdCiGithub(
  cwd: string,
  options: CiGithubOptions = {},
): Promise<void> {
  const environment = parseGitHubEnvironmentName(options.environment);
  if (environment.isErr()) {
    ui.error(environment.error.message);
    process.exitCode = 1;
    return;
  }
  options = { ...options, environment: environment.value };

  const canonicalCwd = await realpath(cwd);
  const repositoryRoot = await resolveRepositoryRoot(canonicalCwd);
  const deployDirectory = relative(repositoryRoot, canonicalCwd).split(sep).join('/') || undefined;
  const pm = await detectPkgManager(repositoryRoot);
  const packageSpec = await currentPackageSpec();
  let workflowOptions = options;
  let envFile: string | undefined;
  let nodeVersion = '20';
  if (options.syncEnv) {
    const target = await resolveWorkflowEnvironmentTarget(canonicalCwd, options);
    if (target.isErr()) {
      ui.error(target.error.message);
      process.exitCode = 1;
      return;
    }
    workflowOptions = { ...options, app: target.value.appName };
    envFile = target.value.envFile;
    nodeVersion = target.value.nodeVersion;
  } else {
    const configFile = resolve(canonicalCwd, options.config ?? 'shipnode.config.ts');
    if (await pathExists(configFile)) {
      const configResult = await Result.tryPromise({
        try: () => loadConfig(canonicalCwd, options.config),
        catch: () => new CiConfigLoadError(),
      });
      if (configResult.isErr()) {
        ui.error(configResult.error.message);
        process.exitCode = 1;
        return;
      }
      nodeVersion = configResult.value.nodeVersion === 'lts' ? '24' : configResult.value.nodeVersion;
    }
  }

  ui.info(`Detected package manager: ${pm.id}`);

  const workflowDir = resolve(repositoryRoot, '.github', 'workflows');
  const workflowPath = resolve(workflowDir, 'shipnode-deploy.yml');

  if (await pathExists(workflowPath)) {
    const overwrite = await confirm(`${workflowPath} already exists. Overwrite?`);
    if (!overwrite) {
      ui.info('Aborted — existing workflow file kept.');
      return;
    }
  }

  await ensureDir(workflowDir);
  const content = generateWorkflow(
    pm,
    packageSpec,
    deployDirectory,
    workflowOptions,
    envFile,
    nodeVersion,
  );
  await writeFile(workflowPath, content, 'utf8');

  ui.success(`Workflow written to .github/workflows/shipnode-deploy.yml`);
  ui.heading('Required GitHub Secrets');
  console.log('  Repository Actions secrets:');
  console.log('');
  console.log('  SHIPNODE_SSH_KEY        Your SSH private key for server access');
  console.log('  SHIPNODE_KNOWN_HOSTS    Known hosts entry for your server');
  console.log('                          (capture outside CI and verify the host fingerprint)');
  if (workflowOptions.syncEnv && workflowOptions.app) {
    const environment = workflowOptions.environment ?? 'production';
    const secretName = `SHIPNODE_ENV_${githubSecretSegment(environment)}_${githubSecretSegment(workflowOptions.app)}`;
    console.log('');
    console.log(`  GitHub Environment secret (${environment}):`);
    console.log(`  ${secretName.padEnd(25)} Complete dotenv file for ${workflowOptions.app}`);
  }
  console.log('');
  console.log('  Note: Host, user, and port are read from shipnode.config.ts (committed to repo).');
  console.log(
    workflowOptions.syncEnv
      ? '  Application env is scoped to the selected GitHub Environment.'
      : '  Application env remains on the VPS and is not copied through GitHub.',
  );
}

async function resolveRepositoryRoot(cwd: string): Promise<string> {
  try {
    const result = await execa('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = result.stdout.trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

async function currentPackageSpec(): Promise<string> {
  const raw = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
  const metadata: unknown = JSON.parse(raw);
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('name' in metadata) ||
    !('version' in metadata) ||
    typeof metadata.name !== 'string' ||
    typeof metadata.version !== 'string'
  ) {
    throw new Error('Shipnode package metadata is missing name or version');
  }
  return `${metadata.name}@${metadata.version}`;
}

// ── cmdCiEnvSync ──────────────────────────────────────────────────────────────

interface CiEnvSyncOptions {
  all?: boolean;
  app?: string;
  config?: string;
  environment?: string;
  file?: string;
  dryRun?: boolean;
}

interface PreparedEnvironmentSecret {
  readonly appName: string;
  readonly content: string;
  readonly environment: string;
  readonly filePath: string;
  readonly secretName: string;
}

const GITHUB_SECRET_MAX_BYTES = 48 * 1024;

type CiAppSelectionError =
  | CiConfigLoadError
  | CiAppTargetRequiredError
  | UnknownAppError;

type CiEnvironmentPreparationError =
  | CiAppSelectionError
  | CiEnvironmentFileNotFoundError
  | CiEnvironmentFileReadError
  | CiEnvironmentSecretTooLargeError;

type GitHubSecretSetError =
  | GitHubCliUnavailableError
  | GitHubAuthenticationRequiredError
  | GitHubSecretUpdateError;

function classifyGitHubSecretFailure(
  cause: unknown,
  secretName: string,
  environment: string,
): GitHubSecretSetError {
  if (cause instanceof ExecaError && cause.code === 'ENOENT') {
    return new GitHubCliUnavailableError();
  }

  const diagnostic = cause instanceof ExecaError
    ? `${cause.stderr ?? ''} ${cause.shortMessage ?? ''}`.toLowerCase()
    : '';
  if (
    diagnostic.includes('gh auth login') ||
    diagnostic.includes('not logged') ||
    diagnostic.includes('authentication')
  ) {
    return new GitHubAuthenticationRequiredError();
  }

  return new GitHubSecretUpdateError({ secretName, environment });
}

async function prepareEnvironmentSecret(
  cwd: string,
  options: CiEnvSyncOptions,
): Promise<ResultType<PreparedEnvironmentSecret, CiEnvironmentPreparationError>> {
  const configResult = await Result.tryPromise({
    try: () => loadConfig(cwd, options.config),
    catch: () => new CiConfigLoadError(),
  });
  if (configResult.isErr()) return configResult;

  if (!options.app && configResult.value.apps.length > 1) {
    return Result.err(new CiAppTargetRequiredError());
  }

  const app = options.app
    ? configResult.value.apps.find((candidate) => candidate.name === options.app)
    : configResult.value.apps[0];
  if (!app) {
    return Result.err(new UnknownAppError({ name: options.app ?? '(default)' }));
  }

  const environment = options.environment ?? 'production';
  const filePath = options.file ?? app.envFile;
  const absoluteFilePath = resolve(cwd, filePath);
  if (!(await pathExists(absoluteFilePath))) {
    return Result.err(new CiEnvironmentFileNotFoundError({ path: filePath }));
  }

  const contentResult = await Result.tryPromise({
    try: () => readFile(absoluteFilePath, 'utf8'),
    catch: (cause) => new CiEnvironmentFileReadError({ path: filePath, cause }),
  });
  if (contentResult.isErr()) return contentResult;
  const contentBytes = Buffer.byteLength(contentResult.value, 'utf8');
  if (contentBytes > GITHUB_SECRET_MAX_BYTES) {
    return Result.err(new CiEnvironmentSecretTooLargeError({
      actualBytes: contentBytes,
      maximumBytes: GITHUB_SECRET_MAX_BYTES,
    }));
  }

  return Result.ok({
    appName: app.name,
    content: contentResult.value,
    environment,
    filePath,
    secretName: `SHIPNODE_ENV_${githubSecretSegment(environment)}_${githubSecretSegment(app.name)}`,
  });
}

async function setGitHubEnvironmentSecret(
  prepared: PreparedEnvironmentSecret,
): Promise<ResultType<void, GitHubSecretSetError>> {
  return Result.tryPromise({
    try: async () => {
      await execa(
        'gh',
        ['secret', 'set', prepared.secretName, '--env', prepared.environment],
        { input: prepared.content },
      );
    },
    catch: (cause) => classifyGitHubSecretFailure(
      cause,
      prepared.secretName,
      prepared.environment,
    ),
  });
}

export async function cmdCiEnvSync(
  cwd: string,
  options: CiEnvSyncOptions,
): Promise<void> {
  const environment = parseGitHubEnvironmentName(options.environment);
  if (environment.isErr()) {
    ui.error(environment.error.message);
    process.exitCode = 1;
    return;
  }
  options = { ...options, environment: environment.value };

  const prepared = await prepareEnvironmentSecret(cwd, options);
  if (prepared.isErr()) {
    ui.error(prepared.error.message);
    process.exitCode = 1;
    return;
  }

  ui.info(`Source: ${prepared.value.filePath}`);
  ui.info(`App: ${prepared.value.appName}`);
  ui.info(`GitHub Environment: ${prepared.value.environment}`);
  ui.info(`Secret: ${prepared.value.secretName}`);

  if (options.dryRun) {
    ui.success('Dry run complete — no GitHub secret was changed.');
    return;
  }

  if (!options.all) {
    const proceed = await confirm(`Sync the complete environment file to ${prepared.value.secretName}?`);
    if (!proceed) {
      ui.info('Sync cancelled.');
      return;
    }
  }

  const result = await setGitHubEnvironmentSecret(prepared.value);
  if (result.isErr()) {
    ui.error(result.error.message);
    process.exitCode = 1;
    return;
  }

  ui.success(`Set ${prepared.value.secretName} in ${prepared.value.environment}.`);
}
