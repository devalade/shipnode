import { describe, expect, it } from 'vitest';
import { summarizeUfwRun, type UfwAttempt } from '../../src/cli/commands/harden.js';
import { ufwConfigurePlan, ufwConfigureCommands, dockerUserRules } from '../../src/infrastructure/provisioning/security.js';

const ok = { stdout: '', stderr: '', exitCode: 0 };
const rule = { port: 5432, from: '10.0.0.11', comment: 'shipnode postgres accessory', docker: true };

function attempt(overrides: Partial<UfwAttempt> = {}): UfwAttempt {
  return { command: 'ufw allow ...', result: ok, ...overrides };
}

describe('ufwConfigurePlan', () => {
  it('carries the rule each command came from, and still emits the same commands', () => {
    const plan = ufwConfigurePlan([rule]);

    expect(plan.map((s) => s.command)).toEqual(ufwConfigureCommands([rule]));
    expect(plan.filter((s) => s.rule).map((s) => s.rule)).toEqual([rule]);
  });
});

describe('summarizeUfwRun', () => {
  it('counts a rule ufw refused as failed, never as applied', () => {
    // The failure mode this guards: ufw rejects `allow from <not-an-ip>`, exec
    // resolves anyway, and the port meant to be restricted to its consumers is
    // left open while harden reports it closed.
    const outcome = summarizeUfwRun([
      attempt(),
      attempt({
        rule,
        result: { stdout: '', stderr: 'ERROR: Bad source address\n', exitCode: 1 },
      }),
    ]);

    expect(outcome.applied).toEqual([]);
    expect(outcome.failures).toEqual([
      { label: '5432/tcp from 10.0.0.11 — shipnode postgres accessory', detail: 'ERROR: Bad source address' },
    ]);
    expect(outcome.summary).toBe('UFW: configured with errors (0/1 workspace rule(s) applied, 1 command(s) failed)');
    expect(outcome.summary).not.toContain('UFW: configured (');
  });

  it('reports the rules that did land when only some fail', () => {
    const other = { port: 6379, from: '10.0.0.12', comment: 'redis', docker: true };
    const outcome = summarizeUfwRun([
      attempt({ rule }),
      attempt({ rule: other, result: { stdout: '', stderr: 'ERROR: Invalid syntax', exitCode: 1 } }),
    ]);

    expect(outcome.applied).toEqual([rule]);
    expect(outcome.summary).toBe('UFW: configured with errors (1/2 workspace rule(s) applied, 1 command(s) failed)');
  });

  it('treats an already-present rule as applied, since re-running harden is normal', () => {
    const outcome = summarizeUfwRun([
      attempt({ rule, result: { stdout: 'Skipping adding existing rule\n', stderr: '', exitCode: 0 } }),
    ]);

    expect(outcome.applied).toEqual([rule]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.summary).toBe('UFW: configured (SSH, 80, 443, plus 1 workspace rule(s))');
  });

  it('surfaces a failed default command too, rather than claiming configured', () => {
    const outcome = summarizeUfwRun([
      attempt({ command: 'ufw --force enable', result: { stdout: '', stderr: 'Permission denied', exitCode: 1 } }),
    ]);

    expect(outcome.failures).toEqual([{ label: 'ufw --force enable', detail: 'Permission denied' }]);
    expect(outcome.summary).toBe('UFW: configured with errors (0/0 workspace rule(s) applied, 1 command(s) failed)');
  });

  it('keeps the original wording when everything succeeds', () => {
    expect(summarizeUfwRun([attempt()]).summary).toBe('UFW: configured (SSH, 80, 443 allowed)');
  });

  it('falls back to the exit code when the command said nothing', () => {
    const outcome = summarizeUfwRun([attempt({ rule, result: { stdout: '', stderr: '', exitCode: 2 } })]);

    expect(outcome.failures[0].detail).toBe('exited 2 with no output');
  });
});

describe('dockerUserRules failure visibility', () => {
  it('fails the script when an insert is refused, instead of masking it behind the persist step', () => {
    const [script] = dockerUserRules([rule]);

    const inserts = script.split('; ').filter((c) => c.includes('-I DOCKER-USER'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const insert of inserts) expect(insert).toContain('|| exit 1');
  });
});
