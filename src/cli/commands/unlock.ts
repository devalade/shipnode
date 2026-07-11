import { runRemoteCommandForTargets } from '../runner.js';
import { ui } from '../ui.js';
import { confirm } from '../prompt.js';

export async function cmdUnlock(
  cwd: string,
  options: { config?: string },
): Promise<void> {
  await runRemoteCommandForTargets(
    cwd,
    async ({ config, executor, serverName }) => {
      const lockPath = `${config.remotePath}/.shipnode/deploy.lock`;

      ui.info(`Checking for deployment lock on ${serverName} (${config.ssh.user}@${config.ssh.host})...`);

      const result = await executor.exec(
        `if [ -e "${lockPath}" ]; then ` +
          `age=$(( $(date +%s) - $(stat -c %Y "${lockPath}") )); ` +
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

      await executor.exec(`rm -rf "${lockPath}"`);
      ui.success('Deployment lock cleared.');
    },
    { configPath: options.config, includeEmpty: true },
  );
}
