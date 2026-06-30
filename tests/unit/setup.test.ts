import { describe, it, expect } from 'vitest';
import {
  buildDbInstallCommand,
  buildDbCreateCommand,
  buildDbProbeCommand,
  buildDbSetupCommand,
  buildRedisInstallCommand,
  buildRedisConfigureCommand,
  buildRedisProbeCommand,
  buildRedisSetupCommand,
} from '../../src/infrastructure/provisioning/commands.js';

describe('buildDbInstallCommand', () => {
  it('postgres: installs package and starts service', () => {
    const cmd = buildDbInstallCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain('apt-get install -y postgresql postgresql-contrib');
    expect(cmd).toContain('systemctl enable postgresql');
    expect(cmd).toContain('systemctl start postgresql');
  });

  it('mysql: installs package and starts service', () => {
    const cmd = buildDbInstallCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain('apt-get install -y mysql-server');
    expect(cmd).toContain('systemctl enable mysql');
    expect(cmd).toContain('systemctl start mysql');
  });

  it('mongodb: installs package and starts mongod', () => {
    const cmd = buildDbInstallCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain('command -v mongod');
    expect(cmd).toContain('mongodb-org');
    expect(cmd).toContain('systemctl enable mongod');
    expect(cmd).toContain('systemctl start mongod');
  });

  it('install command does not contain user or database creation', () => {
    for (const type of ['postgres', 'mysql', 'mongodb'] as const) {
      const cmd = buildDbInstallCommand({ type, host: 'localhost', port: 5432, name: 'mydb', user: 'myuser', password: 'secret' });
      expect(cmd).not.toContain('CREATE USER');
      expect(cmd).not.toContain('CREATE DATABASE');
      expect(cmd).not.toContain('createUser');
    }
  });
});

describe('buildDbCreateCommand', () => {
  it('postgres: creates user and database', () => {
    const cmd = buildDbCreateCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain('CREATE USER \\"myuser\\"');
    expect(cmd).toContain("datname='mydb'");
    expect(cmd).toContain('createdb -O "myuser" "mydb"');
  });

  it('postgres: includes password in CREATE USER', () => {
    const cmd = buildDbCreateCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("WITH PASSWORD 'secret'");
  });

  it('postgres: escapes $ in user/name to prevent shell expansion', () => {
    const cmd = buildDbCreateCommand({ type: 'postgres', host: 'localhost', port: 5432, name: '$mydb', user: '$myuser', password: 'p' });
    expect(cmd).toContain('\\$myuser');
    expect(cmd).toContain('\\$mydb');
  });

  it('mysql: creates user, database, and grants privileges', () => {
    const cmd = buildDbCreateCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain("CREATE USER IF NOT EXISTS 'myuser'@'localhost'");
    expect(cmd).toContain('CREATE DATABASE IF NOT EXISTS');
    expect(cmd).toContain('GRANT ALL PRIVILEGES ON');
    expect(cmd).toContain('FLUSH PRIVILEGES');
  });

  it('mysql: includes IDENTIFIED BY when password provided', () => {
    const cmd = buildDbCreateCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("IDENTIFIED BY 'secret'");
  });

  it('mongodb: enables auth and creates user when password provided', () => {
    const cmd = buildDbCreateCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain('authorization: enabled');
    expect(cmd).toContain("db.createUser({user:'myuser',pwd:'secret'");
  });

  it('mongodb: returns true when no password', () => {
    const cmd = buildDbCreateCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser' });
    expect(cmd).toBe('true');
  });

  it('create command does not contain service installation', () => {
    for (const type of ['postgres', 'mysql'] as const) {
      const cmd = buildDbCreateCommand({ type, host: 'localhost', port: 5432, name: 'mydb', user: 'myuser' });
      expect(cmd).not.toContain('apt-get install');
      expect(cmd).not.toContain('systemctl enable');
    }
  });
});

