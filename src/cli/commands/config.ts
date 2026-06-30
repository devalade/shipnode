import { resolve } from 'path';
import { pathExists } from 'fs-extra';
import { runLocalCommand } from '../runner.js';
import { ui } from '../ui.js';
import { loadConfig } from '../../config/loader.js';
import { getActiveApp } from '../../domain/workspace.js';

export async function cmdConfigShow(cwd: string, options: { config?: string }): Promise<void> {
  await runLocalCommand(
    cwd,
    async (config) => {
      const app = getActiveApp(config);
      ui.heading('Shipnode Configuration');

      ui.section('App', [
        ['app', app.appType],
        ['nodeVersion', config.nodeVersion],
        ['envFile', app.envFile],
        ['keepReleases', String(app.keepReleases)],
      ]);

      ui.section('SSH', [
        ['ssh', `${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`],
        ['remotePath', config.remotePath],
      ]);

      if (app.pm2) {
        for (const pm2App of app.pm2.apps) {
          const rows: [string, string][] = [['name', pm2App.name]];
          if (pm2App.command) rows.push(['command', pm2App.command]);
          if (pm2App.port !== undefined) rows.push(['port', String(pm2App.port)]);
          if (pm2App.instances !== undefined) rows.push(['instances', String(pm2App.instances)]);
          if (pm2App.maxMemory !== undefined) rows.push(['maxMemory', pm2App.maxMemory]);
          if (pm2App.env) {
            for (const [k, v] of Object.entries(pm2App.env)) rows.push([`env.${k}`, v]);
          }
          ui.section(pm2App.port !== undefined ? `PM2 app: ${pm2App.name} (web)` : `PM2 app: ${pm2App.name}`, rows);
        }
      }

      if (app.domain) {
        ui.section('Domain', [
          ['domain', app.domain],
        ]);
      }

      if (app.appType === 'backend') {
        ui.section('Health Check', [
          ['enabled', String(app.healthCheck.enabled)],
          ['path', app.healthCheck.path],
          ['timeout', String(app.healthCheck.timeout)],
          ['retries', String(app.healthCheck.retries)],
          ['startupDelay', String(app.healthCheck.startupDelay)],
        ]);
      }

      if (app.sharedDirs && app.sharedDirs.length > 0) {
        ui.section('Shared Dirs', app.sharedDirs.map((d, i) => [`[${i}]`, d]));
      }

      if (app.sharedFiles && app.sharedFiles.length > 0) {
        ui.section('Shared Files', app.sharedFiles.map((f, i) => [`[${i}]`, f]));
      }

      if (config.database) {
        const db = config.database;
        const rows: [string, string][] = [['type', db.type], ['name', db.name]];
        if (db.type !== 'sqlite') {
          rows.push(['host', db.host], ['port', String(db.port)], ['user', db.user]);
        }
        ui.section('Database', rows);
      }
    },
    { configPath: options.config },
  );
}

export async function cmdConfigValidate(cwd: string, options: { config?: string }): Promise<void> {
  try {
    await loadConfig(cwd, options.config);
    ui.success('Configuration is valid');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    process.exit(1);
  }
}

export async function cmdConfigPath(cwd: string, options: { config?: string }): Promise<void> {
  if (options.config) {
    const exists = await pathExists(options.config);
    if (exists) {
      console.log(options.config);
    } else {
      ui.error(`Config file not found: ${options.config}`);
      process.exit(1);
    }
    return;
  }

  const tsPath = resolve(cwd, 'shipnode.config.ts');
  const jsPath = resolve(cwd, 'shipnode.config.js');

  if (await pathExists(tsPath)) {
    console.log(tsPath);
  } else if (await pathExists(jsPath)) {
    console.log(jsPath);
  } else {
    ui.error(`No shipnode.config.ts or shipnode.config.js found in ${cwd}`);
    process.exit(1);
  }
}
