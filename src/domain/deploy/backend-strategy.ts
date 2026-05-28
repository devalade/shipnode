import { execa } from 'execa';
import { pathExists } from 'fs-extra';
import { resolve } from 'path';
import type { ShipnodeConfig, Pm2App } from '../../shared/types.js';
import { getDeploymentName, getPm2Name } from '../pm2/apps.js';
import { getInstallCommand, getRunCommand, detectPkgManager } from '../framework/detector.js';
import { RSYNC_DEFAULT_EXCLUDES } from '../../shared/constants.js';
import { DeployError } from '../../shared/errors.js';
import type { DeploymentStrategy, StrategyContext } from './strategy.js';

function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "\\'");
}

// Q5: `command` is shell-style — split on whitespace into script + args.
// Omitted command falls back to `<pkgManager> start` (the pre-multi-process default).
function parseCommand(command: string | undefined, pkgManager: string): { script: string; args: string } {
  if (!command) return { script: pkgManager, args: 'start' };
  const parts = command.trim().split(/\s+/);
  return { script: parts[0], args: parts.slice(1).join(' ') };
}

/**
 * Shell snippet that sources the workDir-local `.env` into the current shell
 * so subsequent && commands inherit the variables. Returns empty string when
 * the project has no envFile so callers can interpolate it unconditionally.
 *
 * Used during install, build, and post-symlink relink. The PM2 wrapper takes
 * the same approach (see generateAppBlock) but sources `<shared>/<envFile>`
 * directly — it doesn't depend on the workDir symlink.
 */
function sourceEnvCommand(envFile: string | undefined): string {
  if (!envFile) return '';
  return `set -a && . ./.env && set +a`;
}

export class BackendStrategy implements DeploymentStrategy {
  readonly name = 'backend';

  constructor(
    private config: ShipnodeConfig,
    private cwd: string,
  ) {}

  async stage(ctx: StrategyContext): Promise<void> {
    const excludes = [...RSYNC_DEFAULT_EXCLUDES];
    const ignoreFile = resolve(this.cwd, '.shipnodeignore');
    const hasIgnoreFile = await pathExists(ignoreFile);

    const args = [
      '-avz',
      '--progress',
      '-e', `ssh -p ${this.config.ssh.port}`,
      ...excludes.flatMap((e) => ['--exclude', e]),
      ...(hasIgnoreFile ? ['--exclude-from', ignoreFile] : []),
      `${this.cwd}/`,
      `${this.config.ssh.user}@${this.config.ssh.host}:${ctx.workDir}/`,
    ];

    await execa('rsync', args, { stdio: 'inherit' });
  }

  async setupEnvironment(ctx: StrategyContext): Promise<void> {
    const pkgManager = await this.resolvePkgManager();
    const installCmd = this.config.installCommand ?? getInstallCommand(pkgManager);
    const runCmd = getRunCommand(pkgManager);

    const commands = [
      `cd "${ctx.workDir}"`,
      `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`,
      `mise use -y "node@${this.config.nodeVersion}"`,
      `mise install -y`,
    ];

    if (this.config.sharedDirs || this.config.sharedFiles) {
      commands.push(this.getLinkSharedResourcesCommand(ctx.workDir));
    }

    if (this.config.envFile) {
      // Use the configured env filename in the shared path; the local workDir
      // alias stays `.env` (the well-known name framework loaders look for).
      commands.push(`ln -sf "${this.config.remotePath}/shared/${this.config.envFile}" .env`);
      // Source it so install/build see env vars (private-registry tokens in
      // `.npmrc` via `${TOKEN}`, build-time secrets, etc.). Affects this shell
      // chain only; the PM2 wrapper sources independently at process start.
      const sourceCmd = sourceEnvCommand(this.config.envFile);
      if (sourceCmd) commands.push(sourceCmd);
    }

    // Ensure third-party package managers are available on the remote
    if (pkgManager === 'pnpm') {
      commands.push(`command -v pnpm &>/dev/null || npm install -g pnpm`);
    } else if (pkgManager === 'yarn') {
      commands.push(`command -v yarn &>/dev/null || npm install -g yarn`);
    } else if (pkgManager === 'bun') {
      commands.push(`command -v bun &>/dev/null || npm install -g bun`);
    }

    commands.push(installCmd);

    if (!ctx.skipBuild) {
      commands.push(`if [ -f package.json ] && jq -e '.scripts.build' package.json >/dev/null 2>&1; then ${runCmd} build; fi`);
    }

    // Symlink `.env` into compiled-output directories so frameworks whose env
    // loaders resolve relative to the *built app root* (AdonisJS, NestJS) find
    // it. Three sources, in order of trust:
    //   1. `appRoot` config — explicit user declaration for monorepos
    //   2. repo-root `build` / `dist` — the single-app convention
    //   3. obvious monorepo layouts: `apps/*/build`, `packages/*/build`, dist twins
    // We never traverse into node_modules and never overwrite an existing
    // `.env` file.
    commands.push(this.getEnvSymlinkCommand(ctx.workDir));

    const installResult = await ctx.executor.exec(commands.join(' && '));
    this.assertNoBuildScriptsIgnored(pkgManager, installResult);
    if (installResult.exitCode !== 0) {
      const detail = (installResult.stderr || installResult.stdout).trim();
      throw new DeployError(detail || 'Install/build failed', 'install');
    }
  }

