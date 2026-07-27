import { execa } from 'execa';
import { pathExists } from 'fs-extra';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import type { ShipnodeConfig, ShipnodeApp, PkgManager } from '../../shared/types.js';
import type { RemoteExecutor } from '../remote/executor.js';
import type { HealthCheckService, RetryBackoff } from '../../services/health.service.js';
import { getInstallCommand, getRunCommand, detectPkgManager } from '../framework/detector.js';
import { RSYNC_DEFAULT_EXCLUDES } from '../../shared/constants.js';
import { DeployError } from '../../shared/errors.js';
import { readDeployState, portFor } from './blue-green.js';
import { runWithDotenv } from './dotenv.js';
import { envSymlinkCommand } from './env-links.js';

/**
 * The `deploy --watch` inner loop: patch the *live* release in place and reload.
 *
 * This is deliberately not a release. A full deploy stages a fresh release
 * directory, health-checks it on an idle colour, and only then flips traffic.
 * A hot sync rsyncs into the release that is already serving, rebuilds, and
 * reloads the processes that are already running — trading the safety of the
 * release pipeline for a sub-second edit-to-live loop during development.
 *
 * Consequences worth knowing (surfaced to the user by the watch session):
 *   - There is no rollback target for a hot sync; the previous code is gone.
 *   - Files deleted locally are not removed remotely. Only a full deploy,
 *     which builds a new release directory from scratch, resets that drift.
 *   - Reload restarts fork-mode processes, so in-flight requests can drop.
 */

/** Files whose change means the dependency tree may no longer match the lockfile. */
const DEPENDENCY_MANIFESTS: readonly string[] = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
];

/**
 * Where each cycle's build runs.
 *
 * `remote` matches the default deploy path: source is synced and built on the
 * server. `local` matches projects that build locally and upload the artifact
 * (Nitro/TanStack Start/Nuxt apps deployed with `--skip-build`) — the build
 * runs here and its output is part of the sync. `none` leaves building to the
 * developer, which is what you want alongside a framework's own watch mode
 * (`vite build --watch`); shipnode then only ships and reloads.
 */
export type BuildLocation = 'remote' | 'local' | 'none';

export interface HotSyncOptions {
  buildLocation: BuildLocation;
  /**
   * Above this many changed paths, sync the whole tree instead of an explicit
   * file list. A long `--files-from` stops being cheaper than one tree scan,
   * and bulk changes (branch switch, dependency install) are exactly when the
   * file list is least likely to be complete.
   */
  fileListThreshold?: number;
  /** Overrides the app's health-check pacing for the hot-sync probe. */
  healthProbe?: HealthProbeProfile;
  /**
   * Suppresses file-change recording while a build we run is writing.
   *
   * A build writes inside the watched tree — framework codegen, temp files —
   * and those writes are indistinguishable from a developer's edit by path
   * alone. Gating on *when* we build is what stops a cycle from re-triggering
   * itself. Absent (tests, non-watch callers) the build simply runs unguarded.
   */
  suppressWatch?: { pause(): void; resume(): void };
}

export interface HealthProbeProfile {
  retries: number;
  timeoutSeconds: number;
  backoff: RetryBackoff;
}

/**
 * A tight probe: an app that boots in 200ms should not wait on a 2-second
 * retry gap, and an app that is genuinely broken should say so quickly so the
 * developer can keep editing.
 */
const DEFAULT_HEALTH_PROBE: HealthProbeProfile = {
  retries: 6,
  timeoutSeconds: 5,
  backoff: { initialMs: 100, maxMs: 1000 },
};

export interface HotSyncResult {
  mode: 'incremental' | 'full';
  changedPaths: number;
  transferredFiles: number;
  installed: boolean;
  built: boolean;
  reloaded: boolean;
  health: 'passed' | 'failed' | 'skipped';
  healthError?: string;
  durationMs: number;
}

/** True when any changed path could have altered the dependency tree. */
export function touchesDependencies(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => DEPENDENCY_MANIFESTS.includes(basename(path)));
}

export class HotSync {
  private pkgManager: PkgManager | undefined;

