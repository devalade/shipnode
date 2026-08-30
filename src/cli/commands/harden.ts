import { confirm } from '../prompt.js';
import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import * as sec from '../../infrastructure/provisioning/security.js';
import { fleetFirewallRules } from '../../domain/networking.js';
import type { FirewallRule } from '../../domain/networking.js';
import type { ExecResult } from '../../shared/types.js';

/** One ufw command as it was actually run, with the rule it came from. */
export interface UfwAttempt {
  command: string;
  rule?: FirewallRule;
  result: ExecResult;
}

export interface UfwOutcome {
  /** Rules ufw accepted — the only ones the operator may be told are in place. */
  applied: FirewallRule[];
  failures: { label: string; detail: string }[];
  summary: string;
}

function describeRule(rule: FirewallRule): string {
  return `${rule.port}/tcp${rule.from ? ` from ${rule.from}` : ''}`;
}

/**
 * Turn what ufw actually did into what the operator is told.
 *
 * `executor.exec` resolves on a non-zero exit, so a rule ufw refuses — an
 * `allow from <value>` whose value is not an IP or CIDR, say — used to be
 * discarded silently while the run still printed `allowed 5432/tcp from
 * <value>`. A port meant to be restricted to its consumers would then be left
 * open and reported as closed. Only exit code 0 counts as applied; re-running
 * harden over an existing rule prints "Skipping adding existing rule" and exits
 * 0, so idempotent re-runs still count as successes.
 */
export function summarizeUfwRun(attempts: UfwAttempt[]): UfwOutcome {
  const applied: FirewallRule[] = [];
  const failures: { label: string; detail: string }[] = [];

  for (const attempt of attempts) {
    if (attempt.result.exitCode === 0) {
      if (attempt.rule) applied.push(attempt.rule);
      continue;
    }
    const detail = (attempt.result.stderr || attempt.result.stdout).trim()
      || `exited ${attempt.result.exitCode} with no output`;
    failures.push({
      label: attempt.rule ? `${describeRule(attempt.rule)} — ${attempt.rule.comment}` : attempt.command,
      detail,
    });
  }

  const total = attempts.filter((a) => a.rule).length;
  let summary: string;
  if (failures.length > 0) {
    summary = `UFW: configured with errors (${applied.length}/${total} workspace rule(s) applied, ${failures.length} command(s) failed)`;
  } else if (total === 0) {
    summary = 'UFW: configured (SSH, 80, 443 allowed)';
  } else {
    summary = `UFW: configured (SSH, 80, 443, plus ${total} workspace rule(s))`;
  }

  return { applied, failures, summary };
}

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
        // A refused rule must not abort the run — harden does many independent
        // things and is meant to be re-runnable — but it must not be reported
        // as applied either, so every result is collected and judged.
        const attempts: UfwAttempt[] = [];
        for (const step of sec.ufwConfigurePlan(extra)) {
          attempts.push({ command: step.command, rule: step.rule, result: await executor.exec(step.command) });
        }
        const outcome = summarizeUfwRun(attempts);

        changes.push(outcome.summary);
        for (const rule of outcome.applied) {
          ui.info(`  allowed ${describeRule(rule)} — ${rule.comment}`);
        }
        for (const failure of outcome.failures) {
          ui.error(`  ufw refused: ${failure.label}\n  ${failure.detail}`);
        }
        if (outcome.failures.length > 0) {
          ui.warn('Those ports were left in whatever state they were in — not restricted. Fix the values above and re-run `shipnode harden`.');
        }

        // Accessory ports are Docker's, and Docker's own FORWARD rules are
        // consulted before ufw's — so the rules above are accepted, appear in
        // `ufw status`, and restrict nothing. DOCKER-USER is what actually holds.
        const dockerRules = sec.dockerUserRules(extra);
        const dockerFailures: string[] = [];
        for (const cmd of dockerRules) {
          const result = await executor.exec(cmd);
          if (result.exitCode !== 0) {
            dockerFailures.push((result.stderr || result.stdout).trim() || `exited ${result.exitCode} with no output`);
          }
        }
        if (dockerRules.length > 0 && dockerFailures.length === 0) {
          changes.push('DOCKER-USER: container ports restricted to their declared consumers');
        } else if (dockerFailures.length > 0) {
          ui.error(`DOCKER-USER rules failed — the container ports above are still reachable from anywhere:\n  ${dockerFailures.join('\n  ')}`);
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
