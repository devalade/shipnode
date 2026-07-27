import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import {
  ALWAYS_IGNORED_DIRS,
  BUILD_OUTPUT_DIRS,
  isIgnoredPath,
  parseIgnoreFileDirs,
  watchProject,
  WATCH_IGNORED_DIRS,
} from '../../src/domain/deploy/watcher.js';

describe('isIgnoredPath', () => {
  it('reacts to source files', () => {
    expect(isIgnoredPath('src/index.ts')).toBe(false);
    expect(isIgnoredPath('package.json')).toBe(false);
    expect(isIgnoredPath('apps/api/src/routes/users.ts')).toBe(false);
    expect(isIgnoredPath('pnpm-lock.yaml')).toBe(false);
  });

  it('ignores dependency trees and VCS metadata at any depth', () => {
    expect(isIgnoredPath('node_modules/express/index.js')).toBe(true);
    expect(isIgnoredPath('packages/core/node_modules/lodash/x.js')).toBe(true);
    expect(isIgnoredPath('.git/HEAD')).toBe(true);
    expect(isIgnoredPath('.shipnode/releases.json')).toBe(true);
  });

  it('ignores build output so a remote build cannot re-trigger the loop', () => {
    for (const dir of WATCH_IGNORED_DIRS) {
      expect(isIgnoredPath(`${dir}/whatever.js`)).toBe(true);
    }
    expect(isIgnoredPath('apps/web/dist/index.js')).toBe(true);
    expect(isIgnoredPath('.next/server/app.js')).toBe(true);
  });

  it('ignores secrets and generated noise that a deploy never ships', () => {
    expect(isIgnoredPath('.env')).toBe(true);
    expect(isIgnoredPath('.env.production')).toBe(true);
    expect(isIgnoredPath('shipnode.config.ts')).toBe(true);
    expect(isIgnoredPath('server.log')).toBe(true);
    expect(isIgnoredPath('.DS_Store')).toBe(true);
  });

  it('ignores editor scratch files so one save is one cycle', () => {
    expect(isIgnoredPath('src/index.ts~')).toBe(true);
    expect(isIgnoredPath('src/.index.ts.swp')).toBe(true);
    expect(isIgnoredPath('src/.#index.ts')).toBe(true);
    expect(isIgnoredPath('src/index.ts___jb_tmp___')).toBe(true);
  });

  it('honours extra ignored directories', () => {
    expect(isIgnoredPath('generated/client.ts')).toBe(false);
    expect(isIgnoredPath('generated/client.ts', { extraIgnoredDirs: ['generated'] })).toBe(true);
  });

  it('treats empty and dot paths as ignorable', () => {
    expect(isIgnoredPath('')).toBe(true);
    expect(isIgnoredPath('.')).toBe(true);
  });

  it('handles windows-style separators', () => {
    expect(isIgnoredPath('src\\index.ts')).toBe(false);
    expect(isIgnoredPath('node_modules\\express\\index.js')).toBe(true);
  });
});

describe('watchProject', () => {
  /**
   * Start a watcher, let it settle, and resolve with the first batch produced
   * by `act`. Batches arriving before `act` are discarded: creating the fixture
   * files generates events of its own, and on macOS the watched directory
   * reports itself once when the watch is established.
   */
  async function captureBatches(
    dir: string,
    act: () => Promise<void>,
    options: { debounceMs?: number; settleMs?: number; waitMs?: number } = {},
  ): Promise<string[][]> {
    const debounceMs = options.debounceMs ?? 80;
    const batches: string[][] = [];
    let listening = false;

    const watcher = watchProject(dir, {
      debounceMs,
      pollIntervalMs: 60,
      onBatch: (paths) => {
        if (listening) batches.push(paths);
      },
    });

    try {
      await delay(options.settleMs ?? 400);
      listening = true;
      await act();
      await delay(options.waitMs ?? debounceMs + 600);
    } finally {
      watcher.close();
    }

    return batches;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function flatten(batches: string[][]): string[] {
    return batches.flat().map((path) => path.replace(/\\/g, '/'));
  }

  it('reports a changed source file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shipnode-watch-test-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const a = 1;\n');

    const batches = await captureBatches(dir, async () => {
      await writeFile(join(dir, 'src', 'index.ts'), 'export const a = 2;\n');
    });

    expect(flatten(batches)).toContain('src/index.ts');

    await rm(dir, { recursive: true, force: true });
  });

  it('does not report build output, so a remote build cannot loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shipnode-watch-test-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(dir, 'dist', 'index.js'), 'const a = 1;\n');

    const batches = await captureBatches(dir, async () => {
      await writeFile(join(dir, 'dist', 'index.js'), 'const a = 2;\n');
      await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    });

    expect(batches).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('never reports the watched directory itself as a changed path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shipnode-watch-test-'));
    await writeFile(join(dir, 'index.ts'), 'a\n');

    const batches = await captureBatches(dir, async () => {
      await writeFile(join(dir, 'index.ts'), 'b\n');
    });

    // A path equal to the temp directory's own basename would resolve to
    // nothing locally and force every sync into a full-tree scan.
    expect(flatten(batches)).not.toContain(basename(dir));
    expect(flatten(batches)).toContain('index.ts');

    await rm(dir, { recursive: true, force: true });
  });

  it('coalesces a multi-file save into one batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shipnode-watch-test-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'a\n');
    await writeFile(join(dir, 'src', 'b.ts'), 'b\n');

    const batches = await captureBatches(
      dir,
      async () => {
        await writeFile(join(dir, 'src', 'a.ts'), 'aa\n');
        await writeFile(join(dir, 'src', 'b.ts'), 'bb\n');
      },
      { debounceMs: 200 },
    );

    // One save of two files must be one sync, not two.
    expect(batches).toHaveLength(1);
    expect(flatten(batches)).toContain('src/a.ts');
    expect(flatten(batches)).toContain('src/b.ts');

    await rm(dir, { recursive: true, force: true });
  });
});

