import chalk from 'chalk';
import { runRemoteCommandForTargets } from '../runner.js';
import { isWatt, logsCommand, resolveWattUnits } from '../../domain/runtime/watt.js';
import { loadConfig } from '../../config/loader.js';
import {
  compileQuery,
  EMPTY_LOG_FILTER,
  matchesLogFilter,
  parseLevelOption,
  type LogFilter,
} from '../../domain/observe/log-filter.js';
import { detectLevel, LOG_LEVEL_RANK, type LogLine } from '../../domain/observe/log-line.js';
import { planLogSources } from '../../domain/observe/log-source.js';
import { getPm2Name } from '../../domain/pm2/apps.js';
import { LogStream, type LogBinding } from '../../services/observe/log-stream.js';
import { connectFleet, planObserveHosts } from '../observe.js';
import { ui } from '../ui.js';

export interface LogsOptions {
  lines?: number;
  config?: string;
  process?: string;
  app?: string;
  on?: string;
  follow?: boolean;
  /** Show this level and above: warn or error. */
  level?: string;
  /** Plain text, `/regex/`, or `!not`. */
  grep?: string;
}

/**
 * Prefix every line, not every block.
 *
 * A fleet interleaves output from several servers, and a block-level prefix
 * leaves the reader guessing which box a stack trace came from once the second
 * server's output starts.
 */
function prefixLines(text: string, label: string, keep: (line: string) => boolean): string {
  return text
    .split('\n')
    .filter((line) => line.length > 0 && keep(line))
    .map((line) => `${label} ${line}`)
    .join('\n');
}

/** Level and text filtering for raw text, where no stream has classified the line yet. */
function textFilter(filter: LogFilter): (line: string) => boolean {
  const { matcher } = compileQuery(filter.query);
  const min = filter.minLevel === null ? 0 : LOG_LEVEL_RANK[filter.minLevel];
  return (line) => (LOG_LEVEL_RANK[detectLevel(line) ?? 'info'] >= min) && (matcher === null || matcher(line));
}

function filterFromOptions(options: LogsOptions): LogFilter | null {
  const level = parseLevelOption(options.level);
  if (level.error !== undefined) {
    ui.error(level.error);
    return null;
  }
  const { error } = compileQuery(options.grep ?? '');
  if (error !== undefined) {
    ui.error(`Invalid --grep: ${error}`);
    return null;
  }
  return { ...EMPTY_LOG_FILTER, minLevel: level.level, query: options.grep ?? '' };
}

export async function cmdLogs(cwd: string, options: LogsOptions): Promise<void> {
  const filter = filterFromOptions(options);
  if (filter === null) {
    process.exit(1);
    return;
  }
  if (options.follow) {
    await followLogs(cwd, options, filter);
    return;
  }

  const keep = textFilter(filter);
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const apps = options.app
        ? config.apps.filter((app) => app.name === options.app)
        : config.apps.filter((a) => a.appType === 'backend' && a.pm2);

      if (options.app && apps.length === 0) return;

      if (apps.length === 0) {
        if (options.app) return;
        throw new Error('No backend apps with PM2 configured');
      }

      if (options.process && apps.length > 1) {
        throw new Error('--process requires --app to target a specific app');
      }

      const lines = options.lines ?? 100;
      const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
      const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

      for (const app of apps) {
        if (isWatt(app)) {
          const units = await resolveWattUnits(executor, `${config.remotePath}/${app.name}`, app, { process: options.process, colors: 'active' });
          for (const unit of units) {
            const result = await executor.exec(logsCommand(unit, { lines }));
            const label = `[${serverName} ${app.name} ${unit}]`;
            if (result.stdout) process.stdout.write(`${prefixLines(result.stdout, label, keep)}\n`);
            if (result.stderr) process.stderr.write(`${prefixLines(result.stderr, label, keep)}\n`);
          }
          continue;
        }
        const namespace = app.pm2!.apps[0].name;
        const target = options.process
          ? app.pm2!.apps.find((a) => a.name === options.process)?.name ?? namespace
          : namespace;
        const result = await executor.exec(
          `${mise}; mise exec "node@${nodeVersion}" -- pm2 logs ${target} --lines ${lines} --nostream`,
        );
        const label = `[${serverName} ${app.name}]`;
        if (result.stdout) process.stdout.write(`${prefixLines(result.stdout, label, keep)}\n`);
        if (result.stderr) process.stderr.write(`${prefixLines(result.stderr, label, keep)}\n`);
      }
    },
    { configPath: options.config, appName: options.app, serverName: options.on },
  );
}

