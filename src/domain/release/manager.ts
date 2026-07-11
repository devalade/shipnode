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
    await this.executor.execOrThrow(`mkdir -p "${releasePath}"`);
    return releasePath;
  }

  async setupReleaseStructure(): Promise<void> {
    await this.executor.execOrThrow(`mkdir -p "${this.remotePath}/releases" "${this.remotePath}/shared" "${this.remotePath}/.shipnode"`);
  }

  /**
   * Read the current symlink target, or null when no release is active yet.
   */
  async getCurrentReleasePath(): Promise<string | null> {
    const result = await this.executor.exec(
      `readlink "${this.remotePath}/current" 2>/dev/null || echo ''`,
    );
    const target = result.stdout.trim();
    return target || null;
  }

  async switchSymlink(releasePath: string): Promise<void> {
    const tmpLink = `${this.remotePath}/current.tmp`;
    await this.executor.execOrThrow(`ln -sfn "${releasePath}" "${tmpLink}"`);
    await this.executor.execOrThrow(`mv -Tf "${tmpLink}" "${this.remotePath}/current"`);
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
    await this.executor.execOrThrow(`printf '%s' '${b64}' | base64 -d > "${releasesFile}"`);
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

/**
 * Atomic deploy lock via `mkdir` (POSIX create-or-fail).
 *
 * Path: `<remotePath>/.shipnode/deploy.lock/` (directory). Older file-shaped
 * locks from pre-atomic versions are still recognised and cleared/honoured.
 */
export class DeployLock {
  constructor(
    private executor: RemoteExecutor,
    private remotePath: string,
  ) {}

  async acquire(): Promise<void> {
    const lockPath = `${this.remotePath}/.shipnode/deploy.lock`;
    const staleAfterSeconds = 3600;

    const result = await this.executor.exec(
      `mkdir -p "${this.remotePath}/.shipnode" && ` +
      `acquire_lock() { ` +
      `  mkdir "${lockPath}" 2>/dev/null && date -u +%Y-%m-%dT%H:%M:%SZ > "${lockPath}/acquired" && echo "OK" && return 0; ` +
      `  return 1; ` +
      `}; ` +
      `if acquire_lock; then true; ` +
      `elif [ -e "${lockPath}" ]; then ` +
      `  age=$(( $(date +%s) - $(stat -c %Y "${lockPath}" 2>/dev/null || echo 0) )); ` +
      `  if [ "$age" -ge ${staleAfterSeconds} ]; then ` +
      `    rm -rf "${lockPath}" && acquire_lock; ` +
      `  else ` +
      `    echo "LOCKED:$age"; exit 1; ` +
      `  fi; ` +
      `else ` +
      `  echo "LOCKED:0"; exit 1; ` +
      `fi`,
    );

    if (result.stdout.startsWith('LOCKED:')) {
      const age = result.stdout.split(':')[1];
      throw new LockError(
        `Deployment already in progress (lock age: ${age}s). Run 'shipnode unlock' to clear.`,
      );
    }

    if (result.exitCode !== 0 || !result.stdout.includes('OK')) {
      throw new LockError(result.stderr || 'Failed to acquire deployment lock');
    }
  }

  async release(): Promise<void> {
    const lockPath = `${this.remotePath}/.shipnode/deploy.lock`;
    await this.executor.exec(`rm -rf "${lockPath}"`).catch(() => {
      // Best-effort cleanup
    });
  }
}
