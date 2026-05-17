import { Listr } from 'listr2';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, DatabaseConfig, NetworkDatabaseConfig, RedisConfig } from '../../shared/types.js';

export async function cmdSetup(cwd: string, options: { config?: string }): Promise<void> {
  await runRemoteCommand(
    cwd,
    async ({ config, executor }) => {
      ui.banner();
      ui.step(`Setting up ${config.ssh.user}@${config.ssh.host}`);

      await buildTasks(executor, config).run();

      ui.outro('Server ready — run: shipnode deploy');
    },
    { configPath: options.config },
  );
}

function buildTasks(executor: RemoteExecutor, config: ShipnodeConfig) {
  const nodeVersion = config.nodeVersion === 'lts' ? '24' : config.nodeVersion;
  const mise = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"`;

  return new Listr(
    [
      {
        title: 'System dependencies',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: 'Update package index',
            task: () => executor.exec(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; $SUDO apt-get update -qq',
            ),
          },
          {
            title: 'Install curl git jq rsync build-essential',
            task: () => executor.exec(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
              '$SUDO apt-get install -y curl git jq rsync build-essential',
            ),
          },
        ], { concurrent: false }),
      },
      {
        title: 'Mise (version manager)',
        task: () =>
          executor.exec(
            `if ! command -v mise &>/dev/null; then curl -fsSL https://mise.run | sh; fi`,
          ),
      },
      {
        title: `Node.js ${config.nodeVersion}`,
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: `Install node@${nodeVersion}`,
            task: () => executor.exec(`${mise}; mise install -y "node@${nodeVersion}"`),
          },
          {
            title: `Set node@${nodeVersion} as global default`,
            task: () => executor.exec(`${mise}; mise use -g -y "node@${nodeVersion}"`),
          },
        ], { concurrent: false }),
      },
      {
        title: 'PM2',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: 'Install pm2',
            task: () => executor.exec(
              `${mise}; ` +
              `if ! mise exec "node@${nodeVersion}" -- pm2 --version &>/dev/null; then ` +
              `  mise exec "node@${nodeVersion}" -- npm install -g pm2; ` +
              `fi`,
            ),
          },
          {
            title: 'Configure systemd startup',
            task: () => executor.exec(
              `${mise}; ` +
              `mise exec "node@${nodeVersion}" -- pm2 startup systemd -u $USER --hp $HOME || true; ` +
              `mise exec "node@${nodeVersion}" -- pm2 save --force || true`,
            ),
          },
        ], { concurrent: false }),
      },
      {
        title: 'Caddy',
        task: () =>
          executor.exec(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            'if ! command -v caddy &>/dev/null; then ' +
            '  $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https; ' +
            '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; ' +
            '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list; ' +
            '  $SUDO apt-get update && $SUDO apt-get install -y caddy; ' +
            'fi',
          ),
      },
      ...(config.database && config.database.type !== 'sqlite' && config.database.host === 'localhost'
        ? [{
            title: `Database (${config.database.type})`,
            task: (_ctx: object, task: any) => {
              const db = config.database as NetworkDatabaseConfig;
              const probe = buildDbProbeCommand(db);
              return task.newListr([
                {
                  title: `Install ${db.type}`,
                  task: () => executor.exec(buildDbInstallCommand(db)),
                },
                {
                  title: `Create user '${db.user}' and database '${db.name}'`,
                  task: () => executor.exec(buildDbCreateCommand(db)),
                },
                ...(probe ? [{ title: 'Verify connection', task: () => executor.exec(probe) }] : []),
              ], { concurrent: false });
            },
          }]
        : []),
      ...(config.redis && config.redis.host === 'localhost'
        ? [{
            title: 'Redis',
            task: (_ctx: object, task: any) => {
              const redis = config.redis!;
              const probe = buildRedisProbeCommand(redis);
              return task.newListr([
                {
                  title: 'Install redis-server',
                  task: () => executor.exec(buildRedisInstallCommand(redis)),
                },
                ...(redis.password ? [{
                  title: 'Set password',
                  task: () => executor.exec(buildRedisConfigureCommand(redis)),
                }] : []),
                ...(probe ? [{ title: 'Verify connection', task: () => executor.exec(probe) }] : []),
              ], { concurrent: false });
            },
          }]
        : []),
      {
        title: 'Deployment directories',
        task: (_ctx: object, task: any) => task.newListr([
          {
            title: `Create release structure at ${config.remotePath}`,
            task: () => executor.exec(
              `mkdir -p "${config.remotePath}/releases" "${config.remotePath}/shared" "${config.remotePath}/.shipnode"`,
            ),
          },
          {
            title: 'Configure Caddy include',
            task: () => executor.exec(
              'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
              '$SUDO mkdir -p /etc/caddy/conf.d /var/log/caddy && ' +
              'grep -q "import /etc/caddy/conf.d" /etc/caddy/Caddyfile 2>/dev/null || ' +
              'echo "import /etc/caddy/conf.d/*.caddy" | $SUDO tee -a /etc/caddy/Caddyfile > /dev/null && ' +
              '$SUDO systemctl reload caddy 2>/dev/null || true',
            ),
          },
        ], { concurrent: false }),
      },
    ],
    { rendererOptions: { collapseErrors: false } },
  );
}

