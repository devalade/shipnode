import { confirm } from '../prompt.js';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

const SUDO = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"';

export async function cmdHarden(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      const changes: string[] = [];

      // ── 1. SSH service check ──────────────────────────────────────────────
      ui.heading('SSH Hardening');

      const sshActiveResult = await executor.exec(
        `systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null && echo "active" || echo "inactive"`,
      );
      const sshActive = sshActiveResult.stdout.includes('active');
      ui.info(`SSH service: ${sshActive ? 'active' : 'inactive'}`);

      const sshdResult = await executor.exec(
        `grep -E "^(PermitRootLogin|PasswordAuthentication)" /etc/ssh/sshd_config 2>/dev/null || echo "defaults"`,
      );
      ui.info(`Current SSH config:\n  ${sshdResult.stdout.split('\n').join('\n  ')}`);

      const hardenSsh = await confirm('Harden SSH?');
      if (hardenSsh) {
        // Check for sudo users before disabling root
        const sudoUsersResult = await executor.exec(
          `getent group sudo 2>/dev/null | cut -d: -f4 | tr ',' '\\n' | grep -v '^$'`,
        );
        const sudoUsers = sudoUsersResult.stdout.trim();

        if (sudoUsers) {
          ui.info(`Sudo users found: ${sudoUsers.split('\n').join(', ')}`);
          const disableRoot = await confirm('Disable root login?');
          if (disableRoot) {
            await executor.exec(
              `${SUDO}; $SUDO sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config`,
            );
            await executor.exec(
              `${SUDO}; $SUDO systemctl restart ssh 2>/dev/null || $SUDO systemctl restart sshd 2>/dev/null || true`,
            );
            ui.success('Root login disabled');
            changes.push('SSH: PermitRootLogin set to no');
          }
        } else {
          ui.warn('No sudo users found — skipping root login disable (would lock you out).');
        }

        const disablePassAuth = await confirm('Disable password authentication (keys only)?');
        if (disablePassAuth) {
          await executor.exec(
            `${SUDO}; $SUDO sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config`,
          );
          await executor.exec(
            `${SUDO}; $SUDO systemctl restart ssh 2>/dev/null || $SUDO systemctl restart sshd 2>/dev/null || true`,
          );
          ui.success('Password authentication disabled');
          changes.push('SSH: PasswordAuthentication set to no');
        }
      }

      // ── 2. UFW firewall ───────────────────────────────────────────────────
      ui.heading('Firewall (UFW)');

      const ufwResult = await executor.exec(
        `command -v ufw &>/dev/null && ufw status || echo "NOT_INSTALLED"`,
      );

      if (ufwResult.stdout.includes('NOT_INSTALLED')) {
        ui.warn('UFW is not installed.');
        const installUfw = await confirm('Install UFW?');
        if (installUfw) {
          await executor.exec(
            `${SUDO}; $SUDO apt-get install -y ufw`,
          );
          ui.success('UFW installed');
          changes.push('UFW: installed');
        }
      } else {
        ui.info(`UFW status:\n  ${ufwResult.stdout.split('\n').slice(0, 3).join('\n  ')}`);
      }

      const configureUfw = await confirm('Configure UFW (allow SSH/80/443, deny all else, enable)?');
      if (configureUfw) {
        await executor.exec(`${SUDO}; $SUDO ufw default deny incoming`);
        await executor.exec(`${SUDO}; $SUDO ufw default allow outgoing`);
        await executor.exec(`${SUDO}; $SUDO ufw allow ssh`);
        await executor.exec(`${SUDO}; $SUDO ufw allow 80/tcp`);
        await executor.exec(`${SUDO}; $SUDO ufw allow 443/tcp`);
        await executor.exec(`${SUDO}; $SUDO ufw --force enable`);
        ui.success('UFW configured and enabled');
        changes.push('UFW: configured (SSH, 80, 443 allowed; deny incoming by default)');
      }

      // ── 3. Fail2ban ───────────────────────────────────────────────────────
      ui.heading('Fail2ban');

      const fail2banResult = await executor.exec(
        `command -v fail2ban-server &>/dev/null && systemctl is-active fail2ban && echo "ACTIVE" || echo "NOT_ACTIVE"`,
      );

      if (!fail2banResult.stdout.includes('ACTIVE')) {
        ui.warn('Fail2ban is not active.');
        const installFail2ban = await confirm('Install and configure fail2ban?');
        if (installFail2ban) {
          await executor.exec(`${SUDO}; $SUDO apt-get install -y fail2ban`);

          const jailConfig = [
            '[DEFAULT]',
            'maxretry = 5',
            'findtime = 600',
            'bantime = 3600',
            '',
            '[sshd]',
            'enabled = true',
            'port = ssh',
            'filter = sshd',
            'logpath = /var/log/auth.log',
            'maxretry = 5',
          ].join('\\n');

          await executor.exec(
            `${SUDO}; printf '${jailConfig}' | $SUDO tee /etc/fail2ban/jail.local > /dev/null`,
          );
          await executor.exec(`${SUDO}; $SUDO systemctl enable fail2ban && $SUDO systemctl restart fail2ban`);
          ui.success('Fail2ban installed and configured');
          changes.push('Fail2ban: installed, configured (maxretry=5, bantime=3600s), sshd jail enabled');
        }
      } else {
        ui.success('Fail2ban is already active');
      }

      // ── Summary ───────────────────────────────────────────────────────────
      ui.heading('Hardening Summary');
      if (changes.length === 0) {
        ui.info('No changes were made.');
      } else {
        for (const change of changes) {
          ui.success(change);
        }
        ui.info(`${changes.length} change(s) applied.`);
      }
    },
    { configPath: options.config },
  );
}
