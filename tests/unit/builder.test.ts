import { describe, it, expect, vi } from 'vitest';
import { shipnode, ShipnodeBuilder, ShipnodeAppBuilder, app } from '../../src/config/builder.js';

describe('ShipnodeBuilder', () => {
  // Schema-coverage regression: every setter on the builder must produce a field that
  // survives the round-trip through assembleConfig + zod parse. This is what would
  // have caught the .aliases() drop (and would catch any future field that gets added
  // to the builder but forgotten in the schema or vice-versa).
  it('every setter writes a field that survives the parse round-trip', () => {
    const preDeploy = vi.fn();
    const postDeploy = vi.fn();
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '192.168.1.1', user: 'deploy', port: 2222, identityFile: '/k/id' })
      .deployTo('/var/www/myapp')
      .pm2('myapp', { instances: 2, maxMemory: '1G' })
      .port(3333)
      .worker({ name: 'mailer', command: 'node dist/mailer.js', instances: 1, maxMemory: '512M', env: { Q: 'mail' } })
      .domain('api.example.com')
      .keepReleases(10)
      .sharedDirs(['storage', 'uploads'])
      .sharedFiles(['.htpasswd'])
      .healthCheck('/healthz', { timeout: 60, retries: 5, startupDelay: 10 })
      .envFile('.env.production')
      .nodeVersion('22')
      .pkgManager('pnpm', { installCommand: 'pnpm install --frozen-lockfile' })
      .buildDir('build')
      .appRoot('apps/backend')
      .database({ type: 'postgres', host: 'localhost', port: 5432, name: 'db', user: 'u', password: 'p' })
      .redis({ host: 'localhost', port: 6379, password: 'rp' })
      .backup({ s3Bucket: 'backups', s3Prefix: 'prod', schedule: 'daily', retentionDays: 30 })
      .cloudflare({ zone: 'example.com', appHostname: 'api.example.com', tunnelName: 't', lockdownFirewall: true })
      .preDeploy(preDeploy)
      .postDeploy(postDeploy)
      .aliases({ migrate: 'pnpm db:apply', seed: 'pnpm db:seed' })
      .build();

    expect(config.apps[0].appType).toBe('backend');
    expect(config.ssh).toEqual({ host: '192.168.1.1', user: 'deploy', port: 2222, identityFile: '/k/id' });
    expect(config.remotePath).toBe('/var/www/myapp');
    expect(config.apps[0].pm2?.apps).toHaveLength(2);
    expect(config.apps[0].pm2?.apps[0]).toMatchObject({ name: 'myapp', port: 3333, instances: 2, maxMemory: '1G' });
    expect(config.apps[0].pm2?.apps[1]).toMatchObject({ name: 'mailer', command: 'node dist/mailer.js', instances: 1, maxMemory: '512M', env: { Q: 'mail' } });
    expect(config.apps[0].domain).toBe('api.example.com');
    expect(config.apps[0].keepReleases).toBe(10);
    expect(config.apps[0].sharedDirs).toEqual(['storage', 'uploads']);
    expect(config.apps[0].sharedFiles).toEqual(['.htpasswd']);
    expect(config.apps[0].healthCheck).toEqual({ enabled: true, path: '/healthz', timeout: 60, retries: 5, startupDelay: 10 });
    expect(config.apps[0].envFile).toBe('.env.production');
    expect(config.nodeVersion).toBe('22');
    expect(config.pkgManager).toBe('pnpm');
    expect(config.installCommand).toBe('pnpm install --frozen-lockfile');
    expect(config.apps[0].buildDir).toBe('build');
    expect(config.apps[0].appRoot).toBe('apps/backend');
    expect(config.database).toMatchObject({ type: 'postgres', host: 'localhost', port: 5432, name: 'db', user: 'u', password: 'p' });
    expect(config.redis).toEqual({ host: 'localhost', port: 6379, password: 'rp' });
    expect(config.backup).toMatchObject({ s3Bucket: 'backups', s3Prefix: 'prod', schedule: 'daily', retentionDays: 30 });
    expect(config.cloudflare).toMatchObject({ zone: 'example.com', appHostname: 'api.example.com', tunnelName: 't', lockdownFirewall: true });
    expect(config.apps[0].hooks?.preDeploy).toBe(preDeploy);
    expect(config.apps[0].hooks?.postDeploy).toBe(postDeploy);
    expect(config.aliases).toEqual({ migrate: 'pnpm db:apply', seed: 'pnpm db:seed' });
  });


  it('builds a minimal backend config', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '192.168.1.1', user: 'deploy' })
      .deployTo('/var/www/myapp')
      .pm2('myapp')
      .build();

    expect(config.apps[0].appType).toBe('backend');
    expect(config.ssh.host).toBe('192.168.1.1');
    expect(config.ssh.user).toBe('deploy');
    expect(config.ssh.port).toBe(22);
    expect(config.remotePath).toBe('/var/www/myapp');
    expect(config.apps[0].pm2?.apps[0].name).toBe('myapp');
    expect(config.apps[0].keepReleases).toBe(5);
    expect(config.apps[0].healthCheck.enabled).toBe(true);
    expect(config.apps[0].envFile).toBe('.env');
    expect(config.nodeVersion).toBe('lts');
  });

  it('builds a frontend config', () => {
    const config = new ShipnodeBuilder()
      .frontend()
      .ssh({ host: 'example.com', user: 'deploy' })
      .deployTo('/var/www/frontend')
      .build();

    expect(config.apps[0].appType).toBe('frontend');
    expect(config.ssh.host).toBe('example.com');
  });

  it('overrides defaults', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '10.0.0.1', user: 'admin', port: 2222 })
      .deployTo('/opt/app')
      .pm2('my-api', { instances: 4, maxMemory: '1G' })
      .port(8080)
      .domain('api.example.com')
      .keepReleases(10)
      .healthCheck('/api/health', { timeout: 60, retries: 5 })
      .envFile('.env.production')
      .nodeVersion('22')
      .pkgManager('pnpm')
      .build();

    expect(config.ssh.port).toBe(2222);
    expect(config.remotePath).toBe('/opt/app');
    expect(config.apps[0].pm2?.apps[0].instances).toBe(4);
    expect(config.apps[0].pm2?.apps[0].maxMemory).toBe('1G');
    expect(config.apps[0].pm2?.apps[0].port).toBe(8080);
    expect(config.apps[0].domain).toBe('api.example.com');
    expect(config.apps[0].keepReleases).toBe(10);
    expect(config.apps[0].healthCheck.path).toBe('/api/health');
    expect(config.apps[0].healthCheck.timeout).toBe(60);
    expect(config.apps[0].healthCheck.retries).toBe(5);
    expect(config.apps[0].envFile).toBe('.env.production');
    expect(config.nodeVersion).toBe('22');
    expect(config.pkgManager).toBe('pnpm');
  });

  it('disables health check', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .noHealthCheck()
      .build();

    expect(config.apps[0].healthCheck.enabled).toBe(false);
  });

  it('sets shared dirs and files', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .sharedDirs(['uploads', 'logs'])
      .sharedFiles(['config.json'])
      .build();

    expect(config.apps[0].sharedDirs).toEqual(['uploads', 'logs']);
    expect(config.apps[0].sharedFiles).toEqual(['config.json']);
  });

  it('sets database config', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .database({
        type: 'postgres',
        host: 'db.internal',
        port: 5432,
        name: 'myapp_prod',
        user: 'myapp',
        password: 'secret',
      })
      .build();

    expect(config.database?.type).toBe('postgres');
    expect(config.database?.host).toBe('db.internal');
    expect(config.database?.port).toBe(5432);
    expect(config.database?.password).toBe('secret');
  });

  it('enables cloudflare access', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .cloudflareAccess()
      .build();

    expect(config.ssh.proxyMode).toBe('cloudflare');
  });

  it('enables cloudflare access with custom command', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .cloudflareAccess('custom-proxy --hostname %h')
      .build();

    expect(config.ssh.proxyMode).toBe('cloudflare');
    expect(config.ssh.proxyCommand).toBe('custom-proxy --hostname %h');
  });

  it('sets hooks', () => {
    const preDeploy = vi.fn();
    const postDeploy = vi.fn();

    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .preDeploy(preDeploy)
      .postDeploy(postDeploy)
      .build();

    expect(typeof config.apps[0].hooks?.preDeploy).toBe('function');
    expect(typeof config.apps[0].hooks?.postDeploy).toBe('function');
  });

  it('order of chaining does not matter', () => {
    const configA = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .port(3000)
      .build();

    const configB = new ShipnodeBuilder()
      .port(3000)
      .deployTo('/var/www/app')
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .backend()
      .build();

    expect(configA.app).toBe(configB.app);
    expect(configA.ssh.host).toBe(configB.ssh.host);
    expect(configA.remotePath).toBe(configB.remotePath);
    expect(configA.pm2?.apps[0].port).toBe(configB.pm2?.apps[0].port);
  });

  it('throws on missing required fields', () => {
    expect(() => {
      new ShipnodeBuilder().build();
    }).toThrow();
  });

  it('throws on invalid SSH host', () => {
    expect(() => {
      new ShipnodeBuilder()
        .backend()
        .ssh({ host: 'invalid host with spaces!', user: 'deploy' })
        .deployTo('/var/www/app')
        .build();
    }).toThrow();
  });

  it('throws on invalid port', () => {
    expect(() => {
      new ShipnodeBuilder()
        .backend()
        .ssh({ host: '1.2.3.4', user: 'deploy' })
        .deployTo('/var/www/app')
        .port(99999)
        .build();
    }).toThrow();
  });

  it('accepts installCommand via .pkgManager(pm, opts)', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .pkgManager('pnpm', { installCommand: 'pnpm install --frozen-lockfile' })
      .build();

    expect(config.pkgManager).toBe('pnpm');
    expect(config.installCommand).toBe('pnpm install --frozen-lockfile');
  });

  it('.installCommand(cmd) and .pkgManager(pm, { installCommand }) end up at the same place', () => {
    const a = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .pkgManager('npm')
      .installCommand('npm ci --legacy-peer-deps')
      .build();

    const b = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .pkgManager('npm', { installCommand: 'npm ci --legacy-peer-deps' })
      .build();

    expect(a.installCommand).toBe(b.installCommand);
    expect(a.pkgManager).toBe(b.pkgManager);
  });

  it('sets appRoot for monorepo env-file discovery', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .appRoot('apps/backend')
      .build();

    expect(config.apps[0].appRoot).toBe('apps/backend');
  });

  it('sets backup config', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .backup({ s3Bucket: 'my-bucket', schedule: 'daily', retentionDays: 7 })
      .build();

    expect(config.backup?.s3Bucket).toBe('my-bucket');
    expect(config.backup?.schedule).toBe('daily');
    expect(config.backup?.retentionDays).toBe(7);
  });

  it('sets cloudflare config', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .cloudflare({ zone: 'example.com', appHostname: 'app.example.com', lockdownFirewall: true })
      .build();

    expect(config.cloudflare?.zone).toBe('example.com');
    expect(config.cloudflare?.appHostname).toBe('app.example.com');
    expect(config.cloudflare?.lockdownFirewall).toBe(true);
  });
});

