import { randomBytes } from 'node:crypto';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { BackupConfig, ShipnodeConfig, NetworkDatabaseConfig } from '../../shared/types.js';

const BACKUP_SCRIPT_PATH = '/usr/local/bin/shipnode-backup.sh';
const BACKUP_ENV_PATH = '/etc/shipnode/backup.env';
const TIMER_NAME = 'shipnode-backup';

interface ScriptContext {
  remotePath: string;
  hostname: string;
  db?: NetworkDatabaseConfig | { type: 'sqlite'; name: string };
  cfg: Required<Pick<BackupConfig, 's3Bucket'>> & BackupConfig;
}

// ─────────────────────────────────────────────────────────────
// Snapshot strategy (original, back-compat)
// ─────────────────────────────────────────────────────────────

function buildSnapshotScript(ctx: ScriptContext): string {
  const { cfg, db, remotePath } = ctx;
  const prefix = cfg.s3Prefix ? cfg.s3Prefix.replace(/\/$/, '') + '/' : '';
  const endpointFlag = cfg.s3Endpoint ? `--endpoint-url "${cfg.s3Endpoint}"` : '';
  const ts = '$(date +%Y%m%d_%H%M%S)';

  const netDb = db && db.type !== 'sqlite' ? db : undefined;
  const dbDump = netDb
    ? `
# Database backup
DB_FILE="/tmp/db_${ts}.sql"
${netDb.type === 'postgres' ? `PGPASSWORD="$DB_PASSWORD" pg_dump -h "${netDb.host}" -p "${netDb.port ?? 5432}" -U "${netDb.user}" "${netDb.name}" > "$DB_FILE"` : ''}
${netDb.type === 'mysql' ? `mysqldump -h "${netDb.host}" -P "${netDb.port ?? 3306}" -u "${netDb.user}" -p"$DB_PASSWORD" "${netDb.name}" > "$DB_FILE"` : ''}
aws s3 cp "$DB_FILE" "s3://${cfg.s3Bucket}/${prefix}db/$(basename "$DB_FILE")" ${endpointFlag}
rm -f "$DB_FILE"
`
    : '';

  return `#!/bin/bash
set -euo pipefail

[ -f ${BACKUP_ENV_PATH} ] && . ${BACKUP_ENV_PATH}

TIMESTAMP="${ts}"
DEPLOY_PATH="${remotePath}"

echo "[shipnode-backup] Starting snapshot backup at $TIMESTAMP"

SHARED_ARCHIVE="/tmp/shared_${ts}.tar.gz"
tar -czf "$SHARED_ARCHIVE" -C "$DEPLOY_PATH/shared" . 2>/dev/null || true
aws s3 cp "$SHARED_ARCHIVE" "s3://${cfg.s3Bucket}/${prefix}shared/$(basename "$SHARED_ARCHIVE")" ${endpointFlag}
rm -f "$SHARED_ARCHIVE"
${dbDump}
echo "[shipnode-backup] Done"
`;
}

// ─────────────────────────────────────────────────────────────
// Restic strategy (incremental, block-dedup, encrypted)
// ─────────────────────────────────────────────────────────────

function buildResticScript(ctx: ScriptContext): string {
  const { cfg, db, remotePath, hostname } = ctx;
  const netDb = db && db.type !== 'sqlite' ? db : undefined;
  const keepDaily = cfg.keepDaily ?? 7;
  const keepWeekly = cfg.keepWeekly ?? 4;
  const keepMonthly = cfg.keepMonthly ?? 6;

  const dbBlock = netDb
    ? `
# Streamed DB dump into restic — no on-disk copy, dedup happens block-wise
if [ "$DB_TYPE" = "postgres" ]; then
  PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" \\
    | restic backup --stdin --stdin-filename db.sql --tag db --host "${hostname}"
elif [ "$DB_TYPE" = "mysql" ]; then
  mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" \\
    | restic backup --stdin --stdin-filename db.sql --tag db --host "${hostname}"
fi
`
    : '';

  return `#!/bin/bash
set -euo pipefail

. ${BACKUP_ENV_PATH}

export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

DEPLOY_PATH="${remotePath}"

echo "[shipnode-backup] Starting restic backup at $(date -Iseconds)"

# Init the repo on first run (idempotent — restic init errors cleanly if it exists)
if ! restic snapshots -q >/dev/null 2>&1; then
  echo "[shipnode-backup] Initializing restic repository at $RESTIC_REPOSITORY"
  restic init
fi
${dbBlock}
# Shared files (deltas at block level — 4-16 MiB chunks)
if [ -d "$DEPLOY_PATH/shared" ]; then
  restic backup "$DEPLOY_PATH/shared" --tag files --host "${hostname}"
fi

# Retention: keep last N daily, N weekly, N monthly snapshots — prune inline
restic forget --prune \\
  --keep-daily ${keepDaily} \\
  --keep-weekly ${keepWeekly} \\
  --keep-monthly ${keepMonthly}

echo "[shipnode-backup] Done"
`;
}

