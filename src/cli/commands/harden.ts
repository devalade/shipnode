import { confirm } from '../prompt.js';
import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import * as sec from '../../infrastructure/provisioning/security.js';
import { fleetFirewallRules } from '../../domain/networking.js';

/**
 * What the operator wants done, decided once.
 *
 * Hardening fans out over every server, and the prompts used to live inside that
 * loop — so a three-server workspace asked the same seven questions three times,
 * and answering "no" on the second server left the first already changed. The
 * answers are collected up front instead; each server then applies whatever its
 * own state makes applicable, and says what it skipped.
 */
interface HardenChoices {
  ssh: boolean;
  disableRootLogin: boolean;
  disablePasswordAuth: boolean;
  installUfw: boolean;
  configureUfw: boolean;
  pm2Save: boolean;
  disableStaleUnits: boolean;
  fail2ban: boolean;
}

async function askChoices(serverCount: number): Promise<HardenChoices> {
  if (serverCount > 1) {
    ui.info(`These answers apply to all ${serverCount} servers in this workspace.`);
  }

  ui.heading('SSH Hardening');
  const ssh = await confirm('Harden SSH?');
  const disableRootLogin = ssh && (await confirm('Disable root login?'));
  const disablePasswordAuth = ssh && (await confirm('Disable password auth (keys only)?'));

  ui.heading('Firewall (UFW)');
  const installUfw = await confirm('Install UFW where it is missing?');
  const configureUfw = await confirm('Configure UFW (allow SSH/80/443 plus this workspace\'s own ports, deny all else)?');

  ui.heading('PM2 boot resurrection');
  const pm2Save = await confirm('Refresh the saved PM2 process list (pm2 save)?');
  const disableStaleUnits = await confirm('Disable stale PM2 units so only the current user\'s resurrects at boot?');

  ui.heading('Fail2ban');
  const fail2ban = await confirm('Install and configure fail2ban where it is inactive?');

  return { ssh, disableRootLogin, disablePasswordAuth, installUfw, configureUfw, pm2Save, disableStaleUnits, fail2ban };
}

export async function cmdHarden(cwd: string, options: { config?: string; on?: string }): Promise<void> {
  const { loadConfig } = await import('../../config/loader.js');
  const workspace = await loadConfig(cwd, options.config);
  const serverCount = options.on ? 1 : Object.keys(workspace.servers).length;

  const choices = await askChoices(serverCount);
  if (!Object.values(choices).some(Boolean)) {
    ui.info('Nothing selected — no changes made.');
    return;
  }

  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const changes: string[] = [];
      const currentUser = config.ssh.user;

      ui.heading(`${serverName} (${currentUser}@${config.ssh.host})`);

      if (choices.ssh) {
        const sshdResult = await executor.exec(sec.sshCheckConfigCommand());
        ui.info(`Current SSH config:\n  ${sshdResult.stdout.split('\n').join('\n  ')}`);

        if (choices.disableRootLogin) {
          const sudoUsers = (await executor.exec(sec.sshCheckSudoUsersCommand())).stdout.trim();
          if (sudoUsers) {
            await executor.exec(sec.sshDisableRootLoginCommand());
            await executor.exec(sec.sshRestartCommand());
            changes.push('SSH: PermitRootLogin set to no');
          } else {
            ui.warn('No sudo users — skipping root disable (would lock you out).');
          }
        }

        if (choices.disablePasswordAuth) {
          await executor.exec(sec.sshDisablePasswordAuthCommand());
          await executor.exec(sec.sshRestartCommand());
          changes.push('SSH: PasswordAuthentication set to no');
        }
      }

      const ufwResult = await executor.exec(sec.ufwCheckInstalledCommand());
      const ufwMissing = ufwResult.stdout.includes('NOT_INSTALLED');
      if (ufwMissing && choices.installUfw) {
        await executor.exec(sec.ufwInstallCommand());
        changes.push('UFW: installed');
      } else if (ufwMissing) {
        ui.warn('UFW not installed — skipping firewall configuration.');
      }

      if (choices.configureUfw && (!ufwMissing || choices.installUfw)) {
        // Rules derived from the workspace, not from this server alone: which
        // holes this box needs depends on where the apps that consume it run.
        const extra = fleetFirewallRules(workspace, serverName);
        for (const cmd of sec.ufwConfigureCommands(extra)) {
          await executor.exec(cmd);
        }
        changes.push(
          extra.length === 0
            ? 'UFW: configured (SSH, 80, 443 allowed)'
            : `UFW: configured (SSH, 80, 443, plus ${extra.length} workspace rule(s))`,
        );
        for (const rule of extra) {
          ui.info(`  allowed ${rule.port}/tcp${rule.from ? ` from ${rule.from}` : ''} — ${rule.comment}`);
        }
      }

      // List installed pm2 systemd units so we can spot stale ones from a previous
      // root-scoped setup after switching to a deploy user.
      const unitsResult = await executor.exec(
        `systemctl list-unit-files 'pm2-*.service' --no-legend 2>/dev/null | awk '{print $1}' || true`,
      );
      const units = unitsResult.stdout.trim().split('\n').filter(Boolean);
      const wanted = `pm2-${currentUser}.service`;
      const stale = units.filter((u) => u !== wanted);

      if (units.includes(wanted)) {
        if (choices.pm2Save) {
          // Refresh the resurrection dump so the current process list is what boots.
          await executor.exec(
            `bash -lc 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH" && pm2 save --force' || true`,
          );
          changes.push(`PM2: refreshed dump for ${currentUser}`);
        }
      } else {
        ui.warn(`No ${wanted} found. If you switched ssh.user recently, re-run 'shipnode setup' as the new user or install pm2 startup manually.`);
      }

      if (stale.length > 0 && choices.disableStaleUnits) {
        for (const unit of stale) {
          await executor.exec(
            `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO systemctl disable --now "${unit}" 2>/dev/null || true`,
          );
          changes.push(`PM2: disabled ${unit}`);
        }
      } else if (stale.length > 0) {
        ui.warn(`Stale PM2 units left in place: ${stale.join(', ')}`);
      }

      if (choices.fail2ban) {
        const f2b = (await executor.exec(sec.fail2banCheckActiveCommand())).stdout;
        if (!sec.isFail2banActive(f2b)) {
          await executor.execOrThrow(sec.fail2banInstallCommand());
          await executor.execOrThrow(sec.fail2banApplyConfigCommand());
          await executor.execOrThrow(sec.fail2banEnableCommand());
          changes.push('Fail2ban: installed, sshd jail enabled');
        } else {
          ui.success('Fail2ban already active');
        }
      }

      if (changes.length === 0) {
        ui.info(`${serverName}: no changes made.`);
      } else {
        changes.forEach((c) => ui.success(c));
        ui.info(`${serverName}: ${changes.length} change(s) applied.`);
      }
    },
    { configPath: options.config, serverName: options.on },
  );
}