describe('build output visibility', () => {
  it('ignores build output when the build runs on the server', () => {
    for (const dir of BUILD_OUTPUT_DIRS) {
      expect(isIgnoredPath(`apps/qr/${dir}/server/index.mjs`)).toBe(true);
    }
  });

  it('watches build output when the build runs locally', () => {
    // Projects that build locally and upload the artifact (deployed with
    // --skip-build) need the output to trigger a sync; ignoring it would ship
    // source the app never runs.
    for (const dir of BUILD_OUTPUT_DIRS) {
      expect(isIgnoredPath(`apps/qr/${dir}/server/index.mjs`, { watchBuildOutput: true })).toBe(false);
    }
  });

  it('still ignores deps and caches when watching build output', () => {
    for (const dir of ALWAYS_IGNORED_DIRS) {
      expect(isIgnoredPath(`${dir}/x.js`, { watchBuildOutput: true })).toBe(true);
    }
  });
});

describe('parseIgnoreFileDirs', () => {
  it('extracts plain directory names, skipping comments and blanks', () => {
    expect(parseIgnoreFileDirs('# comment\n\n.turbo/\ncoverage\n')).toEqual(['.turbo', 'coverage']);
  });

  it('strips a leading **/ so nested matches are covered by segment matching', () => {
    expect(parseIgnoreFileDirs('**/.nitro/')).toEqual(['.nitro']);
  });

  it('leaves anchored paths, globs, and negations to rsync', () => {
    expect(parseIgnoreFileDirs('pocketbase/pb_data/\n*.tmp\n!keep\n')).toEqual([]);
  });

  it('deduplicates repeated entries', () => {
    expect(parseIgnoreFileDirs('.turbo/\n**/.turbo/\n')).toEqual(['.turbo']);
  });
});

describe('watch-mode build output policy', () => {
  /**
   * Mirrors the rule the watch session applies. Watching output is only safe
   * when shipnode is not the thing writing it — otherwise each cycle's build
   * feeds itself back in and rebuilds forever.
   */
  function watchesOutput(buildLocation: 'remote' | 'local' | 'none'): boolean {
    return !isIgnoredPath('apps/qr/.output/server/index.mjs', {
      watchBuildOutput: buildLocation === 'none',
    });
  }

  it('does not watch output when shipnode runs the build', () => {
    // `local` runs vite here; watching .output would loop on our own writes.
    expect(watchesOutput('local')).toBe(false);
    expect(watchesOutput('remote')).toBe(false);
  });

  it('watches output when the developer runs the build', () => {
    // `none` — output changing is the only signal there is anything to ship.
    expect(watchesOutput('none')).toBe(true);
  });
});

describe('debounce starvation', () => {
  it('emits while events keep arriving, not only once they stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shipnode-watch-test-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'a\n');

    const duringDrip: number[] = [];
    const watcher = watchProject(dir, {
      debounceMs: 200,
      maxWaitMs: 500,
      pollIntervalMs: 60,
      onBatch: () => duringDrip.push(Date.now()),
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    duringDrip.length = 0;

    // A background writer touching a watched file faster than the debounce
    // window — the shape of a turbo/vite daemon in a live repo. Without a
    // ceiling every event resets the timer and nothing is emitted until the
    // writes stop, which in a busy repo is never.
    const dripEnd = Date.now() + 1600;
    while (Date.now() < dripEnd) {
      await writeFile(join(dir, 'src', 'a.ts'), `a${Date.now()}\n`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const emittedWhileBusy = duringDrip.filter((at) => at < dripEnd).length;

    await new Promise((resolve) => setTimeout(resolve, 400));
    watcher.close();

    expect(emittedWhileBusy).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('pause / resume', () => {
  it('drops events that arrive while paused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shipnode-watch-test-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'gen.ts'), 'a\n');

    const batches: string[][] = [];
    const watcher = watchProject(dir, {
      debounceMs: 80,
      maxWaitMs: 300,
      pollIntervalMs: 60,
      onBatch: (paths) => batches.push(paths),
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    batches.length = 0;

    // Stand in for our own build regenerating a source file.
    watcher.pause();
    await writeFile(join(dir, 'src', 'gen.ts'), 'generated\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    watcher.resume();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(batches).toEqual([]);

    // A real edit after resume still lands.
    await writeFile(join(dir, 'src', 'gen.ts'), 'edited by hand\n');
    await new Promise((resolve) => setTimeout(resolve, 600));
    watcher.close();

    expect(batches.flat()).toContain('src/gen.ts');

    await rm(dir, { recursive: true, force: true });
  });
});
