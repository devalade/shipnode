import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve, isAbsolute } from 'path';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { confirm } from '../prompt.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';

export interface UserEntry {
  username: string;
  publicKey: string;
  sudo?: boolean;
}

function usersYmlPath(cwd: string): string {
  return join(cwd, '.shipnode', 'users.yml');
}

export function loadUsersYml(cwd: string): UserEntry[] {
  const paths = [usersYmlPath(cwd), join(cwd, 'users.yml')];
  for (const p of paths) {
    if (existsSync(p)) {
      return parseSimpleUsersYml(readFileSync(p, 'utf8'));
    }
  }
  return [];
}

export function parseSimpleUsersYml(raw: string): UserEntry[] {
  const users: UserEntry[] = [];
  const lines = raw.split('\n');
  let current: Partial<UserEntry> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- username:') || trimmed.startsWith('username:')) {
      if (current?.username) users.push(current as UserEntry);
      current = { username: trimmed.split(':')[1].trim() };
    } else if (current && trimmed.startsWith('publicKey:')) {
      current.publicKey = trimmed.replace('publicKey:', '').trim();
    } else if (current && trimmed.startsWith('sudo:')) {
      current.sudo = trimmed.includes('true');
    }
  }
  if (current?.username) users.push(current as UserEntry);
  return users;
}

export function serializeUsersYml(users: UserEntry[]): string {
  return users
    .map((u) => {
      const lines = [
        `- username: ${u.username}`,
        `  publicKey: ${u.publicKey}`,
      ];
      if (u.sudo) lines.push('  sudo: true');
      return lines.join('\n');
    })
    .join('\n') + '\n';
}

export function saveUsersYml(cwd: string, users: UserEntry[]): string {
  const path = usersYmlPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeUsersYml(users));
  return path;
}

export function upsertUser(users: UserEntry[], entry: UserEntry): UserEntry[] {
  const idx = users.findIndex((u) => u.username === entry.username);
  if (idx >= 0) {
    const next = users.slice();
    next[idx] = entry;
    return next;
  }
  return [...users, entry];
}

export async function syncUsers(executor: RemoteExecutor, users: UserEntry[]): Promise<void> {
  for (const user of users) {
    if (!user.publicKey) {
      ui.warn(`Skipping ${user.username}: no publicKey`);
      continue;
    }
    const sudoGroups = user.sudo ? ',sudo' : '';
    const script = [
      `id "${user.username}" &>/dev/null || useradd -m -s /bin/bash${sudoGroups ? ` -G "${sudoGroups.slice(1)}"` : ''} "${user.username}"`,
      `mkdir -p "/home/${user.username}/.ssh"`,
      `echo "${user.publicKey}" >> "/home/${user.username}/.ssh/authorized_keys"`,
      `sort -u "/home/${user.username}/.ssh/authorized_keys" -o "/home/${user.username}/.ssh/authorized_keys"`,
      `chmod 700 "/home/${user.username}/.ssh"`,
      `chmod 600 "/home/${user.username}/.ssh/authorized_keys"`,
      `chown -R "${user.username}:${user.username}" "/home/${user.username}/.ssh"`,
    ].join(' && ');

    await executor.execOrThrow(`SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO bash -c '${script}'`);
  }
}

function resolvePubKey(cwd: string, keyOpt: string | undefined, identityFile: string | undefined): string {
  const tried: string[] = [];
  const candidates: string[] = [];
  if (keyOpt) candidates.push(isAbsolute(keyOpt) ? keyOpt : resolve(cwd, keyOpt));
  else if (identityFile) candidates.push(`${identityFile}.pub`);

  for (const path of candidates) {
    tried.push(path);
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  }
  throw new Error(
    `No SSH public key found. Tried: ${tried.join(', ') || '(none)'}. ` +
      `Pass --key <path> or set ssh.identityFile in shipnode.config.ts.`,
  );
}

export async function cmdUserSync(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  const users = loadUsersYml(cwd);

  if (users.length === 0) {
    ui.warn('No users.yml found. Create .shipnode/users.yml or run: shipnode user add <name>');
    process.exit(1);
  }

  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      ui.info(`Syncing ${users.length} user(s)...`);
      await syncUsers(executor, users);
      for (const u of users) {
        ui.success(`Synced user: ${u.username}${u.sudo ? ' (sudo)' : ''}`);
      }
    },
    { configPath: options.config },
  );
}

export async function cmdUserAdd(
  cwd: string,
  username: string,
  options: { key?: string; sudo?: boolean; noSync?: boolean; config?: string },
): Promise<void> {
  if (!username) {
    ui.error('Username required');
    process.exit(1);
  }

  const existing = loadUsersYml(cwd);
  const { loadConfig } = await import('../../config/loader.js');
  const config = await loadConfig(cwd, options.config).catch(() => null);
  const publicKey = resolvePubKey(cwd, options.key, config?.ssh.identityFile);

  const entry: UserEntry = { username, publicKey, sudo: options.sudo ?? false };
  const next = upsertUser(existing, entry);
  const path = saveUsersYml(cwd, next);
  ui.success(`Wrote ${username} to ${path}`);

  if (options.noSync) return;

  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      ui.info(`Syncing ${username} to server...`);
      await syncUsers(executor, [entry]);
      ui.success(`Synced user: ${username}${entry.sudo ? ' (sudo)' : ''}`);
    },
    { configPath: options.config },
  );
}

export async function cmdUserList(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      const result = await executor.exec(
        `awk -F: '$3 >= 1000 && $1 != "nobody" {print $1}' /etc/passwd | sort`,
      );
      const users = result.stdout.trim().split('\n').filter(Boolean);
      if (users.length === 0) {
        ui.info('No non-system users found.');
        return;
      }
      ui.info('Remote users (UID >= 1000):');
      for (const u of users) {
        console.log(`  ${u}`);
      }
    },
    { configPath: options.config },
  );
}

export async function cmdUserRemove(
  cwd: string,
  username: string,
  options: { config?: string },
): Promise<void> {
  if (!username) {
    ui.error('Username required');
    process.exit(1);
  }

  const ok = await confirm(`Remove user "${username}" from server?`);
  if (!ok) {
    ui.info('Cancelled.');
    return;
  }

  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      await executor.exec(
        `SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO userdel -r "${username}" 2>/dev/null || true`,
      );
      ui.success(`User "${username}" removed.`);
    },
    { configPath: options.config },
  );
}
