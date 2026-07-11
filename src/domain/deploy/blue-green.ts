import type { RemoteExecutor } from '../remote/executor.js';
import { getPm2Name } from '../pm2/apps.js';

/**
 * Blue-green release state.
 *
 * A zero-downtime backend web app runs on two ports — blue and green. Exactly
 * one colour is "active" (Caddy's upstream points at it) at a time; the other
 * colour either doesn't exist yet or is the previous release, kept resident so
 * a rollback is an instant Caddy flip. Each deploy boots the *idle* colour,
 * health-checks it, then flips.
 *
 * The port pair is fixed at the first deploy and persisted, so later config
 * changes to the web port don't silently re-home a running colour.
 */

export type DeployColor = 'blue' | 'green';

export interface DeployState {
  activeColor: DeployColor;
  bluePort: number;
  greenPort: number;
}

export interface DeployTarget {
  /** The colour this deploy boots (the idle one). */
  color: DeployColor;
  /** Port the target colour listens on. */
  port: number;
  /** The colour currently serving traffic, or null on the first deploy. */
  previousColor: DeployColor | null;
  /** Port the previous colour listens on, or null on the first deploy. */
  previousPort: number | null;
  /** Port pair to persist once the flip succeeds. */
  bluePort: number;
  greenPort: number;
}

export function otherColor(color: DeployColor): DeployColor {
  return color === 'blue' ? 'green' : 'blue';
}

export function portFor(color: DeployColor, state: DeployState): number {
  return color === 'blue' ? state.bluePort : state.greenPort;
}

/** The green port: explicit `altPort`, else web port + 1. */
export function resolveAltPort(webPort: number, altPort?: number): number {
  return altPort ?? webPort + 1;
}

/** PM2 process name for the web app of a given colour (`api-blue`, `api-green`). */
export function coloredWebName(namespace: string, webAppName: string, color: DeployColor): string {
  return `${getPm2Name(namespace, webAppName)}-${color}`;
}

function stateFile(appPath: string): string {
  return `${appPath}/.shipnode/deploy-state.json`;
}

export async function readDeployState(
  executor: RemoteExecutor,
  appPath: string,
): Promise<DeployState | null> {
  const result = await executor.exec(`cat "${stateFile(appPath)}" 2>/dev/null || echo ''`);
  const raw = result.stdout.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeployState>;
    if (
      (parsed.activeColor === 'blue' || parsed.activeColor === 'green') &&
      typeof parsed.bluePort === 'number' &&
      typeof parsed.greenPort === 'number'
    ) {
      return { activeColor: parsed.activeColor, bluePort: parsed.bluePort, greenPort: parsed.greenPort };
    }
  } catch {
    // Corrupt/legacy state is treated as "no state" — the next deploy behaves
    // like a first deploy (targets blue on the web port).
  }
  return null;
}

export async function writeDeployState(
  executor: RemoteExecutor,
  appPath: string,
  state: DeployState,
): Promise<void> {
  const b64 = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
  await executor.execOrThrow(
    `mkdir -p "${appPath}/.shipnode" && printf '%s' '${b64}' | base64 -d > "${stateFile(appPath)}"`,
  );
}

/**
 * Decide which colour/port the incoming release targets.
 *
 * First deploy (no state): target blue on the web port; the green port comes
 * from `altPort`. There is nothing to keep or roll back to.
 * Otherwise: target the idle colour (opposite of the active one).
 */
export function resolveTarget(
  state: DeployState | null,
  webPort: number,
  altPort: number,
): DeployTarget {
  if (!state) {
    return {
      color: 'blue',
      port: webPort,
      previousColor: null,
      previousPort: null,
      bluePort: webPort,
      greenPort: altPort,
    };
  }
  const target = otherColor(state.activeColor);
  return {
    color: target,
    port: portFor(target, state),
    previousColor: state.activeColor,
    previousPort: portFor(state.activeColor, state),
    bluePort: state.bluePort,
    greenPort: state.greenPort,
  };
}