const SERVER_COLORS = [chalk.cyan, chalk.magenta, chalk.blue, chalk.greenBright, chalk.whiteBright];

/**
 * `shipnode logs --follow`: every server at once, merged, until Ctrl-C.
 *
 * The same stream the monitor uses, so what counts as an error and how a
 * reconnect avoids replaying lines are not re-implemented for the CLI. Lines go
 * to stdout and status to stderr, so `shipnode logs -f | grep ...` stays clean.
 */
async function followLogs(cwd: string, options: LogsOptions, initialFilter: LogFilter): Promise<void> {
  let filter = initialFilter;
  const config = await loadConfig(cwd, options.config);
  const plan = planObserveHosts(config, { app: options.app, on: options.on });
  if (plan.isErr()) {
    ui.error(plan.error.message);
    process.exit(1);
    return;
  }

  const fleet = await connectFleet(config, plan.value);
  try {
    // A process name only means something within one app; the stream labels
    // lines with the full PM2-style name, so translate the short one once.
    if (options.process !== undefined) {
      const candidates = [...new Map(fleet.hosts.flatMap((host) => host.apps).map((app) => [app.name, app])).values()];
      if (candidates.length !== 1) {
        ui.error('--process requires --app to target a specific app');
        process.exit(1);
        return;
      }
      const app = candidates[0];
      const declared = app.pm2?.apps ?? [];
      if (!declared.some((p) => p.name === options.process)) {
        ui.error(`No process named '${options.process}'. Known: ${declared.map((p) => p.name).join(', ') || '(none)'}`);
        process.exit(1);
        return;
      }
      filter = { ...filter, process: getPm2Name(declared[0].name, options.process) };
    }

    const bindings: LogBinding[] = [];
    for (const host of fleet.hosts) {
      if (host.executor === null) {
        ui.warn(`${host.name}: ${host.error ?? 'unreachable'}`);
        continue;
      }
      const apps = options.app === undefined ? host.apps : host.apps.filter((app) => app.name === options.app);
      for (const app of apps) {
        try {
          const sources = await planLogSources(host.executor, host.name, host.config.remotePath, app);
          for (const source of sources) bindings.push({ executor: host.executor, source });
        } catch (cause: unknown) {
          ui.warn(`${host.name}/${app.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }

    if (bindings.length === 0) {
      ui.error('Nothing to follow: no reachable server runs a matching app.');
      process.exit(1);
      return;
    }

    const serverNames = [...new Set(bindings.map((binding) => binding.source.server))].sort();
    const multiServer = serverNames.length > 1;
    const multiApp = new Set(bindings.map((binding) => binding.source.app)).size > 1;

    const print = (line: LogLine): void => {
      if (!matchesLogFilter(line, filter)) return;
      const who = line.process === null || line.process === line.app ? '' : `:${line.process}`;
      const head = [multiServer ? line.server : null, multiApp ? line.app : null].filter((p) => p !== null).join(' ');
      const label = head === '' && who === '' ? '' : `[${head}${who}] `;
      const color = SERVER_COLORS[serverNames.indexOf(line.server) % SERVER_COLORS.length];
      const text = line.level === 'error' ? chalk.red(line.text) : line.level === 'warn' ? chalk.yellow(line.text) : line.text;
      process.stdout.write(`${label === '' ? '' : color(label)}${text}\n`);
    };

    const stream = new LogStream({ bindings, backlog: options.lines ?? 100, onLine: print });
    stream.start();
    ui.info(`Following ${bindings.length} source(s) on ${serverNames.join(', ')} — Ctrl-C to stop`);

    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await stream.stop();
  } finally {
    fleet.close();
  }
}
