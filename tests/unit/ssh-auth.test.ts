import { describe, expect, it } from 'vitest';
import { resolveSshAuthentication } from '../../src/infrastructure/ssh/connection.js';
import type { SshConfig } from '../../src/shared/types.js';

const config: SshConfig = { host: 'example.com', user: 'deploy', port: 22 };

function fakeFiles(entries: Record<string, Buffer | Error>) {
  return {
    exists: (path: string) => path in entries,
    read: (path: string) => {
      const value = entries[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`missing fixture: ${path}`);
      return value;
    },
  };
}

describe('resolveSshAuthentication', () => {
  it('uses a configured identity file when it exists', () => {
    const result = resolveSshAuthentication(
      { ...config, identityFile: '/keys/deploy' },
      { homeDir: '/home/me', sshAuthSock: '/tmp/agent.sock' },
      fakeFiles({ '/keys/deploy': Buffer.from('configured') }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.privateKey?.toString()).toBe('configured');
  });

  it('falls back to SSH_AUTH_SOCK when the configured file is absent', () => {
    const result = resolveSshAuthentication(
      { ...config, identityFile: '/keys/missing' },
      { homeDir: '/home/me', sshAuthSock: '/tmp/agent.sock' },
      fakeFiles({}),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.agent).toBe('/tmp/agent.sock');
  });

  it('falls back to a standard key when no agent is available', () => {
    const result = resolveSshAuthentication(
      config,
      { homeDir: '/home/me' },
      fakeFiles({ '/home/me/.ssh/id_ed25519': Buffer.from('default') }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.privateKey?.toString()).toBe('default');
  });

  it('offers a standard key after the agent so ssh2 can try both methods', () => {
    const result = resolveSshAuthentication(
      config,
      { homeDir: '/home/me', sshAuthSock: '/tmp/agent.sock' },
      fakeFiles({ '/home/me/.ssh/id_ed25519': Buffer.from('default') }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agent).toBe('/tmp/agent.sock');
      expect(result.value.privateKey?.toString()).toBe('default');
    }
  });

  it('returns a typed error for an unreadable existing key', () => {
    const result = resolveSshAuthentication(
      { ...config, identityFile: '/keys/deploy' },
      { homeDir: '/home/me' },
      fakeFiles({ '/keys/deploy': new Error('EACCES') }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe('SshIdentityFileUnreadableError');
  });

  it('returns a typed error when no authentication method is available', () => {
    const result = resolveSshAuthentication(config, { homeDir: '/home/me' }, fakeFiles({}));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe('SshAuthenticationUnavailableError');
  });
});
