import { existsSync, watch, type Dirent, type FSWatcher } from 'fs';
import { readdir, stat } from 'fs/promises';
import { basename, join } from 'path';

/**
 * Local file watching for `shipnode deploy --watch`.
 *
 * Two concerns live here: deciding which paths are worth reacting to
 * (`isIgnoredPath`) and turning filesystem noise into debounced batches of
 * changed paths (`watchProject`). Nothing in this module talks to a remote
 * host — the hot-sync cycle does that.
 */

/** Directories never worth syncing: dependency trees, VCS metadata, caches. */
export const ALWAYS_IGNORED_DIRS = [
  'node_modules',
  '.git',
  '.shipnode',
  '.turbo',
  '.cache',
  '.nitro',
  '.vinxi',
  '.tanstack',
  'coverage',
] as const;

/**
 * Build output directories.
 *
 * Whether these should be watched depends on where the build runs, which
 * differs per project and cannot be guessed:
 *
 *   - Build on the server: the local copy is stale and irrelevant, and a
 *     locally-running build writing here would re-trigger the watcher forever.
 *     Ignore them.
 *   - Build locally and upload the artifact (Nitro/TanStack Start/Nuxt apps
 *     deployed with `--skip-build`): this output *is* the thing that has to
 *     reach the server. Ignoring it means the loop syncs source the app never
 *     runs. Watch them.
 */
export const BUILD_OUTPUT_DIRS = [
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
] as const;

/** Both sets — the default ignore list when the build runs remotely. */
export const WATCH_IGNORED_DIRS = [...ALWAYS_IGNORED_DIRS, ...BUILD_OUTPUT_DIRS] as const;

export interface IgnoreOptions {
  /** Extra directory names to ignore, e.g. parsed from `.shipnodeignore`. */
  extraIgnoredDirs?: readonly string[];
  /**
   * Treat build output as watchable. Set when the build runs locally, so its
   * output is an artifact that must be synced rather than server-side noise.
   */
  watchBuildOutput?: boolean;
}

const IGNORED_BASENAMES: readonly string[] = ['.DS_Store', '.env', 'shipnode.config.ts'];

/**
 * True when a repo-relative path should not trigger a sync.
 *
 * Editor scratch files (`.swp`, `foo.ts~`, Vim/JetBrains temp names) matter as
 * much as build output: without them a single save fires several cycles.
 */
export function isIgnoredPath(relativePath: string, options: IgnoreOptions = {}): boolean {
  if (!relativePath || relativePath === '.') return true;

  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return true;

  const ignoredDirs = new Set<string>([
    ...ALWAYS_IGNORED_DIRS,
    ...(options.watchBuildOutput ? [] : BUILD_OUTPUT_DIRS),
    ...(options.extraIgnoredDirs ?? []),
  ]);
  if (segments.some((segment) => ignoredDirs.has(segment))) return true;

  const basename = segments[segments.length - 1];
  if (IGNORED_BASENAMES.includes(basename)) return true;
  if (basename.startsWith('.env.')) return true;
  if (basename.endsWith('.log')) return true;
  if (basename.endsWith('~')) return true;
  if (basename.endsWith('.swp') || basename.endsWith('.swx')) return true;
  // JetBrains/VS Code atomic-save temp files.
  if (basename.startsWith('.#') || basename.endsWith('___jb_tmp___') || basename.endsWith('___jb_old___')) {
    return true;
  }

  return false;
}

/**
 * Directory names to ignore, read from a `.shipnodeignore` file.
 *
 * rsync applies that file authoritatively for transfers; the watcher uses it
 * only to avoid waking up for paths that would transfer nothing. That makes a
 * pragmatic subset of gitignore syntax enough — plain names and directory
 * entries, with `**​/` and trailing `/` stripped. Anything more exotic (globs,
 * negation, anchored paths) is skipped: the cost of missing one is a single
 * no-op cycle, never a missed change.
 */
export function parseIgnoreFileDirs(contents: string): string[] {
  const dirs: string[] = [];

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const withoutGlobPrefix = line.startsWith('**/') ? line.slice(3) : line;
    const name = withoutGlobPrefix.replace(/\/+$/, '');
    // Only plain single-segment names map cleanly onto the watcher's
    // per-segment matching; leave anything else to rsync.
    if (!name || name.includes('/') || name.includes('*')) continue;
    dirs.push(name);
  }

  return [...new Set(dirs)];
}

export interface ProjectWatcher {
  /** Stop watching and release OS handles. */
  close(): void;
  /**
   * Stop recording events. Used around a build we run ourselves: a build
   * writes inside the watched tree — codegen like `routeTree.gen.ts`, temp
   * files — and reacting to those writes would re-trigger the build that made
   * them. Path-based ignores cannot catch this reliably; knowing *when* we
   * wrote can.
   */
  pause(): void;
  /** Resume recording, discarding anything that arrived while paused. */
  resume(): void;
  /** Which mechanism is in use — reported to the user for diagnosability. */
  readonly mode: 'native' | 'poll';
}

