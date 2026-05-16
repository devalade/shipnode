import { execa } from 'execa';
import { pathExists } from 'fs-extra';
import { resolve } from 'path';
import type { ShipnodeConfig } from '../../shared/types.js';
import { getInstallCommand, getRunCommand, detectPkgManager } from '../framework/detector.js';
import { RSYNC_DEFAULT_EXCLUDES } from '../../shared/constants.js';
import { DeployError } from '../../shared/errors.js';
import type { DeploymentStrategy, StrategyContext } from './strategy.js';

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
    const installCmd = getInstallCommand(pkgManager);
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
      commands.push(`ln -sf "${this.config.remotePath}/shared/.env" .env`);
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

    commands.push(`if [ -d build ] && [ -f .env ]; then ln -sf "${ctx.workDir}/.env" build/.env; fi`);

    const installResult = await ctx.executor.exec(commands.join(' && '));
    this.assertNoBuildScriptsIgnored(pkgManager, installResult);
  }

  async startApp(ctx: StrategyContext): Promise<void> {
    if (!this.config.pm2) return;

    const pkgManager = await this.resolvePkgManager();
    const ecosystemContent = this.generateEcosystemFile(pkgManager);
    const ecosystemPath = `${this.config.remotePath}/shared/ecosystem.config.cjs`;

    const escaped = ecosystemContent.replace(/'/g, "'\"'\"'");
    await ctx.executor.exec(`echo '${escaped}' > "${ecosystemPath}"`);

    const cdPath = `${this.config.remotePath}/current`;
    const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

    // Re-run install from the final directory so the pkg manager's module
    // resolution state matches the path PM2 will use. Packages are already
    // in the local store so this is a fast offline relink, not a download.
    const installCmd = getInstallCommand(pkgManager);
    const installResult = await ctx.executor.exec(
      `cd "${cdPath}" && ${mise} && ${installCmd} --prefer-offline`,
    );
    this.assertNoBuildScriptsIgnored(pkgManager, installResult);

    const port = this.config.backend?.port ?? 3000;
    await ctx.executor.exec(
      `cd "${cdPath}" && ${mise} && ` +
      `{ mise exec -- pm2 delete "${this.config.pm2!.name}" 2>/dev/null || true; } && ` +
      `{ ss -tlnp | grep -q ":${port} " && echo "Port ${port} is already in use by another process" && false || true; } && ` +
      `mise exec -- pm2 start "${ecosystemPath}" --update-env && ` +
      `mise exec -- pm2 save`,
    );
  }

  private generateEcosystemFile(pkgManager: string): string {
    if (!this.config.pm2) return '';

    const port = this.config.backend?.port ?? 3000;
    const name = this.config.pm2.name;
    const instances = this.config.pm2.instances ?? 1;
    const maxMemory = this.config.pm2.maxMemory ?? '512M';

    return `module.exports = {
  apps: [{
    name: '${name}',
    script: '${pkgManager}',
    args: 'start',
    instances: ${instances},
    exec_mode: 'fork',
    max_memory_restart: '${maxMemory}',
    env: {
      NODE_ENV: 'production',
      PORT: ${port},
    },
  }],
};`;
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
