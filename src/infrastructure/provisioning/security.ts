const SUDO = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"';

export function sshCheckActiveCommand(): string {
  return `systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null && echo "active" || echo "inactive"`;
}

export function sshCheckConfigCommand(): string {
  return `grep -E "^(PermitRootLogin|PasswordAuthentication)" /etc/ssh/sshd_config 2>/dev/null || echo "defaults"`;
}

export function sshCheckSudoUsersCommand(): string {
  return `getent group sudo 2>/dev/null | cut -d: -f4 | tr ',' '\\n' | grep -v '^$'`;
}

export function sshDisableRootLoginCommand(): string {
  return `${SUDO}; $SUDO sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config`;
}

export function sshDisablePasswordAuthCommand(): string {
  return `${SUDO}; $SUDO sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config`;
}

export function sshRestartCommand(): string {
  return `${SUDO}; $SUDO systemctl restart ssh 2>/dev/null || $SUDO systemctl restart sshd 2>/dev/null || true`;
}

export function ufwCheckInstalledCommand(): string {
  return `command -v ufw &>/dev/null && ufw status || echo "NOT_INSTALLED"`;
}

export function ufwInstallCommand(): string {
  return `${SUDO}; $SUDO apt-get install -y ufw`;
}

export function ufwConfigureCommands(): string[] {
  return [
    `${SUDO}; $SUDO ufw default deny incoming`,
    `${SUDO}; $SUDO ufw default allow outgoing`,
    `${SUDO}; $SUDO ufw allow ssh`,
    `${SUDO}; $SUDO ufw allow 80/tcp`,
    `${SUDO}; $SUDO ufw allow 443/tcp`,
    `${SUDO}; $SUDO ufw --force enable`,
  ];
}

export function fail2banCheckActiveCommand(): string {
  return `command -v fail2ban-server &>/dev/null && systemctl is-active fail2ban && echo "ACTIVE" || echo "NOT_ACTIVE"`;
}

export function fail2banInstallCommand(): string {
  return `${SUDO}; $SUDO apt-get install -y fail2ban`;
}

export function fail2banJailConfig(): string {
  return [
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
}

export function fail2banApplyConfigCommand(): string {
  const config = fail2banJailConfig();
  return `${SUDO}; printf '${config}' | $SUDO tee /etc/fail2ban/jail.local > /dev/null`;
}

export function fail2banEnableCommand(): string {
  return `${SUDO}; $SUDO systemctl enable fail2ban && $SUDO systemctl restart fail2ban`;
}
