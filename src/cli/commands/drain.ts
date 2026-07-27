import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import { drain, isDrained, undrain } from '../../domain/deploy/drain.js';

/**
 * Manual rotation control.
 *
 * Deploying already drains and undrains each replica as it rolls. These exist
 * for the times you want a replica out of the pool without deploying it —
 * reproducing a bug on live data, or holding a replica back after a failed
 * roll left it drained.
 */
export async function cmdDrain(
  cwd: string,
  options: { app?: string; on?: string; config?: string },
): Promise<void> {
  await setRotation(cwd, options, true);
}

export async function cmdUndrain(
  cwd: string,
  options: { app?: string; on?: string; config?: string },
): Promise<void> {
  await setRotation(cwd, options, false);
}

async function setRotation(
  cwd: string,
  options: { app?: string; on?: string; config?: string },
  drained: boolean,
): Promise<void> {
  let touched = 0;

  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      for (const app of config.apps) {
        if (options.app && app.name !== options.app) continue;
        if (!app.fleet) {
          ui.warn(`${app.name} is not behind a load balancer — nothing to drain.`);
          continue;
        }

        if (drained) {
          await drain(executor, config.remotePath, app.name);
          ui.success(`${app.name} on ${serverName} is draining (${app.fleet.readyPath} now answers 503)`);
        } else {
          await undrain(executor, config.remotePath, app.name);
          ui.success(`${app.name} on ${serverName} is back in rotation`);
        }
        touched += 1;
      }
    },
    { configPath: options.config, appName: options.app, serverName: options.on },
  );

  if (touched === 0) {
    ui.warn('No fleet apps matched.');
    return;
  }

  if (drained) {
    ui.info('Your load balancer removes it once its own health check notices — that is what fleet.drainWait covers.');
  }
}

/** Drain state per replica, for `status`. */
export async function readDrainState(
  cwd: string,
  options: { app?: string; config?: string },
): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      for (const app of config.apps) {
        if (options.app && app.name !== options.app) continue;
        if (!app.fleet) continue;
        const out = await isDrained(executor, config.remotePath, app.name);
        ui.info(`${app.name} on ${serverName}: ${out ? 'draining' : 'in rotation'}`);
      }
    },
    { configPath: options.config, appName: options.app },
  );
}