describe('ShipnodeAppBuilder + workspace .apps([])', () => {
  it('shipnode.app() and the standalone app() factory both produce a ShipnodeAppBuilder', () => {
    expect(shipnode.app()).toBeInstanceOf(ShipnodeAppBuilder);
    expect(app()).toBeInstanceOf(ShipnodeAppBuilder);
  });

  it('composes a multi-app workspace via .apps([api, web])', () => {
    const api = app()
      .backend()
      .name('api')
      .appRoot('apps/backend')
      .domain('api.example.com')
      .pm2('api')
      .port(3333)
      .envFile('.env.production')
      .postDeploy(vi.fn());

    const web = app()
      .backend()
      .name('web')
      .appRoot('apps/frontend')
      .domain('example.com')
      .pm2('web')
      .port(3000);

    const config = new ShipnodeBuilder()
      .ssh({ host: '1.2.3.4', user: 'root' })
      .deployTo('/var/www/example')
      .nodeVersion('24')
      .apps([api, web])
      .build();

    expect(config.apps).toHaveLength(2);
    expect(config.apps[0]).toMatchObject({
      name: 'api',
      appType: 'backend',
      appRoot: 'apps/backend',
      domain: 'api.example.com',
      envFile: '.env.production',
    });
    expect(config.apps[0].pm2?.apps[0]).toMatchObject({ name: 'api', port: 3333 });
    expect(config.apps[1]).toMatchObject({
      name: 'web',
      appType: 'backend',
      appRoot: 'apps/frontend',
      domain: 'example.com',
    });
    expect(config.apps[1].pm2?.apps[0]).toMatchObject({ name: 'web', port: 3000 });
    // Legacy top-level mirrors point to apps[0]
    expect(config.apps[0].domain).toBe('api.example.com');
    expect(config.apps[0].appRoot).toBe('apps/backend');
  });

  it('app builder collects workers alongside the web app', () => {
    const api = app()
      .backend()
      .name('api')
      .pm2('api')
      .port(3333)
      .worker({ name: 'mailer', command: 'node dist/mailer.js' })
      .worker({ name: 'queue', command: 'node dist/queue.js' });

    const config = new ShipnodeBuilder()
      .ssh({ host: '1.2.3.4', user: 'root' })
      .deployTo('/var/www/app')
      .apps([api])
      .build();

    expect(config.apps[0].pm2?.apps).toHaveLength(3);
    expect(config.apps[0].pm2?.apps.map((a) => a.name)).toEqual(['api', 'mailer', 'queue']);
  });

  it('frontend app cannot declare pm2 (refine on ShipnodeAppSchema)', () => {
    const bad = app()
      .frontend()
      .name('web')
      .pm2('web')
      .port(3000);

    expect(() => new ShipnodeBuilder()
      .ssh({ host: '1.2.3.4', user: 'root' })
      .deployTo('/var/www/app')
      .apps([bad])
      .build()).toThrow();
  });
});