  constructor(
    private config: ShipnodeConfig,
    private app: ShipnodeApp,
    private executor: RemoteExecutor,
    private cwd: string,
    private healthCheck: HealthCheckService,
    private options: HotSyncOptions,
  ) {}

  private get appPath(): string {
    return `${this.config.remotePath}/${this.app.name}`;
  }

  /** The live release, reached through the `current` symlink. */
  private get liveDir(): string {
    return `${this.appPath}/current`;
  }

  async run(changedPaths: string[]): Promise<HotSyncResult> {
    const started = Date.now();

    if (this.app.appType === 'frontend') {
      return this.runFrontend(changedPaths, started);
    }
    return this.runBackend(changedPaths, started);
  }

  /**
   * Static frontends have no process to reload: rebuild locally, ship the
   * build output over the live release, and Caddy serves the new files
   * immediately.
   */
  private async runFrontend(changedPaths: string[], started: number): Promise<HotSyncResult> {
    let built = false;
    // A static frontend has nothing to build on the server; `remote` and
    // `local` both mean "build here".
    if (this.options.buildLocation !== 'none') {
      await this.buildLocally();
      built = true;
    }

    const buildDir = await this.detectFrontendBuildDir();
    const transferredFiles = await this.rsync([
      '-a',
      '--delete',
      '--out-format=%n',
      '-e', `ssh -p ${this.config.ssh.port}`,
      '--exclude', 'shared/',
      '--exclude', '.shipnode/',
      '--exclude', 'releases/',
      '--exclude', 'current',
      ...(await this.ignoreFileArgs()),
      `${this.cwd}/${buildDir}/`,
      `${this.config.ssh.user}@${this.config.ssh.host}:${this.liveDir}/`,
    ]);

    return {
      mode: 'full',
      changedPaths: changedPaths.length,
      transferredFiles,
      installed: false,
      built,
      reloaded: false,
      health: 'skipped',
      durationMs: Date.now() - started,
    };
  }

