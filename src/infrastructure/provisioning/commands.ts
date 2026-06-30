import type { NetworkDatabaseConfig, RedisConfig, DatabaseConfig } from '../../shared/types.js';

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
