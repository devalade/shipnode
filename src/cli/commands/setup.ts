import { Listr } from 'listr2';
import { runRemoteCommand } from '../runner.js';
import { ui } from '../ui.js';
import type { RemoteExecutor } from '../../domain/remote/executor.js';
import type { ShipnodeConfig, DatabaseConfig, RedisConfig } from '../../shared/types.js';

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
        task: () =>
          executor.exec(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            '$SUDO apt-get update -qq && ' +
            '$SUDO apt-get install -y curl git jq rsync build-essential',
          ),
      },
      {
        title: 'Mise (version manager)',
        task: () =>
          executor.exec(
            `if ! command -v mise &>/dev/null; then curl -fsSL https://mise.run | sh; fi`,
          ),
      },
      {
        title: `Node.js ${nodeVersion}`,
        task: () =>
          executor.exec(
            `${mise}; ` +
            `mise install -y "node@${nodeVersion}"; ` +
            `mise use -g -y "node@${nodeVersion}"`,
          ),
      },
      {
        title: 'PM2',
        task: () =>
          executor.exec(
            `${mise}; ` +
            `if ! mise exec "node@${nodeVersion}" -- pm2 --version &>/dev/null; then ` +
            `  mise exec "node@${nodeVersion}" -- npm install -g pm2; ` +
            `fi; ` +
            `mise exec "node@${nodeVersion}" -- pm2 startup systemd -u $USER --hp $HOME || true; ` +
            `mise exec "node@${nodeVersion}" -- pm2 save --force || true`,
          ),
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
            task: () => executor.exec(buildDbSetupCommand(config.database!)),
          }]
        : []),
      ...(config.redis && config.redis.host === 'localhost'
        ? [{
            title: 'Redis',
            task: () => executor.exec(buildRedisSetupCommand(config.redis!)),
          }]
        : []),
      {
        title: 'Deployment directories',
        task: async () => {
          await executor.exec(
            `mkdir -p "${config.remotePath}/releases" "${config.remotePath}/shared" "${config.remotePath}/.shipnode"`,
          );
          await executor.exec(
            'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"; ' +
            '$SUDO mkdir -p /etc/caddy/conf.d /var/log/caddy && ' +
            'grep -q "import /etc/caddy/conf.d" /etc/caddy/Caddyfile 2>/dev/null || ' +
            'echo "import /etc/caddy/conf.d/*.caddy" | $SUDO tee -a /etc/caddy/Caddyfile > /dev/null && ' +
            '$SUDO systemctl reload caddy 2>/dev/null || true',
          );
        },
      },
    ],
    { rendererOptions: { collapseErrors: false } },
  );
}

function sh(s: string): string {
  return s.replace(/'/g, "'\"'\"'");
}

function buildDbSetupCommand(db: DatabaseConfig): string {
  const sudo = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"';

  if (db.type === 'postgres') {
    const createUser = db.password
      ? `$SUDO -u postgres psql -c "CREATE USER \\"${sh(db.user)}\\" WITH PASSWORD '${sh(db.password)}';" 2>/dev/null || true`
      : `$SUDO -u postgres psql -c "CREATE USER \\"${sh(db.user)}\\";" 2>/dev/null || true`;
    return [
      sudo,
      '$SUDO apt-get install -y postgresql postgresql-contrib',
      '$SUDO systemctl enable postgresql',
      '$SUDO systemctl start postgresql',
      createUser,
      `$SUDO -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${sh(db.name)}'" | grep -q 1 || $SUDO -u postgres createdb -O "${sh(db.user)}" "${sh(db.name)}"`,
    ].join(' && ');
  }

  if (db.type === 'mysql') {
    const pwClause = db.password ? `IDENTIFIED BY '${sh(db.password)}'` : '';
    return [
      sudo,
      '$SUDO apt-get install -y mysql-server',
      '$SUDO systemctl enable mysql',
      '$SUDO systemctl start mysql',
      `$SUDO mysql -e "CREATE USER IF NOT EXISTS '${sh(db.user)}'@'localhost' ${pwClause};"`,
      `$SUDO mysql -e "CREATE DATABASE IF NOT EXISTS \\\`${sh(db.name)}\\\`;"`,
      `$SUDO mysql -e "GRANT ALL PRIVILEGES ON \\\`${sh(db.name)}\\\`.* TO '${sh(db.user)}'@'localhost';"`,
      `$SUDO mysql -e "FLUSH PRIVILEGES;"`,
    ].join(' && ');
  }

  if (db.type === 'mongodb') {
    const createUser = db.password
      ? `mongosh "${sh(db.name)}" --eval "db.createUser({user:'${sh(db.user)}',pwd:'${sh(db.password)}',roles:[{role:'readWrite',db:'${sh(db.name)}'}]})" 2>/dev/null || true`
      : `mongosh "${sh(db.name)}" --eval "db.createUser({user:'${sh(db.user)}',roles:[{role:'readWrite',db:'${sh(db.name)}'}]})" 2>/dev/null || true`;
    return [
      sudo,
      'if ! command -v mongod &>/dev/null; then ' +
        'curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | $SUDO gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg; ' +
        'echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | $SUDO tee /etc/apt/sources.list.d/mongodb-org-7.0.list; ' +
        '$SUDO apt-get update -qq && $SUDO apt-get install -y mongodb-org; ' +
      'fi',
      '$SUDO systemctl enable mongod',
      '$SUDO systemctl start mongod',
      createUser,
    ].join(' && ');
  }

  return 'true';
}

function buildRedisSetupCommand(redis: RedisConfig): string {
  const sudo = 'SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"';
  const parts = [
    sudo,
    '$SUDO apt-get install -y redis-server',
    '$SUDO systemctl enable redis-server',
    '$SUDO systemctl start redis-server',
  ];

  if (redis.password) {
    parts.push(
      `$SUDO sed -i "s/^# requirepass .*/requirepass ${sh(redis.password)}/" /etc/redis/redis.conf`,
      `grep -q "^requirepass" /etc/redis/redis.conf || echo "requirepass ${sh(redis.password)}" | $SUDO tee -a /etc/redis/redis.conf > /dev/null`,
      '$SUDO systemctl restart redis-server',
    );
  }

  return parts.join(' && ');
}
