import { basename } from 'path';
import { execa } from 'execa';
import { loadConfig } from '../../config/loader.js';
import { SshConnection } from '../../infrastructure/ssh/connection.js';
import { ui } from '../ui.js';

const INTERACTIVE_SHELLS = new Set(['bash', 'sh', 'zsh', 'fish']);

function shellQuote(cmd: string): string {
  return "'" + cmd.replace(/'/g, "'\"'\"'") + "'";
}

export async function cmdRun(
  cwd: string,
  options: { tty?: boolean; config?: string },
  cmdArgs: string[],
): Promise<void> {
  if (cmdArgs.length === 0) {
    console.error('Usage: shipnode run [--tty] <command> [args...]');
    console.error('');
    console.error('Examples:');
    console.error('  shipnode run node -e "console.log(process.version)"');
    console.error('  shipnode run --tty bash');
    console.error('  shipnode run npx prisma migrate deploy');
    process.exit(1);
  }

  const config = await loadConfig(cwd, options.config);

  const aliasExpansion = config.aliases?.[cmdArgs[0]];
  const resolvedArgs = aliasExpansion
    ? [...aliasExpansion.split(' '), ...cmdArgs.slice(1)]
    : cmdArgs;

  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;
  const remotePath = config.remotePath;
  const cmd = resolvedArgs.join(' ');
  const cmdBase = basename(resolvedArgs[0]);

  const isInteractive = options.tty === true || INTERACTIVE_SHELLS.has(cmdBase);

  const sourceEnv = `if [ -f "${remotePath}/shared/.env" ]; then source "${remotePath}/shared/.env"; else echo "Warning: shared/.env not found" >&2; fi`;

  const remoteCmd = [
    mise,
    `cd "${remotePath}/current"`,
    sourceEnv,
    `mise exec node@${nodeVersion} -- bash -lc ${shellQuote(cmd)}`,
  ].join(' && ');

  const { host, user, port, identityFile } = config.ssh;

  if (isInteractive) {
    const sshArgs: string[] = [
      '-t',
      '-p', String(port),
      ...(identityFile ? ['-i', identityFile] : []),
      `${user}@${host}`,
      remoteCmd,
    ];

    const result = await execa('ssh', sshArgs, { stdio: 'inherit', reject: false });
    process.exit(result.exitCode ?? 0);
  } else {
    const ssh = new SshConnection();

    try {
      ui.info(`Connecting to ${user}@${host}...`);
      await ssh.connect(config.ssh);

      const result = await ssh.exec(remoteCmd);

      if (result.stdout) {
        process.stdout.write(result.stdout + '\n');
      }
      if (result.stderr) {
        process.stderr.write(result.stderr + '\n');
      }

      ssh.disconnect();
      process.exit(result.exitCode);
    } catch (error) {
      ssh.disconnect();
      const message = error instanceof Error ? error.message : String(error);
      ui.error(message);
      process.exit(1);
    }
  }
}
