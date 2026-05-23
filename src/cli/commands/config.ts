import { resolve } from 'path';
import { pathExists } from 'fs-extra';
import { runLocalCommand } from '../runner.js';
import { ui } from '../ui.js';
import { loadConfig } from '../../config/loader.js';

export async function cmdConfigShow(cwd: string, options: { config?: string }): Promise<void> {
  await runLocalCommand(
    cwd,
    async (config) => {
      ui.heading('Shipnode Configuration');

      ui.section('App', [
        ['app', config.app],
        ['nodeVersion', config.nodeVersion],
        ['envFile', config.envFile],
        ['keepReleases', String(config.keepReleases)],
      ]);

      ui.section('SSH', [
        ['ssh', `${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`],
        ['remotePath', config.remotePath],
      ]);

      if (config.pm2) {
        for (const app of config.pm2.apps) {
          const rows: [string, string][] = [['name', app.name]];
          if (app.command) rows.push(['command', app.command]);
          if (app.port !== undefined) rows.push(['port', String(app.port)]);
          if (app.instances !== undefined) rows.push(['instances', String(app.instances)]);
          if (app.maxMemory !== undefined) rows.push(['maxMemory', app.maxMemory]);
          if (app.env) {
            for (const [k, v] of Object.entries(app.env)) rows.push([`env.${k}`, v]);
          }
          ui.section(app.port !== undefined ? `PM2 app: ${app.name} (web)` : `PM2 app: ${app.name}`, rows);
        }
      }

      if (config.domain) {
        ui.section('Domain', [
          ['domain', config.domain],
        ]);
      }

      if (config.app === 'backend') {
        ui.section('Health Check', [
          ['enabled', String(config.healthCheck.enabled)],
          ['path', config.healthCheck.path],
          ['timeout', String(config.healthCheck.timeout)],
          ['retries', String(config.healthCheck.retries)],
          ['startupDelay', String(config.healthCheck.startupDelay)],
        ]);
      }

      if (config.sharedDirs && config.sharedDirs.length > 0) {
        ui.section('Shared Dirs', config.sharedDirs.map((d, i) => [`[${i}]`, d]));
      }

      if (config.sharedFiles && config.sharedFiles.length > 0) {
        ui.section('Shared Files', config.sharedFiles.map((f, i) => [`[${i}]`, f]));
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