function sh(s: string): string {
  return s.replace(/'/g, "'\"'\"'");
}

function shDq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

export function buildDbInstallCommand(db: NetworkDatabaseConfig): string {
  const preamble = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"';

  if (db.type === 'postgres') {
    return `${preamble}; $SUDO apt-get install -y postgresql postgresql-contrib && $SUDO systemctl enable postgresql && $SUDO systemctl start postgresql`;
  }

  if (db.type === 'mysql') {
    return `${preamble}; $SUDO apt-get install -y mysql-server && $SUDO systemctl enable mysql && $SUDO systemctl start mysql`;
  }

  if (db.type === 'mongodb') {
    const installCmd =
      'if ! command -v mongod &>/dev/null; then ' +
        'curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | $SUDO gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg; ' +
        'echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | $SUDO tee /etc/apt/sources.list.d/mongodb-org-7.0.list; ' +
        '$SUDO apt-get update -qq && $SUDO apt-get install -y mongodb-org; ' +
      'fi';
    return `${preamble}; ${installCmd} && $SUDO systemctl enable mongod && $SUDO systemctl start mongod`;
  }

  throw new Error(`Unsupported database type: ${(db as DatabaseConfig).type}`);
}

export function buildDbCreateCommand(db: NetworkDatabaseConfig): string {
  // preamble uses ';' so the conditional SUDO/PG_RUN assignments don't break
  // the '&&' chain when running as root (EUID=0 makes [ -ne 0 ] exit 1)
  const preamble = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; PG_RUN="runuser -u postgres --"; [ "$EUID" -ne 0 ] && PG_RUN="sudo -u postgres"';

  if (db.type === 'postgres') {
    const userDq = shDq(db.user);
    const nameDq = shDq(db.name);
    const createUser = db.password
      ? `$PG_RUN psql -c "CREATE USER \\"${userDq}\\" WITH PASSWORD '${shDq(db.password)}';" 2>/dev/null || true`
      : `$PG_RUN psql -c "CREATE USER \\"${userDq}\\";" 2>/dev/null || true`;
    const commands = [
      createUser,
      `$PG_RUN psql -tc "SELECT 1 FROM pg_database WHERE datname='${nameDq}'" | grep -q 1 || $PG_RUN createdb -O "${userDq}" "${nameDq}"`,
    ];
    return `${preamble}; ${commands.join(' && ')}`;
  }

  if (db.type === 'mysql') {
    const userDq = shDq(db.user);
    const nameDq = shDq(db.name);
    const pwClause = db.password ? `IDENTIFIED BY '${shDq(db.password)}'` : '';
    const commands = [
      `$SUDO mysql -e "CREATE USER IF NOT EXISTS '${userDq}'@'localhost' ${pwClause};"`,
      `$SUDO mysql -e "CREATE DATABASE IF NOT EXISTS \\\`${nameDq}\\\`;"`,
      `$SUDO mysql -e "GRANT ALL PRIVILEGES ON \\\`${nameDq}\\\`.* TO '${userDq}'@'localhost';"`,
      `$SUDO mysql -e "FLUSH PRIVILEGES;"`,
    ];
    return `${preamble}; ${commands.join(' && ')}`;
  }

  if (db.type === 'mongodb') {
    if (!db.password) return 'true';
    const nameDq = shDq(db.name);
    const userDq = shDq(db.user);
    const pwdDq = shDq(db.password);
    const commands = [
      `if ! grep -q "authorization: enabled" /etc/mongod.conf 2>/dev/null; then echo -e "\\nsecurity:\\n  authorization: enabled" | $SUDO tee -a /etc/mongod.conf > /dev/null && $SUDO systemctl restart mongod; fi`,
      `mongosh "${nameDq}" --eval "db.createUser({user:'${userDq}',pwd:'${pwdDq}',roles:[{role:'readWrite',db:'${nameDq}'}]})" 2>/dev/null || true`,
    ];
    return `${preamble}; ${commands.join(' && ')}`;
  }

  throw new Error(`Unsupported database type: ${(db as DatabaseConfig).type}`);
}