// ─────────────────────────────────────────────────────────────
// Env file passed to the script via systemd EnvironmentFile
// ─────────────────────────────────────────────────────────────

function buildBackupEnv(
  strategy: 'snapshot' | 'restic',
  db: ShipnodeConfig['database'],
  creds: { awsKeyId?: string; awsSecret?: string; resticPassword?: string; resticRepository?: string },
): string {
  const lines: string[] = [];
  if (creds.awsKeyId) lines.push(`AWS_ACCESS_KEY_ID='${creds.awsKeyId}'`);
  if (creds.awsSecret) lines.push(`AWS_SECRET_ACCESS_KEY='${creds.awsSecret}'`);
  if (strategy === 'restic') {
    if (creds.resticPassword) lines.push(`RESTIC_PASSWORD='${creds.resticPassword}'`);
    if (creds.resticRepository) lines.push(`RESTIC_REPOSITORY='${creds.resticRepository}'`);
    // systemd services boot with a minimal env — restic warns "neither
    // $XDG_CACHE_HOME nor $HOME are defined" and re-fetches R2 indexes every
    // run without a persistent cache. Pinning HOME lets restic cache under
    // /root/.cache/restic across runs.
    lines.push(`HOME='/root'`);
  }
  if (db && db.type !== 'sqlite') {
    lines.push(`DB_TYPE='${db.type}'`);
    lines.push(`DB_HOST='${db.host}'`);
    lines.push(`DB_PORT='${db.port}'`);
    lines.push(`DB_USER='${db.user}'`);
    lines.push(`DB_NAME='${db.name}'`);
    if (db.password) lines.push(`DB_PASSWORD='${db.password}'`);
  }
  return lines.join('\n') + '\n';
}

