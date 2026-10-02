import type { RemoteExecutor } from '../remote/executor.js';
import type { ShipnodeApp } from '../../shared/types.js';
import { getPm2Name } from '../pm2/apps.js';
import { isWatt, resolveWattUnits } from '../runtime/watt.js';
import { MISE, shellQuote } from './script.js';
import { parsePlainLine, parsePm2Line, type ParsedLine } from './log-line.js';

/**
 * One thing worth following: a command that prints log lines forever, plus how
 * to read what it prints.
 *
 * PM2 gives one stream per app (it multiplexes processes and prefixes each
 * line); systemd gives one per unit; Caddy one per access-log file. Each
 * source tags its lines with the server and app it belongs to, so a stream
 * never has to guess.
 */
export interface LogSource {
  server: string;
  app: string;
  kind: 'pm2' | 'systemd' | 'caddy';
  /** Follow command, replaying `backlog` lines first. */
  command(backlog: number): string;
  parse(raw: string): ParsedLine | null;
}

export function pm2FollowCommand(namespace: string, backlog: number): string {
  return `${MISE} && pm2 logs ${shellQuote(namespace)} --lines ${backlog} --no-color 2>&1`;
}

export function journalFollowCommand(unit: string, backlog: number): string {
  return (
    `S=$([ "$(id -u)" = 0 ] || echo sudo); ` +
    `$S journalctl -u ${shellQuote(unit)} -n ${backlog} -f --no-pager -o cat 2>&1`
  );
}

export function caddyFollowCommand(appName: string, backlog: number): string {
  const file = shellQuote(`/var/log/caddy/${appName}.log`);
  // -F keeps following across log rotation; `sudo -n` fails fast rather than prompting.
  return `sudo -n tail -n ${backlog} -F ${file} 2>/dev/null || tail -n ${backlog} -F ${file} 2>&1`;
}

/**
 * The sources for one app on one server. Watt units are resolved by asking the
 * host, because a blue-green unit carries a colour only the host knows.
 */
export async function planLogSources(
  executor: RemoteExecutor,
  server: string,
  remotePath: string,
  app: ShipnodeApp,
): Promise<LogSource[]> {
  if (app.appType === 'frontend') {
    return [
      {
        server,
        app: app.name,
        kind: 'caddy',
        command: (backlog) => caddyFollowCommand(app.name, backlog),
        parse: parsePlainLine(null),
      },
    ];
  }

  const processes = app.pm2?.apps ?? [];
  if (processes.length === 0) return [];

  if (isWatt(app)) {
    // One unit per declared process, in declaration order. The lines are labelled
    // with the PM2-style name so a process filter means the same on either supervisor.
    const units = await resolveWattUnits(executor, `${remotePath}/${app.name}`, app, { colors: 'active' });
    return units.map((unit, index) => ({
      server,
      app: app.name,
      kind: 'systemd' as const,
      command: (backlog: number) => journalFollowCommand(unit, backlog),
      parse: parsePlainLine(getPm2Name(processes[0].name, processes[index].name)),
    }));
  }

  // Same namespace `shipnode logs` and the collector use: the first process names the deployment.
  const namespace = processes[0].name;
  return [
    {
      server,
      app: app.name,
      kind: 'pm2',
      command: (backlog) => pm2FollowCommand(namespace, backlog),
      parse: parsePm2Line,
    },
  ];
}
