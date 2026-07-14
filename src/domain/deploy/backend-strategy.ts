import { execa } from 'execa';
import { pathExists } from 'fs-extra';
import { resolve } from 'path';
import type { ShipnodeConfig, ShipnodeApp, Pm2App, PkgManager } from '../../shared/types.js';
import { getPm2Name } from '../pm2/apps.js';
import { coloredWebName } from './blue-green.js';
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
    private workspace: ShipnodeConfig,
    private app: ShipnodeApp,
    private cwd: string,
  ) {}

  private get appPath(): string {
    return `${this.workspace.remotePath}/${this.app.name}`;
  }

  async stage(ctx: StrategyContext): Promise<void> {
    const excludes = [...RSYNC_DEFAULT_EXCLUDES];
    const ignoreFile = resolve(this.cwd, '.shipnodeignore');
    const hasIgnoreFile = await pathExists(ignoreFile);

    const args = [
      '-avz',
      '--progress',
      '-e', `ssh -p ${this.workspace.ssh.port}`,
      ...excludes.flatMap((e) => ['--exclude', e]),
      ...(hasIgnoreFile ? ['--exclude-from', ignoreFile] : []),
      `${this.cwd}/`,
      `${this.workspace.ssh.user}@${this.workspace.ssh.host}:${ctx.workDir}/`,
    ];

    await execa('rsync', args, { stdio: 'inherit' });
  }

  async setupEnvironment(ctx: StrategyContext): Promise<void> {
    const pkgManager = await this.resolvePkgManager();
    const installCmd = this.workspace.installCommand ?? getInstallCommand(pkgManager);
    const runCmd = getRunCommand(pkgManager);

    const commands = [
      `cd "${ctx.workDir}"`,
      `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`,
      `mise use -y "node@${this.workspace.nodeVersion}"`,
      `mise install -y`,
    ];

    if (this.app.sharedDirs || this.app.sharedFiles) {
      commands.push(this.getLinkSharedResourcesCommand(ctx.workDir));
    }

    if (this.app.envFile) {
      // Use the configured env filename in the shared path; the local workDir
      // alias stays `.env` (the well-known name framework loaders look for).
      commands.push(`ln -sf "${this.appPath}/shared/${this.app.envFile}" .env`);
      // Source it so install/build see env vars (private-registry tokens in
      // `.npmrc` via `${TOKEN}`, build-time secrets, etc.). Affects this shell
      // chain only; the PM2 wrapper sources independently at process start.
      const sourceCmd = sourceEnvCommand(this.app.envFile);
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
    if (!this.app.pm2) return;

    const pkgManager = await this.resolvePkgManager();
    const cdPath = `${this.appPath}/current`;
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

    if (this.app.zeroDowntime && ctx.deployTarget) {
      await this.startBlueGreen(ctx, pkgManager, cdPath, mise);
      return;
    }

    await this.startRecreate(ctx, pkgManager, cdPath, mise);
  }

  /**
   * Default strategy: stop the whole process set and start the new release.
   * Drops in-flight requests during the boot window — use `zeroDowntime` to
   * avoid that.
   */
  private async startRecreate(
    ctx: StrategyContext,
    pkgManager: PkgManager,
    cdPath: string,
    mise: string,
  ): Promise<void> {
    const ecosystemContent = this.generateEcosystemFile(pkgManager);
    // Ecosystem lives inside the release directory (per-release snapshot, ADR-0001).
    // PM2 references it via the `current` symlink so it always resolves to the active release.
    const ecosystemWritePath = `${ctx.workDir}/ecosystem.config.cjs`;
    const ecosystemRuntimePath = `${this.appPath}/current/ecosystem.config.cjs`;

    await this.writeEcosystem(ctx, ecosystemWritePath, ecosystemContent);

    await this.relinkPackages(ctx, pkgManager, cdPath, mise);

    // Silent legacy-name fallback: previous deploys (pre multi-process) started a single
    // PM2 app by its name, not from an ecosystem file. `pm2 delete <ecosystem>` won't find
    // those, so we also delete by the first app's name. After one deploy this is a no-op
    // forever. See ADR-0002 and the migration note in the design (Q10).
    const firstAppName = this.app.pm2!.apps[0].name;
    const webApp = this.app.pm2!.apps.find((a) => a.port !== undefined);
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

  /**
   * Blue-green strategy: boot the idle colour on its own port without touching
   * the colour currently serving traffic. The orchestrator health-checks the
   * new colour, then calls `afterHealthy` to reload workers, then flips Caddy.
   * See blue-green.ts.
   *
   * The web app is duplicated per-colour; workers are a single set (duplicating
   * a worker would double-process its queue). Workers wait until after health
   * so a bad release does not leave them on the new code.
   */
  private async startBlueGreen(
    ctx: StrategyContext,
    pkgManager: PkgManager,
    cdPath: string,
    mise: string,
  ): Promise<void> {
    const target = ctx.deployTarget;
    const pm2 = this.app.pm2;
    if (!target || !pm2) {
      throw new Error('Blue-green start requires a deploy target and PM2 configuration');
    }
    const namespace = pm2.apps[0].name;
    // Guaranteed by schema: zeroDowntime requires a web app (one pm2 app with a port).
    const webApp = pm2.apps.find((app) => app.port !== undefined);
    if (!webApp) {
      throw new Error('Blue-green start requires one PM2 app with a port');
    }
    const workers = pm2.apps.filter((a) => a.port === undefined);
    const coloredName = coloredWebName(namespace, webApp.name, target.color);

    // Web ecosystem: just the web app, coloured name, target-colour port.
    const webEco = this.generateEcosystemForApps([webApp], pkgManager, (a) =>
      a.name === webApp.name ? { nameSuffix: `-${target.color}`, portOverride: target.port } : {},
    );
    const webRuntimePath = `${this.appPath}/current/ecosystem.web.cjs`;
    await this.writeEcosystem(ctx, `${ctx.workDir}/ecosystem.web.cjs`, webEco);

    // Write workers ecosystem now so afterHealthy can reload it; do not start yet.
    if (workers.length > 0) {
      const workersEco = this.generateEcosystemForApps(workers, pkgManager);
      await this.writeEcosystem(ctx, `${ctx.workDir}/ecosystem.workers.cjs`, workersEco);
    }

    await this.relinkPackages(ctx, pkgManager, cdPath, mise);

    // Reap any stale same-colour instance (from two deploys ago; serving nothing),
    // then guard the target port against a genuine foreign conflict.
    const reapTarget = `{ mise exec -- pm2 delete "${coloredName}" 2>/dev/null || true; } && `;
    const portGuard = `{ ss -tlnp | grep -q ":${target.port} " && echo "Port ${target.port} is already in use by another process" && false || true; } && `;

    await ctx.executor.execOrThrow(
      `cd "${cdPath}" && ${mise} && ` +
      reapTarget +
      portGuard +
      `mise exec -- pm2 start "${webRuntimePath}" --update-env && ` +
      `mise exec -- pm2 save`,
    );
  }

  /**
   * Reload the single worker set against the healthy release. No-op when
   * zero-downtime is off or there are no workers.
   */
  async afterHealthy(ctx: StrategyContext): Promise<void> {
    if (!this.app.zeroDowntime || !ctx.deployTarget || !this.app.pm2) return;

    const workers = this.app.pm2.apps.filter((a) => a.port === undefined);
    if (workers.length === 0) return;

    const cdPath = `${this.appPath}/current`;
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    const workersRuntimePath = `${this.appPath}/current/ecosystem.workers.cjs`;

    await ctx.executor.execOrThrow(
      `cd "${cdPath}" && ${mise} && ` +
      `{ mise exec -- pm2 reload "${workersRuntimePath}" --update-env 2>/dev/null || mise exec -- pm2 start "${workersRuntimePath}" --update-env; } && ` +
      `mise exec -- pm2 save`,
    );
  }

  /** Remove a pre-blue-green process only once Caddy serves the green release. */
  async afterTrafficSwitch(ctx: StrategyContext): Promise<void> {
    if (!this.app.zeroDowntime || !ctx.deployTarget || !this.app.pm2) return;
    if (ctx.deployTarget.previousColor !== null) return;

    const namespace = this.app.pm2.apps[0].name;
    const webApp = this.app.pm2.apps.find((app) => app.port !== undefined);
    if (!webApp) return;

    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    await ctx.executor.execOrThrow(
      `${mise} && ` +
      `{ mise exec -- pm2 delete "${getPm2Name(namespace, webApp.name)}" 2>/dev/null || true; } && ` +
      `mise exec -- pm2 save`,
    );
  }

  private async writeEcosystem(ctx: StrategyContext, writePath: string, content: string): Promise<void> {
    const escaped = content.replace(/'/g, "'\"'\"'");
    await ctx.executor.execOrThrow(`echo '${escaped}' > "${writePath}"`);
  }

  /**
   * Re-run install from the final directory so the pkg manager's module
   * resolution state matches the path PM2 will use. Packages are already in the
   * local store so this is a fast offline relink, not a download. A custom
   * installCommand is used verbatim — appending --prefer-offline would compose
   * poorly with the user's chosen flags.
   */
  private async relinkPackages(
    ctx: StrategyContext,
    pkgManager: PkgManager,
    cdPath: string,
    mise: string,
  ): Promise<void> {
    const baseInstall = this.workspace.installCommand ?? getInstallCommand(pkgManager);
    const relinkInstall = this.workspace.installCommand ? baseInstall : `${baseInstall} --prefer-offline`;
    // Source env before relinking — private-registry tokens in `.npmrc` use
    // env-var interpolation.
    const sourceCmd = sourceEnvCommand(this.app.envFile);
    const sourceStep = sourceCmd ? `${sourceCmd} && ` : '';
    const installResult = await ctx.executor.exec(
      `cd "${cdPath}" && ${mise} && ${sourceStep}${relinkInstall}`,
    );
    this.assertNoBuildScriptsIgnored(pkgManager, installResult);
    if (installResult.exitCode !== 0) {
      const detail = (installResult.stderr || installResult.stdout).trim();
      throw new DeployError(detail || 'Package relink failed', 'start');
    }
  }

  private generateEcosystemFile(pkgManager: string): string {
    if (!this.app.pm2) return '';
    return this.generateEcosystemForApps(this.app.pm2.apps, pkgManager);
  }

  /**
   * Render an ecosystem file for a subset of the declared pm2 apps.
   *
   * `perApp` lets blue-green override the name (colour suffix) and port for the
   * web app while leaving workers untouched. The namespace is always the first
   * declared app's name so `pm2 list` grouping is stable across colours.
   */
  private generateEcosystemForApps(
    apps: Pm2App[],
    pkgManager: string,
    perApp: (app: Pm2App) => { nameSuffix?: string; portOverride?: number } = () => ({}),
  ): string {
    if (!this.app.pm2) return '';

    const namespace = this.app.pm2.apps[0].name;
    const envFilePath = `${this.appPath}/shared/${this.app.envFile}`;
    const appBlocks = apps.map((app) =>
      this.generateAppBlock(app, pkgManager, namespace, envFilePath, perApp(app)),
    );

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
  private generateAppBlock(
    app: Pm2App,
    pkgManager: string,
    namespace: string,
    envFilePath: string,
    opts: { nameSuffix?: string; portOverride?: number } = {},
  ): string {
    const { script: origScript, args: origArgs } = parseCommand(app.command, pkgManager);
    const instances = app.instances ?? 1;
    const maxMemory = app.maxMemory ?? '512M';

    const port = opts.portOverride ?? app.port;
    const env: Record<string, string | number> = { NODE_ENV: 'production' };
    if (port !== undefined) env.PORT = port;
    for (const [k, v] of Object.entries(app.env ?? {})) env[k] = v;

    const envLines = Object.entries(env)
      .map(([k, v]) => `      ${k}: ${typeof v === 'number' ? v : `'${escapeSingleQuotes(String(v))}'`},`)
      .join('\n');

    const pm2Name = `${getPm2Name(namespace, app.name)}${opts.nameSuffix ?? ''}`;

    const useWrapper = Boolean(this.app.envFile);
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
    const cwdLine = this.app.appRoot
      ? `\n      cwd: '${escapeSingleQuotes(`${this.appPath}/current/${this.app.appRoot}`)}',`
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
    if (!this.app.envFile) return 'true';
    const targets: string[] = [];
    if (this.app.appRoot) {
      targets.push(`${this.app.appRoot}/build`, `${this.app.appRoot}/dist`);
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

    if (this.app.sharedDirs) {
      for (const dir of this.app.sharedDirs) {
        commands.push(`mkdir -p "${this.appPath}/shared/${dir}"`);
        commands.push(`ln -sfn "${this.appPath}/shared/${dir}" "${workDir}/${dir}"`);
      }
    }

    if (this.app.sharedFiles) {
      for (const file of this.app.sharedFiles) {
        commands.push(`ln -sf "${this.appPath}/shared/${file}" "${workDir}/${file}"`);
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
    if (this.workspace.pkgManager) return this.workspace.pkgManager;
    const detected = await detectPkgManager(this.cwd);
    return detected ?? 'npm';
  }
}
