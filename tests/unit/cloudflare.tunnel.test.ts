import { describe, it, expect } from 'vitest';
import { Tunnel } from '../../src/domain/cloudflare/tunnel.js';

const sampleYaml = `tunnel: abc123
credentials-file: /root/.cloudflared/abc123.json

ingress:
  - hostname: api.example.com
    service: http://localhost:3000
  - hostname: ssh.example.com
    service: ssh://localhost:22
  - service: http_status:404
`;

describe('Tunnel', () => {
  it('round-trips YAML', () => {
    const tunnel = Tunnel.fromYaml(sampleYaml);
    expect(tunnel.id).toBe('abc123');
    expect(tunnel.credentialsPath).toBe('/root/.cloudflared/abc123.json');
    expect(tunnel.ingress).toHaveLength(2);
    expect(tunnel.ingress[0]).toEqual({ hostname: 'api.example.com', service: 'http://localhost:3000' });
    expect(tunnel.ingress[1]).toEqual({ hostname: 'ssh.example.com', service: 'ssh://localhost:22' });
    expect(tunnel.catchAll).toBe('http_status:404');

    const output = tunnel.toYaml();
    expect(output).toBe(sampleYaml);
  });

  it('adds an ingress entry', () => {
    const tunnel = Tunnel.fromYaml(sampleYaml);
    tunnel.addIngress('admin.example.com', 'http://localhost:4000');
    expect(tunnel.ingress).toHaveLength(3);
  });

  it('replaces an existing ingress entry by hostname', () => {
    const tunnel = Tunnel.fromYaml(sampleYaml);
    tunnel.addIngress('api.example.com', 'http://localhost:5000');
    expect(tunnel.ingress).toHaveLength(2);
    const api = tunnel.ingress.find((i) => i.hostname === 'api.example.com');
    expect(api?.service).toBe('http://localhost:5000');
  });

  it('skips addIngress when hostname is empty', () => {
    const tunnel = Tunnel.fromYaml(sampleYaml);
    tunnel.addIngress(undefined, 'http://localhost:4000');
    expect(tunnel.ingress).toHaveLength(2);
  });

  it('removes an ingress entry', () => {
    const tunnel = Tunnel.fromYaml(sampleYaml);
    tunnel.removeIngress('ssh.example.com');
    expect(tunnel.ingress).toHaveLength(1);
    expect(tunnel.ingress[0].hostname).toBe('api.example.com');
  });

  it('sorts ingress entries by hostname', () => {
    const tunnel = new Tunnel('test', 'abc', '/creds');
    tunnel.addIngress('z.example.com', 'http://localhost:3000');
    tunnel.addIngress('a.example.com', 'http://localhost:4000');
    tunnel.addIngress('m.example.com', 'http://localhost:5000');

    const yaml = tunnel.toYaml();
    const lines = yaml.split('\n');
    const hostnameLines = lines.filter((l) => l.startsWith('  - hostname:'));
    expect(hostnameLines[0]).toContain('a.example.com');
    expect(hostnameLines[1]).toContain('m.example.com');
    expect(hostnameLines[2]).toContain('z.example.com');
  });

  it('serializes without id or credentials', () => {
    const tunnel = new Tunnel('test');
    tunnel.addIngress('app.example.com', 'http://localhost:8080');

    const yaml = tunnel.toYaml();
    expect(yaml).not.toContain('tunnel:');
    expect(yaml).not.toContain('credentials-file:');
    expect(yaml).toContain('app.example.com');
    expect(yaml).toContain('http_status:404');
  });
});