export interface WatchProjectOptions {
  /** Extra directory names to ignore, on top of the built-in list. */
  ignoredDirs?: readonly string[];
  /** Watch build output — set when the build runs locally. See `BUILD_OUTPUT_DIRS`. */
  watchBuildOutput?: boolean;
  /** Quiet period before a batch is emitted. Coalesces multi-file saves. */
  debounceMs?: number;
  /**
   * Ceiling on how long changes may sit unemitted while events keep arriving.
   * Without it a repo with a background writer (a turbo daemon, a framework's
   * own watcher) resets the debounce forever and no batch is ever emitted.
   */
  maxWaitMs?: number;
  /** Interval for the polling fallback. */
  pollIntervalMs?: number;
  /** Called with repo-relative paths once the debounce window closes. */
  onBatch: (paths: string[]) => void;
  onError?: (error: Error) => void;
}

/**
 * Watch `cwd` recursively and emit debounced batches of changed paths.
 *
 * Prefers `fs.watch` with `recursive: true`. That is unavailable on Linux
 * before Node 20.13, so we fall back to an mtime-scan poller rather than
 * failing — a slower loop beats no loop, and the mode is reported to the user.
 */
export function watchProject(cwd: string, options: WatchProjectOptions): ProjectWatcher {
  const debounceMs = options.debounceMs ?? 250;
  const ignoreOptions: IgnoreOptions = {
    extraIgnoredDirs: options.ignoredDirs ?? [],
    watchBuildOutput: options.watchBuildOutput ?? false,
  };

  const maxWaitMs = options.maxWaitMs ?? 2000;

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let firstPendingAt: number | undefined;
  let closed = false;
  let paused = false;

  const emit = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    firstPendingAt = undefined;
    if (closed || pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    options.onBatch(batch);
  };

  // macOS reports activity on the watched directory itself using that
  // directory's own basename as `filename`. Left alone it becomes a bogus
  // relative path that no local file matches, forcing a full-tree fallback on
  // the next sync. Only filter it when no real entry shares the name.
  const rootName = basename(cwd);

  const record = (relativePath: string): void => {
    if (closed || paused) return;
    if (relativePath === rootName && !existsSync(join(cwd, rootName))) return;
    if (isIgnoredPath(relativePath, ignoreOptions)) return;

    pending.add(relativePath);
    firstPendingAt ??= Date.now();

    // Never let a steady drip of events postpone the batch indefinitely: once
    // the oldest pending change has waited `maxWaitMs`, emit regardless.
    const waited = Date.now() - firstPendingAt;
    if (waited >= maxWaitMs) {
      emit();
      return;
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(emit, Math.min(debounceMs, maxWaitMs - waited));
  };

  const pause = (): void => {
    paused = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    firstPendingAt = undefined;
    pending.clear();
  };

  const resume = (): void => {
    // Anything recorded up to this instant was our own doing; start clean.
    pending.clear();
    firstPendingAt = undefined;
    paused = false;
  };

  let native: FSWatcher | undefined;
  try {
    native = watch(cwd, { recursive: true, persistent: true }, (_event, filename) => {
      if (filename) record(filename.toString());
    });
    native.on('error', (error: Error) => options.onError?.(error));
  } catch {
    native = undefined;
  }

  if (native) {
    const watcher = native;
    return {
      mode: 'native',
      pause,
      resume,
      close(): void {
        closed = true;
        if (timer) clearTimeout(timer);
        watcher.close();
      },
    };
  }

  const poller = startPoller(cwd, {
    ignoreOptions,
    intervalMs: options.pollIntervalMs ?? 700,
    onChange: record,
    onError: options.onError,
  });

  return {
    mode: 'poll',
    pause,
    resume,
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      poller();
    },
  };
}

/**
 * mtime-scan fallback. Walks the tree on an interval, skipping ignored
 * directories so the scan stays proportional to source files, not to
 * `node_modules`. Returns a stop function.
 */
function startPoller(
  cwd: string,
  options: {
    ignoreOptions: IgnoreOptions;
    intervalMs: number;
    onChange: (relativePath: string) => void;
    onError?: (error: Error) => void;
  },
): () => void {
  const seen = new Map<string, number>();
  let stopped = false;
  let scanning = false;
  let primed = false;

  const scan = async (): Promise<void> => {
    if (stopped || scanning) return;
    scanning = true;
    const current = new Map<string, number>();

    try {
      await walk(cwd, '', current, options.ignoreOptions);

      for (const [path, mtime] of current) {
        const previous = seen.get(path);
        if (previous === undefined || previous !== mtime) {
          // The first scan only establishes a baseline; emitting there would
          // sync the whole tree the moment watch starts.
          if (primed) options.onChange(path);
        }
      }

      seen.clear();
      for (const [path, mtime] of current) seen.set(path, mtime);
      primed = true;
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      scanning = false;
    }
  };

  void scan();
  const interval = setInterval(() => void scan(), options.intervalMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

async function walk(
  root: string,
  relativeDir: string,
  into: Map<string, number>,
  ignoreOptions: IgnoreOptions,
): Promise<void> {
  const absoluteDir = relativeDir ? join(root, relativeDir) : root;
  let entries: Dirent[];
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (isIgnoredPath(relativePath, ignoreOptions)) continue;

    if (entry.isDirectory()) {
      await walk(root, relativePath, into, ignoreOptions);
      continue;
    }

    try {
      const stats = await stat(join(root, relativePath));
      into.set(relativePath, stats.mtimeMs);
    } catch {
      // Vanished between readdir and stat — the next scan will catch up.
    }
  }
}
