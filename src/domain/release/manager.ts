import type { ReleaseRecord } from '../../shared/types.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import { LockError } from '../../shared/errors.js';

export class ReleaseManager {
  constructor(
    private executor: RemoteExecutor,
    private remotePath: string,
    private keepReleases: number,
  ) {}

  async createReleasePath(timestamp: string): Promise<string> {
    const releasePath = `${this.remotePath}/releases/${timestamp}`;
    await this.executor.exec(`mkdir -p "${releasePath}"`);
    return releasePath;
  }

  async setupReleaseStructure(): Promise<void> {
    await this.executor.exec(`mkdir -p "${this.remotePath}/releases"`);
    await this.executor.exec(`mkdir -p "${this.remotePath}/shared"`);
    await this.executor.exec(`mkdir -p "${this.remotePath}/.shipnode"`);
  }

  async switchSymlink(releasePath: string): Promise<void> {
    const tmpLink = `${this.remotePath}/current.tmp`;
    await this.executor.exec(`ln -sfn "${releasePath}" "${tmpLink}"`);
    await this.executor.exec(`mv -Tf "${tmpLink}" "${this.remotePath}/current"`);
  }

  async getPreviousRelease(): Promise<string | undefined> {
    try {
      const result = await this.executor.exec(
        `readlink "${this.remotePath}/current" 2>/dev/null || true`
      );
      if (result.exitCode === 0 && result.stdout) {
        return result.stdout;
      }
    } catch {
      // No previous release
    }
    return undefined;
  }

  async recordRelease(record: ReleaseRecord): Promise<void> {
    const releasesFile = `${this.remotePath}/.shipnode/releases.json`;

    const existingResult = await this.executor.exec(`cat "${releasesFile}" 2>/dev/null || echo '[]'`);
    let releases: ReleaseRecord[] = [];

    try {
      releases = JSON.parse(existingResult.stdout);
    } catch {
      releases = [];
    }

    releases.push(record);

    const json = JSON.stringify(releases, null, 2);
    const escaped = json.replace(/'/g, "'\"'\"'");
    await this.executor.exec(`echo '${escaped}' > "${releasesFile}"`);
  }

  async cleanupOldReleases(): Promise<void> {
    try {
      const result = await this.executor.exec(
        `ls -1t "${this.remotePath}/releases/" 2>/dev/null | tail -n +${this.keepReleases + 1}`
      );

      if (result.stdout) {
        const oldReleases = result.stdout.split('\n').filter(Boolean);
        for (const release of oldReleases) {
          await this.executor.exec(`rm -rf "${this.remotePath}/releases/${release}"`);
        }
      }
    } catch {
      // Cleanup is best-effort
    }
  }

  async listReleases(): Promise<ReleaseRecord[]> {
    const releasesFile = `${this.remotePath}/.shipnode/releases.json`;
    try {
      const result = await this.executor.exec(`cat "${releasesFile}" 2>/dev/null || echo '[]'`);
      return JSON.parse(result.stdout);
    } catch {
      return [];
    }
  }
}

export class DeployLock {
  constructor(
    private executor: RemoteExecutor,
    private remotePath: string,
  ) {}

  async acquire(): Promise<void> {
    const lockFile = `${this.remotePath}/.shipnode/deploy.lock`;
    const pid = process.pid.toString();

    const result = await this.executor.exec(
      `mkdir -p "${this.remotePath}/.shipnode" && ` +
      `if [ -f "${lockFile}" ]; then ` +
      `  lock_pid=$(cat "${lockFile}"); ` +
      `  if kill -0 "$lock_pid" 2>/dev/null; then ` +
      `    echo "Deployment already in progress (PID: $lock_pid)"; ` +
      `    exit 1; ` +
      `  else ` +
      `    echo "Stale lock found (PID: $lock_pid), removing"; ` +
      `    rm -f "${lockFile}"; ` +
      `  fi; ` +
      `fi && ` +
      `echo "${pid}" > "${lockFile}"`
    );

    if (result.exitCode !== 0) {
      throw new LockError(result.stdout || 'Failed to acquire deployment lock');
    }
  }

  async release(): Promise<void> {
    const lockFile = `${this.remotePath}/.shipnode/deploy.lock`;
    await this.executor.exec(`rm -f "${lockFile}"`).catch(() => {
      // Best-effort cleanup
    });
  }
}
