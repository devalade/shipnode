import type { ShipnodeApp } from '../../shared/types.js';

/**
 * Shell command that symlinks `.env` into compiled-output directories so
 * frameworks whose env loaders resolve relative to the *built app root*
 * (AdonisJS, NestJS) find it. Three sources, in order of trust:
 *   1. `appRoot` config — explicit user declaration for monorepos
 *   2. repo-root `build` / `dist` — the single-app convention
 *   3. obvious monorepo layouts: `apps/*​/build`, `packages/*​/build`, dist twins
 *
 * We never traverse into node_modules and never overwrite an existing `.env`
 * file. Shared by the initial deploy and by `deploy --watch`, whose remote
 * build can wipe and recreate the output directory (taking the symlink with
 * it), so the links must be re-established after every build.
 */
export function envSymlinkCommand(app: ShipnodeApp, workDir: string): string {
  if (!app.envFile) return 'true';

  const targets: string[] = [];
  if (app.appRoot) {
    targets.push(`${app.appRoot}/build`, `${app.appRoot}/dist`);
  }
  // Always include the single-app convention.
  targets.push('build', 'dist');
  const explicit = targets.map((target) => `"${target}"`).join(' ');

  // Wrapped in `{ ...; } || true` so projects without a `.env` file or with no
  // matching build dirs don't break the install/build chain. `nullglob` makes
  // `apps/*/build` collapse to nothing when there's no match.
  return (
    `{ [ -f .env ] && shopt -s nullglob && ` +
    `for dir in ${explicit} apps/*/build packages/*/build apps/*/dist packages/*/dist; do ` +
    `if [ -d "$dir" ] && [ ! -e "$dir/.env" ]; then ln -sf "${workDir}/.env" "$dir/.env"; fi; ` +
    `done; shopt -u nullglob; } || true`
  );
}
