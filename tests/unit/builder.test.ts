import { describe, it, expect, vi } from 'vitest';
import { shipnode, ShipnodeBuilder } from '../../src/config/builder.js';

describe('ShipnodeBuilder', () => {
  it('builds a minimal backend config', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '192.168.1.1', user: 'deploy' })
      .deployTo('/var/www/myapp')
      .pm2('myapp')
      .build();

    expect(config.app).toBe('backend');
    expect(config.ssh.host).toBe('192.168.1.1');
    expect(config.ssh.user).toBe('deploy');
    expect(config.ssh.port).toBe(22);
    expect(config.remotePath).toBe('/var/www/myapp');
    expect(config.pm2?.name).toBe('myapp');
    expect(config.zeroDowntime).toBe(true);
    expect(config.keepReleases).toBe(5);
    expect(config.healthCheck.enabled).toBe(true);
    expect(config.envFile).toBe('.env');
    expect(config.nodeVersion).toBe('lts');
  });

  it('builds a frontend config', () => {
    const config = new ShipnodeBuilder()
      .frontend()
      .ssh({ host: 'example.com', user: 'deploy' })
      .deployTo('/var/www/frontend')
      .build();

    expect(config.app).toBe('frontend');
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
      .zeroDowntime({ keepReleases: 10 })
      .healthCheck('/api/health', { timeout: 60, retries: 5 })
      .envFile('.env.production')
      .nodeVersion('22')
      .pkgManager('pnpm')
      .build();

    expect(config.ssh.port).toBe(2222);
    expect(config.remotePath).toBe('/opt/app');
    expect(config.pm2?.instances).toBe(4);
    expect(config.pm2?.maxMemory).toBe('1G');
    expect(config.backend?.port).toBe(8080);
    expect(config.domain).toBe('api.example.com');
    expect(config.keepReleases).toBe(10);
    expect(config.healthCheck.path).toBe('/api/health');
    expect(config.healthCheck.timeout).toBe(60);
    expect(config.healthCheck.retries).toBe(5);
    expect(config.envFile).toBe('.env.production');
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

    expect(config.healthCheck.enabled).toBe(false);
  });

  it('sets legacy mode', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .legacy()
      .build();

    expect(config.zeroDowntime).toBe(false);
  });

  it('sets shared dirs and files', () => {
    const config = new ShipnodeBuilder()
      .backend()
      .ssh({ host: '1.2.3.4', user: 'deploy' })
      .deployTo('/var/www/app')
      .sharedDirs(['uploads', 'logs'])
      .sharedFiles(['config.json'])
      .build();

    expect(config.sharedDirs).toEqual(['uploads', 'logs']);
    expect(config.sharedFiles).toEqual(['config.json']);
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

    expect(typeof config.hooks?.preDeploy).toBe('function');
    expect(typeof config.hooks?.postDeploy).toBe('function');
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
    expect(configA.backend?.port).toBe(configB.backend?.port);
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