  private async runBackend(changedPaths: string[], started: number): Promise<HotSyncResult> {
    const location = this.options.buildLocation;

    // Build before syncing when it runs locally, so the fresh artifact is part
    // of this cycle's transfer rather than the next one's.
    let built = false;
    if (location === 'local') {
      await this.buildLocally();
      built = true;
    }

    const { mode, transferredFiles } = await this.syncSource(changedPaths);

    const needsInstall = touchesDependencies(changedPaths);
    const buildsRemotely = location === 'remote';

    if (needsInstall || buildsRemotely) {
      await this.prepareRemote(needsInstall, buildsRemotely);
      built = built || buildsRemotely;
    }

    const reloaded = await this.reload();
    const health = await this.probeHealth();

    return {
      mode,
      changedPaths: changedPaths.length,
      transferredFiles,
      installed: needsInstall,
      built,
      reloaded,
      health: health.status,
      healthError: health.error,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Ship source into the live release.
   *
   * The fast path hands rsync an explicit file list so it skips the full-tree
   * scan entirely — that scan is the floor on loop latency for a large repo.
   * We drop to a full-tree sync when the change set is large or when any
   * changed path no longer exists locally (a delete or rename, which a file
   * list cannot express).
   *
   * Note the absence of `--delete`: the live release holds files that were
   * never in the local tree (`ecosystem.config.cjs`, the `.env` symlink,
   * remotely-built output), and deleting those would break the running app.
   */
  private async syncSource(
    changedPaths: string[],
  ): Promise<{ mode: 'incremental' | 'full'; transferredFiles: number }> {
    const threshold = this.options.fileListThreshold ?? 200;
    // A local build writes output the watcher deliberately does not report (it
    // would re-trigger this very cycle), so the changed-path list cannot name
    // the fresh artifact. Let rsync find it: its delta scan is cheap next to
    // the build that just ran.
    const mustScanTree = this.options.buildLocation === 'local';
    const baseArgs = [
      '-a',
      '--out-format=%n',
      '-e', `ssh -p ${this.config.ssh.port}`,
      ...RSYNC_DEFAULT_EXCLUDES.flatMap((exclude) => ['--exclude', exclude]),
      ...(await this.ignoreFileArgs()),
    ];
    const source = `${this.cwd}/`;
    const destination = `${this.config.ssh.user}@${this.config.ssh.host}:${this.liveDir}/`;

    const fileList = !mustScanTree && changedPaths.length > 0 && changedPaths.length <= threshold
      ? await this.survivingPaths(changedPaths)
      : null;

    if (fileList) {
      const listDir = await mkdtemp(join(tmpdir(), 'shipnode-watch-'));
      const listFile = join(listDir, 'files.txt');
      try {
        await writeFile(listFile, `${fileList.join('\n')}\n`, 'utf8');
        const transferredFiles = await this.rsync([
          ...baseArgs,
          // `--files-from` disables the recursion implied by `-a`; restore it so
          // a changed directory still syncs its contents.
          '-r',
          '--files-from', listFile,
          source,
          destination,
        ]);
        return { mode: 'incremental', transferredFiles };
      } finally {
        await rm(listDir, { recursive: true, force: true });
      }
    }

    const transferredFiles = await this.rsync([...baseArgs, source, destination]);
    return { mode: 'full', transferredFiles };
  }

  /**
   * The subset of changed paths that still exist locally, or `null` when any
   * are missing — a delete needs a full-tree sync to stay coherent.
   */
  private async survivingPaths(changedPaths: string[]): Promise<string[] | null> {
    const surviving: string[] = [];
    for (const path of changedPaths) {
      if (!(await pathExists(resolve(this.cwd, path)))) return null;
      surviving.push(path);
    }
    return surviving.length > 0 ? surviving : null;
  }

  /** Install (only when the dependency tree may have moved) and rebuild. */
  private async prepareRemote(needsInstall: boolean, willBuild: boolean): Promise<void> {
    const pkgManager = await this.resolvePkgManager();
    const runCmd = getRunCommand(pkgManager);
    const steps: string[] = [];

    if (needsInstall) {
      const baseInstall = this.config.installCommand ?? getInstallCommand(pkgManager);
      // A custom installCommand is used verbatim — appending --prefer-offline
      // would compose poorly with the user's chosen flags.
      steps.push(this.config.installCommand ? baseInstall : `${baseInstall} --prefer-offline`);
    }

    if (willBuild) {
      steps.push(
        `if [ -f package.json ] && jq -e '.scripts.build' package.json >/dev/null 2>&1; then ${runCmd} build; fi`,
      );
      // A build that wipes and recreates its output directory takes the `.env`
      // symlink with it, so re-establish the links after every build.
      steps.push(envSymlinkCommand(this.app, this.liveDir));
    }

    if (steps.length === 0) return;

    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
    const result = await this.executor.exec(
      `cd "${this.liveDir}" && ${mise} && ` +
      runWithDotenv(this.app.envFile ? '.env' : undefined, steps.join(' && ')),
    );

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new DeployError(detail || 'Hot sync install/build failed', needsInstall ? 'install' : 'build');
    }
  }

  /**
   * Reload the processes that are already running, without flipping colours.
   *
   * Reloading by ecosystem file rather than by derived process name keeps this
   * honest for blue-green apps: after a successful deploy, the release's
   * `ecosystem.web.config.cjs` describes exactly the colour serving traffic, so
   * the idle colour is left untouched and stays a viable rollback target.
   */
  private async reload(): Promise<boolean> {
    if (!this.app.pm2) return false;

    const files = this.app.zeroDowntime
      ? [`${this.liveDir}/ecosystem.web.config.cjs`, `${this.liveDir}/ecosystem.workers.config.cjs`]
      : [`${this.liveDir}/ecosystem.config.cjs`];
    const quoted = files.map((file) => `"${file}"`).join(' ');
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

    const result = await this.executor.exec(
      `cd "${this.liveDir}" && ${mise} && ` +
      `count=0; ` +
      `for file in ${quoted}; do ` +
      `if [ -f "$file" ]; then mise exec -- pm2 reload "$file" --update-env || exit 1; count=$((count+1)); fi; ` +
      `done; ` +
      `if [ "$count" -eq 0 ]; then echo "no ecosystem file in the live release" >&2; exit 1; fi`,
    );

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new DeployError(
        detail
          ? `Reload failed: ${detail}`
          : 'Reload failed. Run a full `shipnode deploy` to rebuild the release.',
        'start',
      );
    }

    return true;
  }

