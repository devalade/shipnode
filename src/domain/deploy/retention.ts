import type { BlueGreenRetention, ShipnodeApp } from '../../shared/types.js';
import { coloredWebName, type DeployColor } from './blue-green.js';
import { isWatt, parkUnitCommand, wattUnitName } from '../runtime/watt.js';

/**
 * What happens to the colour that stopped serving after a blue-green flip.
 *
 * - `warm` (default): stopped after a short drain, kept on disk as a release.
 *   `rollback` boots it again from that release — seconds, and no memory held
 *   in between. This is the model Kamal uses.
 * - `rollback`: left running, so a rollback is an instant flip at the cost of a
 *   second copy of the app in memory.
 * - `none`: stopped like `warm`, and rollback is refused; redeploy instead.
 */
export function reapsPreviousColour(retention: BlueGreenRetention): boolean {
  return retention !== 'rollback';
}

/**
 * Seconds the old colour keeps running after Caddy flips away from it, so a
 * request already in flight finishes before the process is stopped. Caddy has
 * stopped sending it new ones by then.
 */
export const DRAIN_SECONDS = 10;

/** Shell prefix that waits out the drain; chain the reap after it with `&&`. */
export const drainCommand = `sleep ${DRAIN_SECONDS}`;

/**
 * Delete one PM2 process by exact name. `pm2 delete <name>` also matches a
 * namespace, so `pm2 delete hub` would take `hub-green` with it; resolving the
 * pm_id from the exact process name avoids that. `mise` is the PATH export.
 */
export function pm2DeleteExactCommand(mise: string, name: string): string {
  return (
    `${mise} && ` +
    `{ id=$(mise exec -- pm2 jlist 2>/dev/null | jq -r --arg n "${name}" ` +
    `'.[] | select(.name == $n) | .pm_id' | head -n1) && ` +
    `{ [ -n "$id" ] && mise exec -- pm2 delete "$id" || true; }; } && ` +
    `mise exec -- pm2 save`
  );
}

const MISE = 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"';

/**
 * Stop the web process of one colour after the drain: a watt unit is stopped
 * and disabled, a PM2 process is deleted by exact name. The release it ran stays on disk, so
 * `rollback` can boot it again.
 */
export function reapColourCommand(app: ShipnodeApp, namespace: string, webName: string, color: DeployColor): string {
  const stop = isWatt(app)
    ? parkUnitCommand(wattUnitName(namespace, webName, color))
    : pm2DeleteExactCommand(MISE, coloredWebName(namespace, webName, color));
  return `${drainCommand} && ${stop}`;
}