function buildResticRepositoryUrl(cfg: BackupConfig): string {
  const endpoint = cfg.s3Endpoint ?? 's3.amazonaws.com';
  // restic's S3 URL: s3:<endpoint>/<bucket>[/prefix]
  const host = endpoint.replace(/^https?:\/\//, '');
  const prefix = cfg.s3Prefix ? '/' + cfg.s3Prefix.replace(/^\/|\/$/g, '') : '';
  return `s3:https://${host}/${cfg.s3Bucket}${prefix}`;
}

export function scheduleToSystemd(schedule: 'hourly' | 'daily' | 'weekly'): string {
  const map: Record<string, string> = {
    hourly: '*:00:00',
    daily: '*-*-* 02:00:00',
    weekly: 'Mon *-*-* 02:00:00',
  };
  return map[schedule] ?? map.daily;
}

// ─────────────────────────────────────────────────────────────
// Remote helpers
// ─────────────────────────────────────────────────────────────

async function ensureCommand(
  executor: RemoteExecutor,
  cmd: string,
  installScript: string,
): Promise<void> {
  const check = await executor.exec(`command -v ${cmd} 2>/dev/null || echo MISSING`);
  if (check.stdout.trim() === 'MISSING') {
    await executor.execOrThrow(installScript);
  }
}

async function writeRemoteFile(
  executor: RemoteExecutor,
  path: string,
  content: string,
  mode = '644',
): Promise<void> {
  const b64 = Buffer.from(content).toString('base64');
  await executor.execOrThrow(
    `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
    `$SUDO mkdir -p "$(dirname "${path}")" && ` +
    `printf '%s' '${b64}' | base64 -d | $SUDO tee "${path}" > /dev/null && ` +
    `$SUDO chmod ${mode} "${path}"`,
  );
}

async function installSystemdUnits(
  executor: RemoteExecutor,
  schedule: 'hourly' | 'daily' | 'weekly',
  strategy: 'snapshot' | 'restic',
): Promise<void> {
  const onCalendar = scheduleToSystemd(schedule);
  const service = `[Unit]
Description=ShipNode backup (${strategy})

[Service]
Type=oneshot
EnvironmentFile=${BACKUP_ENV_PATH}
ExecStart=${BACKUP_SCRIPT_PATH}
`;
  const timer = `[Unit]
Description=ShipNode backup timer

[Timer]
OnCalendar=${onCalendar}
Persistent=true

[Install]
WantedBy=timers.target
`;

  await writeRemoteFile(executor, `/etc/systemd/system/${TIMER_NAME}.service`, service);
  await writeRemoteFile(executor, `/etc/systemd/system/${TIMER_NAME}.timer`, timer);
  await executor.execOrThrow(
    `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
    `$SUDO systemctl daemon-reload && $SUDO systemctl enable --now ${TIMER_NAME}.timer`,
  );
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

export async function cmdBackupSetup(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (!config.backup) {
        ui.error('No backup config found. Add a backup block to shipnode.config.ts');
        process.exit(1);
      }

      const backup = config.backup;
      const strategy = backup.strategy ?? 'snapshot';

      ui.info(`Setting up backup (${strategy})...`);

      const awsKeyId = process.env.AWS_ACCESS_KEY_ID;
      const awsSecret = process.env.AWS_SECRET_ACCESS_KEY;
      if (!awsKeyId || !awsSecret) {
        ui.error(
          'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set locally. ' +
          'For Cloudflare R2, create an API token at ' +
          'https://dash.cloudflare.com → R2 → Manage R2 API Tokens with Object Read & Write.',
        );
        process.exit(1);
      }

      let resticPassword: string | undefined;
      let resticRepository: string | undefined;
      if (strategy === 'restic') {
        resticPassword = process.env.RESTIC_PASSWORD;
        if (!resticPassword) {
          resticPassword = randomBytes(24).toString('base64');
          ui.warn('RESTIC_PASSWORD was not set — generated a new one.');
          ui.info(`Save this password somewhere safe (you need it to restore):\n  RESTIC_PASSWORD=${resticPassword}`);
        }
        resticRepository = buildResticRepositoryUrl(backup);

        // Install restic if missing. `apt-get install -y restic` is available on
        // Debian/Ubuntu; on distros without a recent restic in the repos, users
        // should install manually before running setup.
        await ensureCommand(
          executor,
          'restic',
          'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO apt-get update -qq && $SUDO apt-get install -y -qq restic',
        );
      } else {
        await ensureCommand(
          executor,
          'aws',
          'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO apt-get update -qq && $SUDO apt-get install -y -qq awscli',
        );
      }

      const ctx: ScriptContext = {
        remotePath: config.remotePath,
        hostname: config.ssh.host,
        db: config.database,
        cfg: backup,
      };

      const script = strategy === 'restic' ? buildResticScript(ctx) : buildSnapshotScript(ctx);
      const envFile = buildBackupEnv(strategy, config.database, {
        awsKeyId,
        awsSecret,
        resticPassword,
        resticRepository,
      });

      await writeRemoteFile(executor, BACKUP_ENV_PATH, envFile, '600');
      await writeRemoteFile(executor, BACKUP_SCRIPT_PATH, script, '755');
      await installSystemdUnits(executor, backup.schedule ?? 'daily', strategy);

      ui.success(`Backup scheduled (${strategy}, ${backup.schedule ?? 'daily'}).`);
      ui.info(`Script:     ${BACKUP_SCRIPT_PATH}`);
      ui.info(`Env:        ${BACKUP_ENV_PATH}`);
      if (strategy === 'restic') {
        ui.info(`Repository: ${resticRepository}`);
        ui.info(`Retention:  daily=${backup.keepDaily ?? 7} weekly=${backup.keepWeekly ?? 4} monthly=${backup.keepMonthly ?? 6}`);
      }
    },
    { configPath: options.config },
  );
}

