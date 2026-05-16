import { createInterface } from 'readline';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function cmdUnlock(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      const lockFile = `${config.remotePath}/.shipnode/deploy.lock`;

      ui.info(`Checking for deployment lock on ${config.ssh.user}@${config.ssh.host}...`);

      const result = await executor.exec(
        `if [ -f "${lockFile}" ]; then ` +
          `age=$(( $(date +%s) - $(stat -c %Y "${lockFile}") )); ` +
          `echo "FOUND:$age"; ` +
          `else echo "NOTFOUND"; fi`,
      );

      if (result.stdout === 'NOTFOUND') {
        ui.info('No deployment lock found.');
        return;
      }

      const age = result.stdout.split(':')[1];
      ui.warn(`Deployment lock found (age: ${age}s)`);

      const ok = await confirm('Clear this lock?');
      if (!ok) {
        ui.info('Lock not cleared.');
        return;
      }

      await executor.exec(`rm -f "${lockFile}"`);
      ui.success('Deployment lock cleared.');
    },
    { configPath: options.config },
  );
}