export function buildDbProbeCommand(db: NetworkDatabaseConfig): string | null {
  if (!db.password) return null;

  if (db.type === 'postgres') {
    return `PGPASSWORD='${sh(db.password)}' psql -h localhost -U '${sh(db.user)}' -d '${sh(db.name)}' -c "SELECT 1" > /dev/null`;
  }

  if (db.type === 'mysql') {
    return `MYSQL_PWD='${sh(db.password)}' mysql -h 127.0.0.1 -u '${sh(db.user)}' '${sh(db.name)}' -e "SELECT 1" > /dev/null`;
  }

  if (db.type === 'mongodb') {
    return `mongosh --host localhost '${sh(db.name)}' -u '${sh(db.user)}' -p '${sh(db.password)}' --authenticationDatabase '${sh(db.name)}' --eval "db.runCommand({ping:1})" --quiet > /dev/null`;
  }

  throw new Error(`Unsupported database type: ${(db as DatabaseConfig).type}`);
}

export function buildDbSetupCommand(db: DatabaseConfig): string {
  if (db.type === 'sqlite') {
    throw new Error(`buildDbSetupCommand called for sqlite — caller should guard against this`);
  }
  const install = buildDbInstallCommand(db);
  const create = buildDbCreateCommand(db);
  const probe = buildDbProbeCommand(db);
  return [install, create, ...(probe ? [probe] : [])].join(' && ');
}

export function buildRedisInstallCommand(_redis: RedisConfig): string {
  const preamble = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"';
  return `${preamble}; $SUDO apt-get install -y redis-server && $SUDO systemctl enable redis-server && $SUDO systemctl start redis-server`;
}

export function buildRedisConfigureCommand(redis: RedisConfig): string {
  const preamble = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"';
  if (!redis.password) return 'true';
  const parts = [
    `$SUDO sed -i '/^#* *requirepass/d' /etc/redis/redis.conf`,
    `echo "requirepass ${shDq(redis.password)}" | $SUDO tee -a /etc/redis/redis.conf > /dev/null`,
    '$SUDO systemctl restart redis-server',
  ];
  return `${preamble}; ${parts.join(' && ')}`;
}

export function buildRedisProbeCommand(redis: RedisConfig): string | null {
  if (!redis.password) return null;
  return `redis-cli -h localhost -p ${redis.port} -a '${sh(redis.password)}' PING > /dev/null 2>&1`;
}

export function buildRedisSetupCommand(redis: RedisConfig): string {
  const install = buildRedisInstallCommand(redis);
  const configure = buildRedisConfigureCommand(redis);
  const probe = buildRedisProbeCommand(redis);
  return [install, configure, ...(probe ? [probe] : [])].join(' && ');
}
