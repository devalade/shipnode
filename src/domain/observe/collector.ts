import type { RemoteExecutor } from '../remote/executor.js';
import type { ShipnodeApp, ShipnodeConfig } from '../../shared/types.js';
import {
  parseAccessoryStatus,
  parseCaddyInfo,
  parseDeployLock,
  parseHealthProbe,
  parsePm2Jlist,
  parseSystemdUnits,
  parseReleaseRecords,
  parseSystemStats,
  splitSections,
} from './parse.js';
import { appSectionName, buildObserveScript, PM2_FAILED } from './script.js';
import { isWatt, wattUnitName } from '../runtime/watt.js';
import type { AppSnapshot, ServerSnapshot } from './snapshot.js';

export interface CollectRequest {
  apps: ShipnodeApp[];
  /** Poll interval in seconds; bounds both the SSH timeout and the health probe. */
  intervalSeconds?: number;
  /** Accessory names to sample this poll; omit to skip the (heavier) accessories section. */
  accessoryNames?: string[];
}

/**
 * One server's observer.
 *
 * Stateless by design: it holds no history, no timers, and no notion of a
 * previous tick. Scheduling and memory belong to the session above it, which
 * is what lets the same collector serve a live dashboard, a one-shot
 * `--json`, and `status` without any of them knowing about the others.
 */
export class MetricsCollector {
  constructor(
    private readonly executor: RemoteExecutor,
    private readonly server: string,
    private readonly config: ShipnodeConfig,
  ) {}

  get serverName(): string {
    return this.server;
  }

  async collect(request: CollectRequest): Promise<ServerSnapshot> {
    const timestamp = new Date().toISOString();
    const intervalSeconds = request.intervalSeconds ?? 2;
    const command = buildObserveScript(this.config, {
      apps: request.apps,
      healthMaxTimeSeconds: intervalSeconds,
      accessoryNames: request.accessoryNames,
    });

    let stdout: string;
    try {
      const result = await this.executor.exec(command, { timeout: intervalSeconds * 3000 });
      stdout = result.stdout;
    } catch (cause: unknown) {
      // An unreachable host is a state the fleet view has to render, not an
      // exception to unwind — the same stance `rollFleet` takes on a replica
      // that fails mid-roll.
      return this.unreachable(timestamp, cause instanceof Error ? cause.message : String(cause), request.apps);
    }

    const sections = splitSections(stdout);
    if (sections.size === 0) {
      return this.unreachable(timestamp, 'Observe poll returned no data', request.apps);
    }

    const accessoriesSection = sections.get('accessories');
    return {
      server: this.server,
      timestamp,
      system: parseSystemStats(sections.get('sys') ?? ''),
      accessories: accessoriesSection === undefined ? undefined : parseAccessoryStatus(accessoriesSection),
      deployLock: parseDeployLock(sections.get('lock') ?? ''),
      apps: request.apps.map((app, index) => readApp(app, index, sections)),
    };
  }

  private unreachable(timestamp: string, error: string, planned: ShipnodeApp[]): ServerSnapshot {
    return {
      server: this.server,
      timestamp,
      system: parseSystemStats(''),
      deployLock: null,
      apps: [],
      error,
      plannedApps: planned.map((app) => ({ app: app.name, appType: app.appType })),
    };
  }
}

function readApp(app: ShipnodeApp, index: number, sections: Map<string, string>): AppSnapshot {
  const at = (section: string): string | undefined => sections.get(appSectionName(index, section));
  const pm2Section = at('pm2') ?? '';
  const currentRaw = (at('current') ?? 'none').trim();
  const healthSection = at('health');
  const namespace = app.pm2?.apps[0]?.name ?? '';

  return {
    app: app.name,
    appType: app.appType,
    processes: isWatt(app)
      ? parseSystemdUnits(at('units') ?? '', namespace, wattWeb(app, namespace))
      : parsePm2Jlist(pm2Section, namespace),
    currentRelease: currentRaw === 'none' || currentRaw === '' ? null : currentRaw,
    releases: parseReleaseRecords(at('releases') ?? ''),
    health: healthSection === undefined ? undefined : parseHealthProbe(healthSection) ?? undefined,
    caddy:
      app.appType === 'frontend'
        ? parseCaddyInfo(at('caddy-status') ?? '', at('caddy-log') ?? '')
        : undefined,
    error:
      app.appType === 'backend' && app.pm2 && !isWatt(app) && pm2Section.includes(PM2_FAILED)
        ? 'PM2 command failed'
        : undefined,
  };
}

function wattWeb(app: ShipnodeApp, namespace: string): { unitBase: string; instances: number } | undefined {
  const web = app.pm2?.apps.find((p) => p.port !== undefined);
  return web === undefined ? undefined : { unitBase: wattUnitName(namespace, web.name), instances: web.instances ?? 1 };
}
