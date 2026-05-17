import { describe, it, expect } from 'vitest';
import { buildDbSetupCommand, buildRedisSetupCommand } from '../../src/cli/commands/setup.js';

describe('buildDbSetupCommand', () => {
  it('postgres: installs, creates user and db', () => {
    const cmd = buildDbSetupCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain('apt-get install -y postgresql postgresql-contrib');
    expect(cmd).toContain('systemctl enable postgresql');
    expect(cmd).toContain('CREATE USER \\"myuser\\"');
    expect(cmd).toContain("datname='mydb'");
    expect(cmd).toContain('createdb -O "myuser" "mydb"');
  });

  it('postgres: includes password in createUser when provided', () => {
    const cmd = buildDbSetupCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("WITH PASSWORD 'secret'");
  });

  it('postgres: adds login probe when password is provided', () => {
    const cmd = buildDbSetupCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("PGPASSWORD='secret' psql -h localhost -U 'myuser' -d 'mydb'");
  });

  it('postgres: no login probe without password', () => {
    const cmd = buildDbSetupCommand({ type: 'postgres', host: 'localhost', port: 5432, name: 'mydb', user: 'myuser' });
    expect(cmd).not.toContain('PGPASSWORD');
  });

  it('postgres: escapes $ in user/name with shDq to prevent shell expansion', () => {
    const cmd = buildDbSetupCommand({ type: 'postgres', host: 'localhost', port: 5432, name: '$mydb', user: '$myuser', password: 'p' });
    expect(cmd).toContain('\\$myuser');
    expect(cmd).toContain('\\$mydb');
  });

  it('mysql: installs, creates user and db', () => {
    const cmd = buildDbSetupCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain('apt-get install -y mysql-server');
    expect(cmd).toContain("CREATE USER IF NOT EXISTS 'myuser'@'localhost'");
    expect(cmd).toContain('CREATE DATABASE IF NOT EXISTS');
    expect(cmd).toContain("GRANT ALL PRIVILEGES ON");
    expect(cmd).toContain('FLUSH PRIVILEGES');
  });

  it('mysql: adds login probe when password is provided', () => {
    const cmd = buildDbSetupCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("MYSQL_PWD='secret' mysql -h 127.0.0.1 -u 'myuser' 'mydb'");
  });

  it('mysql: no login probe without password', () => {
    const cmd = buildDbSetupCommand({ type: 'mysql', host: 'localhost', port: 3306, name: 'mydb', user: 'myuser' });
    expect(cmd).not.toContain('MYSQL_PWD');
  });

  it('mongodb: installs and starts mongod', () => {
    const cmd = buildDbSetupCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser' });
    expect(cmd).toContain('command -v mongod');
    expect(cmd).toContain('mongodb-org');
    expect(cmd).toContain('systemctl enable mongod');
    expect(cmd).toContain('systemctl start mongod');
  });

  it('mongodb: enables auth and creates user when password provided', () => {
    const cmd = buildDbSetupCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain('authorization: enabled');
    expect(cmd).toContain("db.createUser({user:'myuser',pwd:'secret'");
  });

  it('mongodb: adds login probe when password provided', () => {
    const cmd = buildDbSetupCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser', password: 'secret' });
    expect(cmd).toContain("mongosh --host localhost 'mydb' -u 'myuser' -p 'secret'");
  });

  it('mongodb: no auth or user creation without password', () => {
    const cmd = buildDbSetupCommand({ type: 'mongodb', host: 'localhost', port: 27017, name: 'mydb', user: 'myuser' });
    expect(cmd).not.toContain('authorization');
    expect(cmd).not.toContain('createUser');
  });

  it('throws for sqlite', () => {
    expect(() => buildDbSetupCommand({ type: 'sqlite', name: './data.db' })).toThrow();
  });
});

describe('buildRedisSetupCommand', () => {
  it('installs and starts redis', () => {
    const cmd = buildRedisSetupCommand({ host: 'localhost', port: 6379 });
    expect(cmd).toContain('apt-get install -y redis-server');
    expect(cmd).toContain('systemctl enable redis-server');
    expect(cmd).toContain('systemctl start redis-server');
    expect(cmd).not.toContain('requirepass');
  });

  it('sets requirepass and restarts when password provided', () => {
    const cmd = buildRedisSetupCommand({ host: 'localhost', port: 6379, password: 'secret' });
    expect(cmd).toContain('requirepass secret');
    expect(cmd).toContain('systemctl restart redis-server');
  });

  it('adds login probe when password provided', () => {
    const cmd = buildRedisSetupCommand({ host: 'localhost', port: 6379, password: 'secret' });
    expect(cmd).toContain("redis-cli -h localhost -p 6379 -a 'secret' PING");
  });

  it('does not use / as sed delimiter — password with slash must not break sed', () => {
    const cmd = buildRedisSetupCommand({ host: 'localhost', port: 6379, password: 'pass/word' });
    // Old code used s/.../.../ which breaks on /; new code deletes and appends instead
    expect(cmd).not.toMatch(/sed -i "s\//);
    expect(cmd).toContain('requirepass pass/word');
  });

  it('escapes $ in password to prevent shell expansion', () => {
    const cmd = buildRedisSetupCommand({ host: 'localhost', port: 6379, password: '$ecret' });
    expect(cmd).toContain('\\$ecret');
  });
});