describe('buildDbProbeCommand', () => {
  it('returns null when no password', () => {
    expect(buildDbProbeCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser' })).toBeNull();
    expect(buildDbProbeCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser' })).toBeNull();
    expect(buildDbProbeCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser' })).toBeNull();
  });

  it('postgres: uses PGPASSWORD and connects as app user', () => {
    const cmd = buildDbProbeCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("PGPASSWORD='secret'");
    expect(cmd).toContain("-U 'myuser'");
    expect(cmd).toContain("-d 'mydb'");
  });

  it('mysql: uses MYSQL_PWD env var', () => {
    const cmd = buildDbProbeCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("MYSQL_PWD='secret'");
    expect(cmd).toContain("-u 'myuser'");
    expect(cmd).toContain("'mydb'");
  });

  it('mongodb: authenticates against the correct database', () => {
    const cmd = buildDbProbeCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("-u 'myuser'");
    expect(cmd).toContain("-p 'secret'");
    expect(cmd).toContain("--authenticationDatabase 'mydb'");
  });
});

describe('buildDbSetupCommand (combined)', () => {
  it('throws for sqlite', () => {
    expect(() => buildDbSetupCommand({ type: 'sqlite', name: './data.db' })).toThrow();
  });

  it('combines install, create, and probe into one command', () => {
    const cmd = buildDbSetupCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain('apt-get install -y postgresql');
    expect(cmd).toContain('CREATE USER');
    expect(cmd).toContain("PGPASSWORD='secret'");
  });
});

describe('buildRedisInstallCommand', () => {
  it('installs and starts redis-server', () => {
    const cmd = buildRedisInstallCommand({ host: 'localhost', port: 6379 });
    expect(cmd).toContain('apt-get install -y redis-server');
    expect(cmd).toContain('systemctl enable redis-server');
    expect(cmd).toContain('systemctl start redis-server');
  });

  it('does not set requirepass', () => {
    const cmd = buildRedisInstallCommand({ host: 'localhost', port: 6379, password: 'secret' });
    expect(cmd).not.toContain('requirepass');
  });
});

describe('buildRedisConfigureCommand', () => {
  it('returns true when no password', () => {
    expect(buildRedisConfigureCommand({ host: 'localhost', port: 6379 })).toBe('true');
  });

  it('sets requirepass and restarts when password provided', () => {
    const cmd = buildRedisConfigureCommand({ host: 'localhost', port: 6379, password: 'secret' });
    expect(cmd).toContain('requirepass secret');
    expect(cmd).toContain('systemctl restart redis-server');
  });

  it('does not use / as sed delimiter — password with slash must not break sed', () => {
    const cmd = buildRedisConfigureCommand({ host: 'localhost', port: 6379, password: 'pass/word' });
    expect(cmd).not.toMatch(/sed -i "s\//);
    expect(cmd).toContain('requirepass pass/word');
  });

  it('escapes $ in password to prevent shell expansion', () => {
    const cmd = buildRedisConfigureCommand({ host: 'localhost', port: 6379, password: '$ecret' });
    expect(cmd).toContain('\\$ecret');
  });
});

describe('buildRedisProbeCommand', () => {
  it('returns null when no password', () => {
    expect(buildRedisProbeCommand({ host: 'localhost', port: 6379 })).toBeNull();
  });

  it('pings with the correct password and port', () => {
    const cmd = buildRedisProbeCommand({ host: 'localhost', port: 6379, password: 'secret' });
    expect(cmd).toContain("redis-cli -h localhost -p 6379 -a 'secret' PING");
  });
});

describe('buildRedisSetupCommand (combined)', () => {
  it('combines install, configure, and probe', () => {
    const cmd = buildRedisSetupCommand({ host: 'localhost', port: 6379, password: 'secret' });
    expect(cmd).toContain('apt-get install -y redis-server');
    expect(cmd).toContain('requirepass secret');
    expect(cmd).toContain("redis-cli -h localhost -p 6379 -a 'secret' PING");
  });
});
