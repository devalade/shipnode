import { describe, it, expect } from 'vitest';
import {
  otherColor,
  portFor,
  resolveAltPort,
  coloredWebName,
  resolveTarget,
  readDeployState,
  writeDeployState,
  type DeployState,
} from '../../src/domain/deploy/blue-green.js';
import { FakeRemoteExecutor } from '../testing/fake-executor.js';

describe('blue-green helpers', () => {
  it('otherColor flips', () => {
    expect(otherColor('blue')).toBe('green');
    expect(otherColor('green')).toBe('blue');
  });

  it('portFor reads the matching port', () => {
    const state: DeployState = { activeColor: 'blue', bluePort: 3000, greenPort: 3001 };
    expect(portFor('blue', state)).toBe(3000);
    expect(portFor('green', state)).toBe(3001);
  });

  it('resolveAltPort defaults to an uncommon port 10,000 above the web port', () => {
    expect(resolveAltPort(3000)).toBe(13000);
    expect(resolveAltPort(3000, 4000)).toBe(4000);
  });

  it('resolveAltPort stays within the valid TCP port range', () => {
    expect(resolveAltPort(60_000)).toBe(50_000);
  });

  it('coloredWebName suffixes the pm2 name', () => {
    // web app name equals namespace -> unprefixed, then coloured
    expect(coloredWebName('api', 'api', 'blue')).toBe('api-blue');
    // worker-style prefixing still applies before the colour
    expect(coloredWebName('api', 'web', 'green')).toBe('api-web-green');
  });
});

describe('resolveTarget', () => {
  it('first deploy targets green so a legacy process can keep serving on blue', () => {
    const t = resolveTarget(null, 3000, 3001);
    expect(t).toMatchObject({
      color: 'green',
      port: 3001,
      previousColor: null,
      previousPort: null,
      bluePort: 3000,
      greenPort: 3001,
    });
  });

  it('when blue is active, targets green', () => {
    const state: DeployState = { activeColor: 'blue', bluePort: 3000, greenPort: 3001 };
    const t = resolveTarget(state, 3000, 3001);
    expect(t).toMatchObject({
      color: 'green',
      port: 3001,
      previousColor: 'blue',
      previousPort: 3000,
    });
  });

  it('when green is active, targets blue', () => {
    const state: DeployState = { activeColor: 'green', bluePort: 3000, greenPort: 3001 };
    const t = resolveTarget(state, 3000, 3001);
    expect(t).toMatchObject({ color: 'blue', port: 3000, previousColor: 'green', previousPort: 3001 });
  });

  it('preserves the persisted port pair, ignoring config drift', () => {
    const state: DeployState = { activeColor: 'blue', bluePort: 8000, greenPort: 8001 };
    // config now says 3000/3001 but state wins
    const t = resolveTarget(state, 3000, 3001);
    expect(t.bluePort).toBe(8000);
    expect(t.greenPort).toBe(8001);
    expect(t.port).toBe(8001);
  });
});

describe('deploy state persistence', () => {
  it('readDeployState returns null when file missing', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when((cmd) => cmd.includes('deploy-state.json'), { stdout: '', stderr: '', exitCode: 0 });
    expect(await readDeployState(executor, '/var/www/app/api')).toBeNull();
  });

  it('readDeployState parses a valid state', async () => {
    const executor = new FakeRemoteExecutor();
    const state: DeployState = { activeColor: 'green', bluePort: 3000, greenPort: 3001 };
    executor.when((cmd) => cmd.includes('deploy-state.json'), {
      stdout: JSON.stringify(state),
      stderr: '',
      exitCode: 0,
    });
    expect(await readDeployState(executor, '/var/www/app/api')).toEqual(state);
  });

  it('readDeployState treats corrupt json as no state', async () => {
    const executor = new FakeRemoteExecutor();
    executor.when((cmd) => cmd.includes('deploy-state.json'), {
      stdout: '{ not json',
      stderr: '',
      exitCode: 0,
    });
    expect(await readDeployState(executor, '/var/www/app/api')).toBeNull();
  });

  it('writeDeployState base64-encodes into .shipnode', async () => {
    const executor = new FakeRemoteExecutor();
    await writeDeployState(executor, '/var/www/app/api', {
      activeColor: 'blue',
      bluePort: 3000,
      greenPort: 3001,
    });
    const cmd = executor.getLastCommand()!.command;
    expect(cmd).toContain('/var/www/app/api/.shipnode/deploy-state.json');
    expect(cmd).toContain('base64 -d');
  });
});
