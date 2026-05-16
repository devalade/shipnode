import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import { confirm } from '../prompt.js';

interface UserEntry {
  username: string;
  publicKey: string;
  sudo?: boolean;
}

function parseUsersYml(cwd: string): UserEntry[] {
  const paths = [
    join(cwd, '.shipnode', 'users.yml'),
    join(cwd, 'users.yml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8');
      return parseSimpleUsersYml(raw);
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

export async function cmdUserSync(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  const users = parseUsersYml(cwd);

  if (users.length === 0) {
    ui.warn('No users.yml found. Create .shipnode/users.yml with username/publicKey entries.');
    process.exit(1);
  }

  await runRemoteCommand(
    cwd,
    async ({ executor }) => {
      ui.info(`Syncing ${users.length} user(s)...`);

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

        await executor.exec(`SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO bash -c '${script}'`);
        ui.success(`Synced user: ${user.username}${user.sudo ? ' (sudo)' : ''}`);
      }
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