  /**
   * Probe the port that is actually serving. HTTP only: `pm2 reload` bumps
   * `restart_time`, which the PM2 status check reads as a startup crash, and a
   * tight backoff keeps the loop fast for apps that boot in milliseconds.
   */
  private async probeHealth(): Promise<{ status: 'passed' | 'failed' | 'skipped'; error?: string }> {
    if (!this.app.healthCheck.enabled) return { status: 'skipped' };

    const webApp = this.app.pm2?.apps.find((pm2App) => pm2App.port !== undefined);
    if (!webApp?.port) return { status: 'skipped' };

    const port = await this.activePort(webApp.port);
    const profile = this.options.healthProbe ?? DEFAULT_HEALTH_PROBE;
    const fastApp: ShipnodeApp = {
      ...this.app,
      healthCheck: {
        ...this.app.healthCheck,
        startupDelay: 0,
        retries: profile.retries,
        timeout: profile.timeoutSeconds,
      },
    };

    try {
      await this.healthCheck.perform(fastApp, {
        httpPort: port,
        // Empty list skips the PM2 status check; see above.
        pm2Apps: [],
        backoff: profile.backoff,
      });
      return { status: 'passed' };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The port traffic is on: the active colour for blue-green, else the config port. */
  private async activePort(configuredPort: number): Promise<number> {
    if (!this.app.zeroDowntime) return configuredPort;

    const state = await readDeployState(this.executor, this.appPath);
    if (!state) return configuredPort;
    return portFor(state.activeColor, state);
  }

  private async rsync(args: string[]): Promise<number> {
    try {
      const result = await execa('rsync', args);
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && line !== './' && !line.endsWith('/'))
        .length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DeployError(`rsync failed: ${message}`, 'deploy');
    }
  }

  private async ignoreFileArgs(): Promise<string[]> {
    const ignoreFile = resolve(this.cwd, '.shipnodeignore');
    return (await pathExists(ignoreFile)) ? ['--exclude-from', ignoreFile] : [];
  }

  /**
   * Run the app's build here.
   *
   * In a monorepo the `build` script belongs to the app, not the workspace
   * root, so this runs from `appRoot` when one is declared — matching where
   * the remote build's `package.json` lookup would land.
   *
   * Public because the watch session needs it before the baseline deploy too:
   * that deploy runs with `skipBuild`, so without this the first release would
   * ship whatever stale build output happened to be on disk.
   */
  async buildLocally(): Promise<void> {
    const pkgManager = await this.resolvePkgManager();
    const runCmd = getRunCommand(pkgManager);
    const [command, ...args] = runCmd.split(' ');
    const buildCwd = this.app.appRoot ? resolve(this.cwd, this.app.appRoot) : this.cwd;

    this.options.suppressWatch?.pause();
    try {
      await execa(command, [...args, 'build'], { cwd: buildCwd, stdio: 'inherit' });
    } finally {
      this.options.suppressWatch?.resume();
    }
  }

  private async detectFrontendBuildDir(): Promise<string> {
    if (this.app.buildDir) return this.app.buildDir;
    if (await pathExists(`${this.cwd}/build`)) return 'build';
    if (await pathExists(`${this.cwd}/public`)) return 'public';
    if (await pathExists(`${this.cwd}/dist`)) return 'dist';
    if (await pathExists(`${this.cwd}/out`)) return 'out';
    if (await pathExists(`${this.cwd}/.output`)) return '.output';

    return 'dist';
  }

  private async resolvePkgManager(): Promise<PkgManager> {
    if (this.pkgManager) return this.pkgManager;
    this.pkgManager = this.config.pkgManager ?? (await detectPkgManager(this.cwd)) ?? 'npm';
    return this.pkgManager;
  }
}
