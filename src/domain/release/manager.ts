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

    const b64 = Buffer.from(JSON.stringify(releases, null, 2)).toString('base64');
    await this.executor.exec(`printf '%s' '${b64}' | base64 -d > "${releasesFile}"`);
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
    const staleAfterSeconds = 3600;

    const result = await this.executor.exec(
      `mkdir -p "${this.remotePath}/.shipnode" && ` +
      `if [ -f "${lockFile}" ]; then ` +
      `  age=$(( $(date +%s) - $(stat -c %Y "${lockFile}") )); ` +
      `  if [ "$age" -lt ${staleAfterSeconds} ]; then ` +
      `    echo "LOCKED:$age"; exit 1; ` +
      `  else ` +
      `    rm -f "${lockFile}"; ` +
      `  fi; ` +
      `fi && ` +
      `date -u +%Y-%m-%dT%H:%M:%SZ > "${lockFile}" && echo "OK"`,
    );

    if (result.stdout.startsWith('LOCKED:')) {
      const age = result.stdout.split(':')[1];
      throw new LockError(
        `Deployment already in progress (lock age: ${age}s). Run 'shipnode unlock' to clear.`,
      );
    }

    if (result.exitCode !== 0) {
      throw new LockError(result.stderr || 'Failed to acquire deployment lock');
    }
  }

  async release(): Promise<void> {
    const lockFile = `${this.remotePath}/.shipnode/deploy.lock`;
    await this.executor.exec(`rm -f "${lockFile}"`).catch(() => {
      // Best-effort cleanup
    });
  }
}
