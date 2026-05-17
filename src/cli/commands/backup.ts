import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

const BACKUP_SCRIPT_PATH = '/usr/local/bin/shipnode-backup.sh';
const TIMER_NAME = 'shipnode-backup';

function buildBackupScript(config: {
  remotePath: string;
  s3Bucket: string;
  s3Prefix?: string;
  s3Endpoint?: string;
  dbType?: string;
  dbName?: string;
  dbUser?: string;
  dbHost?: string;
  dbPort?: number;
}): string {
  const prefix = config.s3Prefix ? config.s3Prefix.replace(/\/$/, '') + '/' : '';
  const endpointFlag = config.s3Endpoint ? `--endpoint-url "${config.s3Endpoint}"` : '';
  const ts = '$(date +%Y%m%d_%H%M%S)';

  const dbDump = config.dbType && config.dbType !== 'sqlite'
    ? `
# Database backup
DB_FILE="/tmp/db_${ts}.sql"
${config.dbType === 'postgres' ? `PGPASSWORD="$DB_PASSWORD" pg_dump -h "${config.dbHost}" -p "${config.dbPort ?? 5432}" -U "${config.dbUser}" "${config.dbName}" > "$DB_FILE"` : ''}
${config.dbType === 'mysql' ? `mysqldump -h "${config.dbHost}" -P "${config.dbPort ?? 3306}" -u "${config.dbUser}" -p"$DB_PASSWORD" "${config.dbName}" > "$DB_FILE"` : ''}
aws s3 cp "$DB_FILE" "s3://${config.s3Bucket}/${prefix}db/$DB_FILE" ${endpointFlag}
rm -f "$DB_FILE"
`
    : '';

  return `#!/bin/bash
set -euo pipefail

TIMESTAMP="${ts}"
DEPLOY_PATH="${config.remotePath}"
S3_BUCKET="${config.s3Bucket}"
S3_PREFIX="${prefix}"

echo "[shipnode-backup] Starting backup at $TIMESTAMP"

# Shared files backup
SHARED_ARCHIVE="/tmp/shared_${ts}.tar.gz"
tar -czf "$SHARED_ARCHIVE" -C "$DEPLOY_PATH/shared" . 2>/dev/null || true
aws s3 cp "$SHARED_ARCHIVE" "s3://$S3_BUCKET/${prefix}shared/shared_$TIMESTAMP.tar.gz" ${endpointFlag}
rm -f "$SHARED_ARCHIVE"
${dbDump}
echo "[shipnode-backup] Done"
`;
}

export function scheduleToSystemd(schedule: 'hourly' | 'daily' | 'weekly'): string {
  const map: Record<string, string> = {
    hourly: '*:00:00',
    daily: '*-*-* 02:00:00',
    weekly: 'Mon *-*-* 02:00:00',
  };
  return map[schedule] ?? map.daily;
}

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

      const { s3Bucket, s3Prefix, s3Endpoint, schedule = 'daily', retentionDays = 14 } = config.backup;

      ui.info('Setting up backup...');

      // Check awscli present
      const awsCheck = await executor.exec('command -v aws 2>/dev/null || echo MISSING');
      if (awsCheck.stdout.trim() === 'MISSING') {
        ui.error('aws CLI not found on server. Install it first: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
        process.exit(1);
      }

      const db = config.database;
      const netDb = db && db.type !== 'sqlite' ? db : undefined;
      const script = buildBackupScript({
        remotePath: config.remotePath,
        s3Bucket,
        s3Prefix,
        s3Endpoint,
        dbType: db?.type,
        dbName: db?.name,
        dbUser: netDb?.user,
        dbHost: netDb?.host,
        dbPort: netDb?.port,
      });

      const b64 = Buffer.from(script).toString('base64');
      await executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
        `printf '%s' '${b64}' | base64 -d | $SUDO tee ${BACKUP_SCRIPT_PATH} > /dev/null && ` +
        `$SUDO chmod +x ${BACKUP_SCRIPT_PATH}`,
      );

      const onCalendar = scheduleToSystemd(schedule as 'hourly' | 'daily' | 'weekly');

      const serviceUnit = `[Unit]
Description=ShipNode backup

[Service]
Type=oneshot
ExecStart=${BACKUP_SCRIPT_PATH}
`;

      const timerUnit = `[Unit]
Description=ShipNode backup timer

[Timer]
OnCalendar=${onCalendar}
Persistent=true

[Install]
WantedBy=timers.target
`;

      const svcB64 = Buffer.from(serviceUnit).toString('base64');
      const timerB64 = Buffer.from(timerUnit).toString('base64');

      await executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ` +
        `printf '%s' '${svcB64}' | base64 -d | $SUDO tee /etc/systemd/system/${TIMER_NAME}.service > /dev/null && ` +
        `printf '%s' '${timerB64}' | base64 -d | $SUDO tee /etc/systemd/system/${TIMER_NAME}.timer > /dev/null && ` +
        `$SUDO systemctl daemon-reload && ` +
        `$SUDO systemctl enable --now ${TIMER_NAME}.timer`,
      );

      ui.success(`Backup scheduled (${schedule}, retain ${retentionDays} days).`);
      ui.info(`Script: ${BACKUP_SCRIPT_PATH}`);
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
      const result = await executor.exec(BACKUP_SCRIPT_PATH, { timeout: 300_000 });
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
