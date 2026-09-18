import { describe, it, expect } from 'vitest';
import {
  scheduleToSystemd,
  buildSnapshotScript,
  buildResticScript,
  buildBackupEnv,
} from '../../src/cli/commands/backup.js';
import type { BackupConfig } from '../../src/shared/types.js';

const backupCfg = {
  s3Bucket: 'backups',
  s3Endpoint: 'https://r2.example',
} as Required<Pick<BackupConfig, 's3Bucket'>> & BackupConfig;

const sqliteCtx = {
  remotePath: '/var/www/app',
  hostname: 'app.example',
  db: { type: 'sqlite' as const, name: './data.db' },
  cfg: backupCfg,
};

describe('scheduleToSystemd', () => {
  it('maps hourly correctly', () => {
    expect(scheduleToSystemd('hourly')).toBe('*:00:00');
  });

  it('maps daily correctly', () => {
    expect(scheduleToSystemd('daily')).toBe('*-*-* 02:00:00');
  });

  it('maps weekly correctly', () => {
    expect(scheduleToSystemd('weekly')).toBe('Mon *-*-* 02:00:00');
  });
});

describe('sqlite backup scripts', () => {
  it('snapshot strategy dumps sqlite via .backup, not pg_dump', () => {
    const script = buildSnapshotScript(sqliteCtx);
    expect(script).toContain('sqlite3');
    expect(script).toContain('.backup');
    expect(script).toContain('./data.db');
    expect(script).not.toContain('pg_dump');
    expect(script).not.toContain('mysqldump');
  });

  it('restic strategy streams a consistent sqlite backup with tag db', () => {
    const script = buildResticScript(sqliteCtx);
    expect(script).toContain('sqlite3');
    expect(script).toContain('.backup');
    expect(script).toContain('--tag db');
    expect(script).not.toContain('pg_dump');
  });

  it('backup env records sqlite type and file path', () => {
    const env = buildBackupEnv('restic', { type: 'sqlite', name: './data.db' }, {});
    expect(env).toContain("DB_TYPE='sqlite'");
    expect(env).toContain("DB_NAME='./data.db'");
    expect(env).not.toContain('DB_HOST');
    expect(env).not.toContain('DB_PASSWORD');
  });
});
