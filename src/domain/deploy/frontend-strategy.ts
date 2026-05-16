import { execa } from 'execa';
import { pathExists } from 'fs-extra';
import { resolve } from 'path';
import type { ShipnodeConfig } from '../../shared/types.js';
import { getRunCommand, detectPkgManager } from '../framework/detector.js';
import type { DeploymentStrategy, StrategyContext } from './strategy.js';

export class FrontendStrategy implements DeploymentStrategy {
  readonly name = 'frontend';

  constructor(
    private config: ShipnodeConfig,
    private cwd: string,
  ) {}

  async stage(ctx: StrategyContext): Promise<void> {
    if (!ctx.skipBuild) {
      await this.buildFrontend();
    }

    const buildDir = await this.detectFrontendBuildDir();
    const ignoreFile = resolve(this.cwd, '.shipnodeignore');
    const hasIgnoreFile = await pathExists(ignoreFile);

    await execa('rsync', [
      '-avz',
      '--progress',
      '--delete',
      '-e', `ssh -p ${this.config.ssh.port}`,
      '--exclude', 'shared/',
      '--exclude', '.shipnode/',
      '--exclude', 'releases/',
      '--exclude', 'current',
      ...(hasIgnoreFile ? ['--exclude-from', ignoreFile] : []),
      `${this.cwd}/${buildDir}/`,
      `${this.config.ssh.user}@${this.config.ssh.host}:${ctx.workDir}/`,
    ], { stdio: 'inherit' });
  }

  private async buildFrontend(): Promise<void> {
    const pkgManager = await this.resolvePkgManager();
    const runCmd = getRunCommand(pkgManager);

    await execa(runCmd.split(' ')[0], [...runCmd.split(' ').slice(1), 'build'], {
      cwd: this.cwd,
      stdio: 'inherit',
    });
  }

  private async detectFrontendBuildDir(): Promise<string> {
    if (this.config.buildDir) return this.config.buildDir;
    if (await pathExists(`${this.cwd}/build`)) return 'build';
    if (await pathExists(`${this.cwd}/public`)) return 'public';
    if (await pathExists(`${this.cwd}/dist`)) return 'dist';
    if (await pathExists(`${this.cwd}/out`)) return 'out';
    if (await pathExists(`${this.cwd}/.output`)) return '.output';

    return 'dist';
  }

  private async resolvePkgManager() {
    if (this.config.pkgManager) return this.config.pkgManager;
    const detected = await detectPkgManager(this.cwd);
    return detected ?? 'npm';
  }
}
