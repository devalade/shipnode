import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { pathExists } from 'fs-extra';
import { resolve } from 'path';
import type { ShipnodeConfig } from '../../shared/types.js';
import { getInstallCommand, getRunCommand, detectPkgManager } from '../framework/detector.js';
import { RSYNC_DEFAULT_EXCLUDES } from '../../shared/constants.js';
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

    await ctx.executor.exec(commands.join(' && '));
  }

  async startApp(ctx: StrategyContext): Promise<void> {
    if (!this.config.pm2) return;

    const script = await this.resolveEntryPoint();
    const ecosystemContent = this.generateEcosystemFile(script);
    const ecosystemPath = this.config.zeroDowntime
      ? `${this.config.remotePath}/shared/ecosystem.config.cjs`
      : `${ctx.workDir}/ecosystem.config.cjs`;

    const escaped = ecosystemContent.replace(/'/g, "'\"'\"'");
    await ctx.executor.exec(`echo '${escaped}' > "${ecosystemPath}"`);

    const cdPath = this.config.zeroDowntime ? `${this.config.remotePath}/current` : ctx.workDir;
    await ctx.executor.exec(
      `cd "${cdPath}" && ` +
      `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH" && ` +
      `mise exec -- pm2 startOrReload "${ecosystemPath}" --update-env && ` +
      `mise exec -- pm2 save`,
    );
  }

  private async resolveEntryPoint(): Promise<string> {
    try {
      const raw = await readFile(resolve(this.cwd, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);

      // 1. Explicit main field
      if (pkg.main) return pkg.main as string;

      // 2. Parse from start script: "node dist/index.js" → "dist/index.js"
      const startScript = pkg.scripts?.start as string | undefined;
      if (startScript) {
        const match = startScript.match(/node\s+([\S]+)/);
        if (match) return match[1];
      }
    } catch {
      // ignore
    }

    // 3. Probe common entry points that actually exist locally
    const candidates = ['server.js', 'app.js', 'index.js', 'dist/index.js', 'dist/server.js', 'src/index.js'];
    for (const candidate of candidates) {
      if (await pathExists(resolve(this.cwd, candidate))) return candidate;
    }

    return 'index.js';
  }

  private generateEcosystemFile(script: string): string {
    if (!this.config.pm2) return '';

    const port = this.config.backend?.port ?? 3000;
    const name = this.config.pm2.name;
    const instances = this.config.pm2.instances ?? 1;
    const maxMemory = this.config.pm2.maxMemory ?? '512M';

    return `module.exports = {
  apps: [{
    name: '${name}',
    script: '${script}',
    instances: ${instances},
    exec_mode: 'cluster',
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

  private async resolvePkgManager() {
    if (this.config.pkgManager) return this.config.pkgManager;
    const detected = await detectPkgManager(this.cwd);
    return detected ?? 'npm';
  }
}
