import type { RemoteExecutor } from '../remote/executor.js';

/**
 * Taking a replica out of rotation.
 *
 * shipnode does not manage the load balancer and does not talk to it. It owns a
 * single readiness endpoint per replica, and the LB's own health check decides
 * rotation from what that endpoint answers. Draining is therefore just: make
 * the endpoint say 503, and wait long enough for the LB to notice.
 *
 * The signal is a sentinel file rather than a rewritten Caddy config. Caddy
 * matches on the file's existence, so flipping state is one `touch`/`rm` with
 * no reload, it takes effect immediately, and it survives a Caddy restart or a
 * host reboot — a drained replica stays drained until something undrains it.
 */

/** Directory holding a deployed app's shipnode state on the remote host. */
export function appStateDir(remotePath: string, appName: string): string {
  return `${remotePath}/${appName}/.shipnode`;
}

export function drainSentinelPath(remotePath: string, appName: string): string {
  return `${appStateDir(remotePath, appName)}/drain`;
}

export async function drain(
  executor: RemoteExecutor,
  remotePath: string,
  appName: string,
): Promise<void> {
  const sentinel = drainSentinelPath(remotePath, appName);
  await executor.execOrThrow(
    `mkdir -p "${appStateDir(remotePath, appName)}" && touch "${sentinel}"`,
  );
}

export async function undrain(
  executor: RemoteExecutor,
  remotePath: string,
  appName: string,
): Promise<void> {
  await executor.execOrThrow(`rm -f "${drainSentinelPath(remotePath, appName)}"`);
}

export async function isDrained(
  executor: RemoteExecutor,
  remotePath: string,
  appName: string,
): Promise<boolean> {
  const result = await executor.exec(
    `test -f "${drainSentinelPath(remotePath, appName)}" && echo YES || echo NO`,
  );
  return result.stdout.trim() === 'YES';
}
