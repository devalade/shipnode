import { describe, it, expect } from 'vitest';
import { parseSimpleUsersYml } from '../../src/cli/commands/user.js';

describe('parseSimpleUsersYml', () => {
  it('parses a single user entry', () => {
    const yaml = `
- username: alice
  publicKey: ssh-ed25519 AAAAC3Nza alice@host
  sudo: true
`;
    const users = parseSimpleUsersYml(yaml);
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('alice');
    expect(users[0].publicKey).toBe('ssh-ed25519 AAAAC3Nza alice@host');
    expect(users[0].sudo).toBe(true);
  });

  it('parses multiple users', () => {
    const yaml = `
- username: alice
  publicKey: ssh-ed25519 AAAAC alice
- username: bob
  publicKey: ssh-rsa AAAAB bob
`;
    const users = parseSimpleUsersYml(yaml);
    expect(users).toHaveLength(2);
    expect(users[0].username).toBe('alice');
    expect(users[1].username).toBe('bob');
  });

  it('defaults sudo to false when omitted', () => {
    const yaml = `
- username: alice
  publicKey: ssh-ed25519 AAAAC alice
`;
    const users = parseSimpleUsersYml(yaml);
    expect(users[0].sudo).toBeUndefined();
  });

  it('returns empty array for empty input', () => {
    expect(parseSimpleUsersYml('')).toEqual([]);
    expect(parseSimpleUsersYml('   \n\n')).toEqual([]);
  });

  it('skips entry with no username', () => {
    const yaml = `
  publicKey: ssh-ed25519 AAAAC orphan
`;
    const users = parseSimpleUsersYml(yaml);
    expect(users).toHaveLength(0);
  });
});
