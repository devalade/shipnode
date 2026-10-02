import type { ExecResult } from '../../shared/types.js';

/**
 * A seam for executing commands on a remote host.
 *
 * Implementations satisfy this seam — callers do not know whether the
 * underlying transport is SSH, a local shell, or a test double.
 *
 * `exec` always resolves (never throws on non-zero exit). Use `execOrThrow`
 * when a non-zero exit should abort the calling operation.
 */
export interface ExecOptions {
  timeout?: number;
  onData?: (chunk: string, fd: 'stdout' | 'stderr') => void;
  /**
   * Ends a long-running command (a log follow). `exec` then resolves with
   * whatever the command had produced - an abort is a normal way to finish.
   */
  signal?: AbortSignal;
  /**
   * Allocate a pseudo-terminal. The remote side hangs up the command when the
   * channel closes, so an abandoned `tail -f` does not outlive the session.
   * stderr is merged into stdout, and line endings arrive as CRLF.
   */
  pty?: boolean;
}

export abstract class RemoteExecutor {
  abstract exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  async execOrThrow(command: string, options?: { timeout?: number }): Promise<void> {
    const result = await this.exec(command, options);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(detail || `Command failed with exit code ${result.exitCode}`);
    }
  }
}
