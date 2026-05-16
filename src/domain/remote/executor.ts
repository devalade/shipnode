import type { ExecResult } from '../../shared/types.js';

/**
 * A seam for executing commands on a remote host.
 *
 * Implementations satisfy this interface at the seam — callers do not
 * know whether the underlying transport is SSH, a local shell, or a test double.
 *
 * The interface is intentionally narrow: a lot of behaviour (connection
 * management, authentication, session reuse) hides behind `exec`.
 */
export interface RemoteExecutor {
  exec(command: string, options?: { timeout?: number }): Promise<ExecResult>;
}
