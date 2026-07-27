import type { FirewallRule } from '../../domain/networking.js';

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

/**
 * `extra` carries the rules a multi-server layout needs on top of the defaults
 * — see {@link import('../../domain/networking.js').fleetFirewallRules}. They go
 * in before `enable` so the firewall is never briefly up with the holes closed.
 */
export function ufwConfigureCommands(extra: FirewallRule[] = []): string[] {
  return [
    `${SUDO}; $SUDO ufw default deny incoming`,
    `${SUDO}; $SUDO ufw default allow outgoing`,
    `${SUDO}; $SUDO ufw allow ssh`,
    `${SUDO}; $SUDO ufw allow 80/tcp`,
    `${SUDO}; $SUDO ufw allow 443/tcp`,
    ...extra.map((rule) => `${SUDO}; $SUDO ${ufwAllowRule(rule)}`),
    `${SUDO}; $SUDO ufw --force enable`,
  ];
}

/**
 * ufw rejects a rule outright — `ERROR: Invalid syntax` — when the comment
 * contains a quote or an apostrophe, however the shell quotes it. Comments are
 * built from app, accessory and server names, so this has to be defended rather
 * than merely avoided in the strings shipnode happens to generate today. A
 * rejected rule is the worst failure mode available: `ufw --force enable` still
 * succeeds, so the firewall comes up hard with the hole never opened.
 */
export function sanitizeUfwComment(comment: string): string {
  return comment.replace(/['"\\`$]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function ufwAllowRule(rule: FirewallRule): string {
  const comment = `comment "${sanitizeUfwComment(rule.comment)}"`;
  return rule.from === undefined
    ? `ufw allow ${rule.port}/tcp ${comment}`
    : `ufw allow from ${rule.from} to any port ${rule.port} proto tcp ${comment}`;
}

export function fail2banCheckActiveCommand(): string {
  return `command -v fail2ban-server &>/dev/null && systemctl is-active --quiet fail2ban && echo "ACTIVE" || echo "NOT_ACTIVE"`;
}

/** Match the probe protocol exactly; incidental output must not look healthy. */
export function isFail2banActive(output: string): boolean {
  return output.trim() === 'ACTIVE';
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

/**
 * Restrict Docker-published ports, which ufw cannot.
 *
 * Docker writes its own ACCEPT rules into the FORWARD path when it publishes a
 * port. Those are consulted before ufw's chain, so a container port stays open
 * to the whole network no matter what `ufw allow from ...` says — the rule is
 * accepted, appears in `ufw status`, and does nothing. An accessory is always a
 * container, so every accessory rule needs this.
 *
 * DOCKER-USER is the one chain Docker promises to evaluate first and never
 * rewrite. Allowed sources RETURN (falling through to Docker's own ACCEPT);
 * everything else for that port is dropped.
 *
 * Ordering is why the DROP is inserted before the RETURNs: each `-I ... 1`
 * pushes the previous entry down, so inserting DROP first leaves it last.
 * Appending it with `-A` would place it after the RETURN that Docker keeps at
 * the end of the chain, where it would never be reached.
 */
export function dockerUserRules(rules: FirewallRule[]): string[] {
  const docker = rules.filter((rule) => rule.docker);
  if (docker.length === 0) return [];

  const ports = [...new Set(docker.map((rule) => rule.port))];
  const commands: string[] = [`${SUDO}`];

  for (const port of ports) {
    const sources = docker
      .filter((rule) => rule.port === port && rule.from !== undefined)
      .map((rule) => rule.from!);
    if (sources.length === 0) continue;

    // Re-running harden must not stack duplicates, so delete each rule we are
    // about to add first. `|| true` because a missing rule is the normal case.
    for (const source of sources) {
      commands.push(`$SUDO iptables -D DOCKER-USER -p tcp --dport ${port} -s ${source} -j RETURN 2>/dev/null || true`);
    }
    commands.push(`$SUDO iptables -D DOCKER-USER -p tcp --dport ${port} -j DROP 2>/dev/null || true`);

    commands.push(`$SUDO iptables -I DOCKER-USER 1 -p tcp --dport ${port} -j DROP`);
    for (const source of [...sources].reverse()) {
      commands.push(`$SUDO iptables -I DOCKER-USER 1 -p tcp --dport ${port} -s ${source} -j RETURN`);
    }
  }

  if (commands.length === 1) return [];

  // iptables rules are lost on reboot, and a firewall that silently stops
  // applying is worse than one that was never configured.
  commands.push(
    'command -v netfilter-persistent >/dev/null 2>&1 || ' +
    '{ DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true; }',
    '$SUDO netfilter-persistent save >/dev/null 2>&1 || ' +
    'echo "shipnode: could not persist iptables rules; they will be lost on reboot" >&2',
  );

  return [commands.join('; ')];
}
