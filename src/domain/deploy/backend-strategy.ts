import chalk from 'chalk';
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
import { runWithDotenv } from './dotenv.js';
import { envSymlinkCommand } from './env-links.js';
import {
  WATT_APP_FILE, WATT_RUNTIME_FILE, WATT_START_COMMAND,
  installUnitCommand, isWatt, pm2DeleteCommand, portFreeGuard, removeUnitCommand, renderAppConfig, renderRunScript,
  renderRuntimeConfig, renderUnit, restartUnitCommand, runScriptName, stopUnitCommand, wattEnsureInstalledCommand, wattInstalledGuard, wattUnitName,
} from '../runtime/watt.js';
import type { DeployColor } from './blue-green.js';

function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "\\'");
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// Q5: `command` is shell-style — split on whitespace into script + args.
// Omitted command falls back to `<pkgManager> start` (the pre-multi-process default).
function parseCommand(command: string | undefined, pkgManager: string): { script: string; args: string } {
  if (!command) return { script: pkgManager, args: 'start' };
  const parts = command.trim().split(/\s+/);
  return { script: parts[0], args: parts.slice(1).join(' ') };
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
      const sharedEnvPath = `${this.appPath}/shared/${this.app.envFile}`;
      const missingEnvMessage =
        `Remote environment file is missing for app ${this.app.name}. ` +
        `Run: shipnode env --app ${this.app.name}`;
      commands.push(
        `[ -f ${shellSingleQuote(sharedEnvPath)} ] || ` +
        `{ echo ${shellSingleQuote(missingEnvMessage)} >&2; exit 1; }`,
      );
      commands.push(`ln -sf "${this.appPath}/shared/${this.app.envFile}" .env`);
    }

    // Ensure third-party package managers are available on the remote
    if (pkgManager === 'pnpm') {
      commands.push(`command -v pnpm &>/dev/null || npm install -g pnpm`);
    } else if (pkgManager === 'yarn') {
      commands.push(`command -v yarn &>/dev/null || npm install -g yarn`);
    } else if (pkgManager === 'bun') {
      commands.push(`command -v bun &>/dev/null || npm install -g bun`);
    }

    const envDependentCommands = [installCmd];

    if (!ctx.skipBuild) {
      envDependentCommands.push(`if [ -f package.json ] && jq -e '.scripts.build' package.json >/dev/null 2>&1; then ${runCmd} build; fi`);
    }

    envDependentCommands.push(envSymlinkCommand(this.app, ctx.workDir));

    commands.push(runWithDotenv(this.app.envFile ? '.env' : undefined, envDependentCommands.join(' && ')));

    const installResult = await ctx.executor.exec(commands.join(' && '));
    this.assertNoBuildScriptsIgnored(pkgManager, installResult);
    if (installResult.exitCode !== 0) {
      const detail = (installResult.stderr || installResult.stdout).trim();
      throw new DeployError(detail || 'Install/build failed', 'install');
    }
  }

  /**
   * The pm2 processes this replica is supposed to run.
   *
   * `placement: 'primary'` pins a process to one server — a scheduler running on
   * three replicas fires every job three times — so on every other replica it is
   * filtered out. This is the only place that decision is made; the namespace is
   * still taken from the full declared list so `pm2 list` grouping matches
   * across replicas.
   */
  private placedApps(ctx: StrategyContext): Pm2App[] {
    const apps = this.app.pm2?.apps ?? [];
    if (ctx.primaryReplica !== false) return apps;
    return apps.filter((app) => app.placement !== 'primary');
  }

  async startApp(ctx: StrategyContext): Promise<void> {
    if (!this.app.pm2) return;

    if (this.placedApps(ctx).length === 0) {
      console.log(chalk.dim(`  every pm2 process is placement: 'primary' — nothing to start on this replica`));
      return;
    }

    const pkgManager = await this.resolvePkgManager();
    const cdPath = `${this.appPath}/current`;
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

    if (isWatt(this.app)) {
      await this.startWatt(ctx, pkgManager, cdPath, mise);
      return;
    }

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
    const ecosystemContent = this.generateEcosystemForApps(this.placedApps(ctx), pkgManager);
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
    const workers = this.placedApps(ctx).filter((a) => a.port === undefined);
    const coloredName = coloredWebName(namespace, webApp.name, target.color);

    // Web ecosystem: just the web app, coloured name, target-colour port.
    const webEco = this.generateEcosystemForApps([webApp], pkgManager, (a) =>
      a.name === webApp.name ? { nameSuffix: `-${target.color}`, portOverride: target.port } : {},
    );
    const webRuntimePath = `${this.appPath}/current/ecosystem.web.config.cjs`;
    await this.writeEcosystem(ctx, `${ctx.workDir}/ecosystem.web.config.cjs`, webEco);

    // Write workers ecosystem now so afterHealthy can reload it; do not start yet.
    if (workers.length > 0) {
      const workersEco = this.generateEcosystemForApps(workers, pkgManager);
      await this.writeEcosystem(ctx, `${ctx.workDir}/ecosystem.workers.config.cjs`, workersEco);
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

    if (isWatt(this.app)) {
      // Workers are systemd units written (not started) by startWatt; start them
      // now that the new release passed health.
      const namespace = this.app.pm2.apps[0].name;
      const workers = this.placedApps(ctx).filter((a) => a.port === undefined);
      for (const worker of workers) {
        await ctx.executor.execOrThrow(restartUnitCommand(wattUnitName(namespace, worker.name)));
      }
      return;
    }

    const workers = this.placedApps(ctx).filter((a) => a.port === undefined);
    if (workers.length === 0) return;

    const cdPath = `${this.appPath}/current`;
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    const workersRuntimePath = `${this.appPath}/current/ecosystem.workers.config.cjs`;

    await ctx.executor.execOrThrow(
      `cd "${cdPath}" && ${mise} && ` +
      `{ mise exec -- pm2 reload "${workersRuntimePath}" --update-env 2>/dev/null || mise exec -- pm2 start "${workersRuntimePath}" --update-env; } && ` +
      `mise exec -- pm2 save`,
    );
  }

  /** Remove processes that are safe to stop only once Caddy serves the new colour. */
  async afterTrafficSwitch(ctx: StrategyContext): Promise<void> {
    if (!this.app.zeroDowntime || !ctx.deployTarget || !this.app.pm2) return;

    if (isWatt(this.app)) {
      await this.reapPreviousWattColor(ctx);
      return;
    }

    const namespace = this.app.pm2.apps[0].name;
    const webApp = this.app.pm2.apps.find((app) => app.port !== undefined);
    if (!webApp) return;

    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    // First deploy: drop a pre-blue-green uncoloured process (name === namespace).
    // Later deploys with retention "none": drop the idle coloured sibling.
    const previousName = ctx.deployTarget.previousColor === null
      ? getPm2Name(namespace, webApp.name)
      : this.app.blueGreenRetention === 'none'
        ? coloredWebName(namespace, webApp.name, ctx.deployTarget.previousColor)
        : undefined;
    if (previousName === undefined) return;

    // `pm2 delete <name>` also matches namespace, so `pm2 delete hub` would kill
    // `hub-green`. Resolve to pm_id by exact process name instead (jq is part of setup).
    const deleteExact =
      `id=$(mise exec -- pm2 jlist 2>/dev/null | jq -r --arg n "${previousName}" ` +
      `'.[] | select(.name == $n) | .pm_id' | head -n1) && ` +
      `{ [ -n "$id" ] && mise exec -- pm2 delete "$id" || true; }`;

    await ctx.executor.execOrThrow(
      `${mise} && ` +
      `{ ${deleteExact}; } && ` +
      `mise exec -- pm2 save`,
    );
  }

  // -------------------------------------------------------------------------
  // watt runtime (opt-in). The web app runs under wattpm as worker threads;
  // workers are plain systemd units. See ../runtime/watt.ts and ADR-0009.
  // -------------------------------------------------------------------------

  private get wattWebRoot(): string {
    return this.app.appRoot ? `${this.appPath}/current/${this.app.appRoot}` : `${this.appPath}/current`;
  }

  /** Write one file into the release being staged. `printf` keeps content byte-exact. */
  private async writeReleaseFile(ctx: StrategyContext, path: string, content: string): Promise<void> {
    await ctx.executor.execOrThrow(`printf '%s' ${shellSingleQuote(content)} > "${path}"`);
  }

  /**
   * Render and install everything one declared process needs: its launcher
   * script (per release) and its systemd unit. Returns the unit name. Does not
   * start it — callers decide when, so blue-green can hold workers back.
   */
  private async provisionWattProcess(
    ctx: StrategyContext,
    proc: Pm2App,
    pkgManager: string,
    color?: DeployColor,
    portOverride?: number,
  ): Promise<string> {
    const namespace = this.app.pm2!.apps[0].name;
    const isWeb = proc.port !== undefined;
    const port = portOverride ?? proc.port;
    const env: Record<string, string | number> = { NODE_ENV: 'production' };
    if (port !== undefined) env.PORT = port;
    for (const [k, v] of Object.entries(proc.env ?? {})) env[k] = v;

    const command = isWeb
      ? WATT_START_COMMAND
      : (proc.command ?? `${pkgManager} start`);

    const script = renderRunScript({
      cwd: this.wattWebRoot,
      command,
      envFile: this.app.envFile ? `${this.appPath}/shared/${this.app.envFile}` : undefined,
      env,
    });
    const scriptName = runScriptName(proc.name, color);
    await this.writeReleaseFile(ctx, `${ctx.workDir}/${scriptName}`, script);

    const unit = wattUnitName(namespace, proc.name, color);
    await ctx.executor.execOrThrow(installUnitCommand(unit, renderUnit({
      description: `shipnode ${namespace}/${proc.name}${color ? ` (${color})` : ''}`,
      user: this.workspace.ssh.user,
      workingDirectory: `${this.appPath}/current`,
      script: `${this.appPath}/current/${scriptName}`,
    })));
    return unit;
  }

  /** Write wattpm's runtime + capability config into the release's app root. */
  private async writeWattConfigs(ctx: StrategyContext, web: Pm2App): Promise<void> {
    const watt = this.app.watt!;
    const root = this.app.appRoot ? `${ctx.workDir}/${this.app.appRoot}` : ctx.workDir;
    await this.writeReleaseFile(ctx, `${root}/${WATT_RUNTIME_FILE}`, renderRuntimeConfig(web, watt));
    await this.writeReleaseFile(ctx, `${root}/${WATT_APP_FILE}`, renderAppConfig(watt));
  }

  private async startWatt(
    ctx: StrategyContext,
    pkgManager: PkgManager,
    cdPath: string,
    mise: string,
  ): Promise<void> {
    const pm2 = this.app.pm2!;
    const watt = this.app.watt!;
    const namespace = pm2.apps[0].name;
    const web = pm2.apps.find((a) => a.port !== undefined)!;
    const placed = this.placedApps(ctx);
    const workers = placed.filter((a) => a.port === undefined);
    const target = ctx.deployTarget;
    const blueGreen = this.app.zeroDowntime && target !== undefined;

    await this.writeWattConfigs(ctx, web);
    await this.relinkPackages(ctx, pkgManager, cdPath, mise);
    const ensured = await ctx.executor.exec(
      `${mise} && ${wattEnsureInstalledCommand(this.wattWebRoot, watt, pkgManager)}`,
    );
    if (ensured.exitCode !== 0) {
      throw new DeployError((ensured.stderr || ensured.stdout).trim() || 'Installing wattpm failed', 'start');
    }
    await ctx.executor.execOrThrow(wattInstalledGuard(this.wattWebRoot, watt));

    // Web: the colour being booted under blue-green, or the single recreate unit.
    const color = blueGreen ? target.color : undefined;
    const webUnit = await this.provisionWattProcess(ctx, web, pkgManager, color, blueGreen ? target.port : undefined);
    const workerUnits: string[] = [];
    for (const worker of workers) {
      workerUnits.push(await this.provisionWattProcess(ctx, worker, pkgManager));
    }

    const port = blueGreen ? target.port : web.port!;
    // Reap a stale same-colour instance, then guard the port against a foreign
    // process — but never the unit we are about to (re)start in recreate mode.
    const reap = blueGreen ? `${stopUnitCommand(webUnit)} && ` : '';
    // The idle colour may still be a resident PM2 process (previous release of
    // an app adopting watt); it is not serving, so retire it before binding its port.
    const retirePm2 = blueGreen
      ? `${mise} && ${pm2DeleteCommand(coloredWebName(namespace, web.name, target.color))} && `
      : '';
    await ctx.executor.execOrThrow(
      reap +
      retirePm2 +
      (blueGreen ? `${portFreeGuard(port)} && ` : '') +
      restartUnitCommand(webUnit),
    );

    // Recreate mode restarts workers with the web app. Blue-green holds them
    // until the new colour is healthy (afterHealthy).
    if (!blueGreen) {
      for (const unit of workerUnits) await ctx.executor.execOrThrow(restartUnitCommand(unit));
      // Adopting watt on a host that ran this app under PM2: retire the old
      // process so it stops holding the port. A no-op when PM2 was never used.
      await ctx.executor.execOrThrow(
        `${mise} && { mise exec -- pm2 delete "${namespace}" 2>/dev/null || true; }`,
      );
    }
  }

  /** After the Caddy flip: stop what is no longer serving, per retention. */
  private async reapPreviousWattColor(ctx: StrategyContext): Promise<void> {
    const target = ctx.deployTarget!;
    const namespace = this.app.pm2!.apps[0].name;
    const web = this.app.pm2!.apps.find((a) => a.port !== undefined);
    if (!web) return;

    if (target.previousColor === null) {
      // First blue-green deploy: retire the pre-blue-green process — an
      // uncoloured watt unit, or a PM2 process when migrating from PM2.
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
      await ctx.executor.execOrThrow(removeUnitCommand(wattUnitName(namespace, web.name)));
      await ctx.executor.execOrThrow(`${mise} && { mise exec -- pm2 delete "${namespace}" 2>/dev/null || true; }`);
      return;
    }
    if (this.app.blueGreenRetention === 'none') {
      await ctx.executor.execOrThrow(stopUnitCommand(wattUnitName(namespace, web.name, target.previousColor)));
    }
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
    const installResult = await ctx.executor.exec(
      `cd "${cdPath}" && ${mise} && ${runWithDotenv(this.app.envFile ? '.env' : undefined, relinkInstall)}`,
    );
    this.assertNoBuildScriptsIgnored(pkgManager, installResult);
    if (installResult.exitCode !== 0) {
      const detail = (installResult.stderr || installResult.stdout).trim();
      throw new DeployError(detail || 'Package relink failed', 'start');
    }
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
      const runner = runWithDotenv(envFilePath, `exec ${tail}`, env);
      scriptLine = `script: 'bash',`;
      argsLine = `\n      args: ['-c', '${escapeSingleQuotes(runner)}'],`;
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