export async function cmdBackupRun(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      const check = await executor.exec(`[ -f "${BACKUP_SCRIPT_PATH}" ] && echo EXISTS || echo MISSING`);
      if (check.stdout.trim() === 'MISSING') {
        ui.error('Backup not set up. Run: shipnode backup setup');
        process.exit(1);
      }

      ui.info('Running backup now...');
      // systemctl start ties into EnvironmentFile — running the script bare
      // wouldn't source /etc/shipnode/backup.env under a non-root deploy user.
      const result = await executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO systemctl start --wait ${TIMER_NAME}.service && ` +
        `$SUDO journalctl -u ${TIMER_NAME}.service -n 50 --no-pager`,
        { timeout: 600_000 },
      );
      console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      ui.success('Backup complete.');
    },
    { configPath: options.config },
  );
}

export async function cmdBackupStatus(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      const timerResult = await executor.exec(
        `systemctl status ${TIMER_NAME}.timer 2>&1 || echo "Timer not found"`,
      );
      console.log(timerResult.stdout);

      const lastResult = await executor.exec(
        `journalctl -u ${TIMER_NAME}.service -n 20 --no-pager 2>/dev/null || echo "No logs"`,
      );
      console.log(lastResult.stdout);
    },
    { configPath: options.config },
  );
}

/**
 * Restore a restic snapshot to a target directory on the remote host.
 *
 * We intentionally don't apply DB dumps automatically — a bad restore would
 * silently trash production data. The user gets the files under `--target`
 * (default: /tmp/shipnode-restore-<ts>) and runs whatever recovery command
 * fits their situation (e.g. `psql -f db.sql`, `rsync -a shared/ /var/…`).
 */
export async function cmdBackupRestore(
  cwd: string,
  snapshot: string | undefined,
  options: { config?: string; target?: string; tag?: string; host?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (!config.backup || (config.backup.strategy ?? 'snapshot') !== 'restic') {
        ui.error('backup restore only supports the restic strategy today.');
        process.exit(1);
      }

      const target = options.target ?? `/tmp/shipnode-restore-${Date.now()}`;
      const snap = snapshot ?? 'latest';
      const flags = [
        options.tag ? `--tag '${options.tag}'` : '',
        options.host ? `--host '${options.host}'` : '',
      ].filter(Boolean).join(' ');

      ui.info(`Restoring snapshot ${snap} → ${target}`);
      const cmd =
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
        `$SUDO bash -c '. ${BACKUP_ENV_PATH} && ` +
        `export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY HOME && ` +
        `mkdir -p "${target}" && ` +
        `restic restore ${snap} --target "${target}" ${flags}'`;

      const result = await executor.exec(cmd, { timeout: 600_000 });
      console.log(result.stdout);
      if (result.exitCode !== 0) {
        ui.error(result.stderr || 'Restore failed');
        process.exit(1);
      }
      ui.success(`Restored to ${target} on ${config.ssh.host}.`);
      ui.info(
        'Nothing has been applied — restored files are under the target dir. ' +
        'Apply manually, e.g.:\n' +
        '  psql -U <user> -d <db> < db.sql\n' +
        '  rsync -a shared/ /var/www/<app>/shared/',
      );
    },
    { configPath: options.config },
  );
}

export async function cmdBackupList(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      if (!config.backup) {
        ui.error('No backup config found.');
        process.exit(1);
      }

      const strategy = config.backup.strategy ?? 'snapshot';

      if (strategy === 'restic') {
        // `restic snapshots` needs the env file. Reuse it via a login shell that
        // sources /etc/shipnode/backup.env.
        const result = await executor.exec(
          `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
          `$SUDO bash -c '. ${BACKUP_ENV_PATH} && ` +
          `export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY && ` +
          `restic snapshots --compact'`,
        );
        if (!result.stdout.trim()) {
          ui.info('No snapshots yet.');
          return;
        }
        console.log(result.stdout);
        return;
      }

      const { s3Bucket, s3Prefix, s3Endpoint } = config.backup;
      const prefix = s3Prefix ? s3Prefix.replace(/\/$/, '') + '/' : '';
      const endpointFlag = s3Endpoint ? `--endpoint-url "${s3Endpoint}"` : '';
      const result = await executor.exec(
        `aws s3 ls "s3://${s3Bucket}/${prefix}" --recursive ${endpointFlag} | sort -r | head -30`,
      );
      if (!result.stdout.trim()) {
        ui.info('No backups found.');
        return;
      }
      console.log(result.stdout);
    },
    { configPath: options.config },
  );
}