  async startApp(ctx: StrategyContext): Promise<void> {
    if (!this.config.pm2) return;

    const pkgManager = await this.resolvePkgManager();
    const ecosystemContent = this.generateEcosystemFile(pkgManager);
    // Ecosystem lives inside the release directory (per-release snapshot, ADR-0001).
    // PM2 references it via the `current` symlink so it always resolves to the active release.
    const ecosystemWritePath = `${ctx.workDir}/ecosystem.config.cjs`;
    const ecosystemRuntimePath = `${this.config.remotePath}/current/ecosystem.config.cjs`;

    const escaped = ecosystemContent.replace(/'/g, "'\"'\"'");
    await ctx.executor.execOrThrow(`echo '${escaped}' > "${ecosystemWritePath}"`);

    const cdPath = `${this.config.remotePath}/current`;
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

    // Re-run install from the final directory so the pkg manager's module
    // resolution state matches the path PM2 will use. Packages are already
    // in the local store so this is a fast offline relink, not a download.
    // If the user supplied a custom installCommand we use it verbatim — they've
    // chosen their flags and appending --prefer-offline would compose poorly.
    const baseInstall = this.config.installCommand ?? getInstallCommand(pkgManager);
    const relinkInstall = this.config.installCommand ? baseInstall : `${baseInstall} --prefer-offline`;
    // Source env before relinking too — same reason as setupEnvironment:
    // private-registry tokens in `.npmrc` use env-var interpolation.
    const sourceCmd = sourceEnvCommand(this.config.envFile);
    const sourceStep = sourceCmd ? `${sourceCmd} && ` : '';
    const installResult = await ctx.executor.exec(
      `cd "${cdPath}" && ${mise} && ${sourceStep}${relinkInstall}`,
    );
    this.assertNoBuildScriptsIgnored(pkgManager, installResult);
    if (installResult.exitCode !== 0) {
      const detail = (installResult.stderr || installResult.stdout).trim();
      throw new DeployError(detail || 'Package relink failed', 'start');
    }

    // Silent legacy-name fallback: previous deploys (pre multi-process) started a single
    // PM2 app by its name, not from an ecosystem file. `pm2 delete <ecosystem>` won't find
    // those, so we also delete by the first app's name. After one deploy this is a no-op
    // forever. See ADR-0002 and the migration note in the design (Q10).
    const firstAppName = this.config.pm2.apps[0].name;
    const webApp = this.config.pm2.apps.find((a) => a.port !== undefined);
    const portGuard = webApp
      ? `{ ss -tlnp | grep -q ":${webApp.port} " && echo "Port ${webApp.port} is already in use by another process" && false || true; } && `
      : '';

    await ctx.executor.execOrThrow(
      `cd "${cdPath}" && ${mise} && ` +
      `{ mise exec -- pm2 delete "${ecosystemRuntimePath}" 2>/dev/null || true; } && ` +
      `{ mise exec -- pm2 delete "${firstAppName}" 2>/dev/null || true; } && ` +
      portGuard +
      `mise exec -- pm2 start "${ecosystemRuntimePath}" --update-env && ` +
      `mise exec -- pm2 save`,
    );
  }

  private generateEcosystemFile(pkgManager: string): string {
    if (!this.config.pm2) return '';

    const namespace = getDeploymentName(this.config) ?? this.config.pm2.apps[0].name;
    const envFilePath = `${this.config.remotePath}/shared/${this.config.envFile}`;
    const appBlocks = this.config.pm2.apps.map((app) => this.generateAppBlock(app, pkgManager, namespace, envFilePath));

    return `module.exports = {
  apps: [
${appBlocks.join(',\n')}
  ],
};`;
  }

