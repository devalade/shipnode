import { confirm } from '../prompt.js';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import * as sec from '../../infrastructure/provisioning/security.js';

export async function cmdHarden(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      const changes: string[] = [];

      ui.heading('SSH Hardening');
      const sshActive = (await executor.exec(sec.sshCheckActiveCommand())).stdout.includes('active');
      ui.info(`SSH service: ${sshActive ? 'active' : 'inactive'}`);
      const sshdResult = await executor.exec(sec.sshCheckConfigCommand());
      ui.info(`Current SSH config:\n  ${sshdResult.stdout.split('\n').join('\n  ')}`);

      if (await confirm('Harden SSH?')) {
        const sudoUsers = (await executor.exec(sec.sshCheckSudoUsersCommand())).stdout.trim();
        if (sudoUsers) {
          ui.info(`Sudo users: ${sudoUsers.split('\n').join(', ')}`);
          if (await confirm('Disable root login?')) {
            await executor.exec(sec.sshDisableRootLoginCommand());
            await executor.exec(sec.sshRestartCommand());
            ui.success('Root login disabled');
            changes.push('SSH: PermitRootLogin set to no');
          }
        } else {
          ui.warn('No sudo users — skipping root disable (would lock you out).');
        }
        if (await confirm('Disable password auth (keys only)?')) {
          await executor.exec(sec.sshDisablePasswordAuthCommand());
          await executor.exec(sec.sshRestartCommand());
          ui.success('Password auth disabled');
          changes.push('SSH: PasswordAuthentication set to no');
        }
      }

      ui.heading('Firewall (UFW)');
      const ufwResult = await executor.exec(sec.ufwCheckInstalledCommand());
      if (ufwResult.stdout.includes('NOT_INSTALLED')) {
        ui.warn('UFW not installed.');
        if (await confirm('Install UFW?')) {
          await executor.exec(sec.ufwInstallCommand());
          ui.success('UFW installed');
          changes.push('UFW: installed');
        }
      } else {
        ui.info(`UFW status:\n  ${ufwResult.stdout.split('\n').slice(0, 3).join('\n  ')}`);
      }

      if (await confirm('Configure UFW (allow SSH/80/443, deny all else)?')) {
        for (const cmd of sec.ufwConfigureCommands()) {
          await executor.exec(cmd);
        }
        ui.success('UFW configured and enabled');
        changes.push('UFW: configured (SSH, 80, 443 allowed)');
      }

      ui.heading('Fail2ban');
      const f2b = (await executor.exec(sec.fail2banCheckActiveCommand())).stdout;
      if (!f2b.includes('ACTIVE')) {
        ui.warn('Fail2ban not active.');
        if (await confirm('Install and configure fail2ban?')) {
          await executor.exec(sec.fail2banInstallCommand());
          await executor.exec(sec.fail2banApplyConfigCommand());
          await executor.exec(sec.fail2banEnableCommand());
          ui.success('Fail2ban installed');
          changes.push('Fail2ban: installed, sshd jail enabled');
        }
      } else {
        ui.success('Fail2ban already active');
      }

      if (changes.length === 0) {
        ui.info('No changes made.');
      } else {
        changes.forEach((c) => ui.success(c));
        ui.info(`${changes.length} change(s) applied.`);
      }
    },
    { configPath: options.config },
  );
}