  /**
   * Render one PM2 ecosystem entry.
   *
   * We deliberately avoid PM2's `env_file` option (unreliable in PM2 7.x — see
   * ADR-0003) and wrap the user's command in `bash -c` that sources the shared
   * env file before `exec`ing the real script. `args` is emitted as an array
   * to avoid PM2 word-splitting the wrapped command on whitespace.
   */
  private generateAppBlock(app: Pm2App, pkgManager: string, namespace: string, envFilePath: string): string {
    const { script: origScript, args: origArgs } = parseCommand(app.command, pkgManager);
    const instances = app.instances ?? 1;
    const maxMemory = app.maxMemory ?? '512M';

    const env: Record<string, string | number> = { NODE_ENV: 'production' };
    if (app.port !== undefined) env.PORT = app.port;
    for (const [k, v] of Object.entries(app.env ?? {})) env[k] = v;

    const envLines = Object.entries(env)
      .map(([k, v]) => `      ${k}: ${typeof v === 'number' ? v : `'${escapeSingleQuotes(String(v))}'`},`)
      .join('\n');

    const pm2Name = getPm2Name(namespace, app.name);

    const useWrapper = Boolean(this.config.envFile);
    let scriptLine: string;
    let argsLine: string;

    if (useWrapper) {
      const tail = origArgs ? `${origScript} ${origArgs}` : origScript;
      const inner = `set -a && . '${escapeSingleQuotes(envFilePath)}' && set +a && exec ${tail}`;
      scriptLine = `script: 'bash',`;
      argsLine = `\n      args: ['-c', '${escapeSingleQuotes(inner)}'],`;
    } else {
      scriptLine = `script: '${escapeSingleQuotes(origScript)}',`;
      argsLine = origArgs ? `\n      args: '${escapeSingleQuotes(origArgs)}',` : '';
    }

    // When appRoot is set, launch the process from that subdir so e.g.
    // `pnpm start` reads `<appRoot>/package.json`'s start script and Node
    // resolves require paths against the app, not the workspace root.
    // Install/build still run at the workspace root.
    const cwdLine = this.config.appRoot
      ? `\n      cwd: '${escapeSingleQuotes(`${this.config.remotePath}/current/${this.config.appRoot}`)}',`
      : '';

    return `    {
      name: '${escapeSingleQuotes(pm2Name)}',
      namespace: '${escapeSingleQuotes(namespace)}',
      ${scriptLine}${argsLine}${cwdLine}
      instances: ${instances},
      exec_mode: 'fork',
      max_memory_restart: '${maxMemory}',
      env: {
${envLines}
      },
    }`;
  }

  private getEnvSymlinkCommand(workDir: string): string {
    if (!this.config.envFile) return 'true';
    const targets: string[] = [];
    if (this.config.appRoot) {
      targets.push(`${this.config.appRoot}/build`, `${this.config.appRoot}/dist`);
    }
    // Always include the single-app convention.
    targets.push('build', 'dist');
    const explicit = targets.map((t) => `"${t}"`).join(' ');
    // Wrapped in `{ ...; } || true` so projects without a `.env` file or with
    // no matching build dirs don't break the install/build chain.
    // `nullglob` makes `apps/*/build` collapse to nothing when there's no match.
    return (
      `{ [ -f .env ] && shopt -s nullglob && ` +
      `for dir in ${explicit} apps/*/build packages/*/build apps/*/dist packages/*/dist; do ` +
      `if [ -d "$dir" ] && [ ! -e "$dir/.env" ]; then ln -sf "${workDir}/.env" "$dir/.env"; fi; ` +
      `done; shopt -u nullglob; } || true`
    );
  }

  private getLinkSharedResourcesCommand(workDir: string): string {
    const commands: string[] = [];

    if (this.config.sharedDirs) {
      for (const dir of this.config.sharedDirs) {
        commands.push(`mkdir -p "${this.config.remotePath}/shared/${dir}"`);
        commands.push(`ln -sfn "${this.config.remotePath}/shared/${dir}" "${workDir}/${dir}"`);
      }
    }

    if (this.config.sharedFiles) {
      for (const file of this.config.sharedFiles) {
        commands.push(`ln -sf "${this.config.remotePath}/shared/${file}" "${workDir}/${file}"`);
      }
    }

    return commands.join(' && ');
  }

  private assertNoBuildScriptsIgnored(pkgManager: string, result: { stdout: string; stderr: string }): void {
    if (pkgManager !== 'pnpm') return;
    const output = result.stdout + result.stderr;
    if (!output.includes('ERR_PNPM_IGNORED_BUILDS')) return;
    const match = output.match(/Ignored build scripts: ([^\n]+)/);
    const packages = match ? match[1].trim() : 'native modules';
    throw new DeployError(
      `pnpm skipped build scripts for: ${packages}\n` +
      `These packages need postinstall to compile native addons or generate clients (Prisma, bcrypt, etc.).\n` +
      `Fix: run "pnpm approve-builds" in your project, commit the result, then redeploy.`,
      'install',
    );
  }

  private async resolvePkgManager() {
    if (this.config.pkgManager) return this.config.pkgManager;
    const detected = await detectPkgManager(this.cwd);
    return detected ?? 'npm';
  }
}
