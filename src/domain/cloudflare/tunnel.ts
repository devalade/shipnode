import { Ingress } from './ingress.js';

export class Tunnel {
  constructor(
    public name: string,
    public id?: string,
    public credentialsPath?: string,
    public ingress: Ingress[] = [],
    public catchAll: string = 'http_status:404',
  ) {}

  addIngress(hostname: string | undefined, service: string): void {
    if (!hostname) return;
    const existing = this.ingress.findIndex(
      (e) => e.hostname === hostname,
    );
    if (existing !== -1) {
      this.ingress[existing].service = service;
    } else {
      this.ingress.push({ hostname, service });
    }
  }

  removeIngress(hostname: string): void {
    this.ingress = this.ingress.filter((e) => e.hostname !== hostname);
  }

  toYaml(): string {
    const lines: string[] = [];
    if (this.id) {
      lines.push(`tunnel: ${this.id}`);
    }
    if (this.credentialsPath) {
      lines.push(`credentials-file: ${this.credentialsPath}`);
    }
    lines.push('');
    lines.push('ingress:');

    const sorted = [...this.ingress].sort((a, b) => {
      const ha = a.hostname ?? '';
      const hb = b.hostname ?? '';
      return ha.localeCompare(hb);
    });

    for (const entry of sorted) {
      if (entry.hostname) {
        lines.push(`  - hostname: ${entry.hostname}`);
        lines.push(`    service: ${entry.service}`);
      }
    }
    lines.push(`  - service: ${this.catchAll}`);
    lines.push('');

    return lines.join('\n');
  }

  static fromYaml(content: string): Tunnel {
    const tunnel = new Tunnel('');
    const lines = content.split('\n');

    let inIngress = false;

    for (const raw of lines) {
      const line = raw.trimEnd();
      const trimmed = line.trimStart();
      if (line.startsWith('tunnel: ')) {
        tunnel.id = line.slice('tunnel: '.length);
      } else if (line.startsWith('credentials-file: ')) {
        tunnel.credentialsPath = line.slice('credentials-file: '.length);
      } else if (trimmed === 'ingress:') {
        inIngress = true;
      } else if (inIngress && trimmed.startsWith('- hostname: ')) {
        const hostname = trimmed.slice('- hostname: '.length);
        tunnel.ingress.push({ hostname, service: '' });
      } else if (inIngress && trimmed.startsWith('service: ') && tunnel.ingress.length > 0) {
        const last = tunnel.ingress[tunnel.ingress.length - 1];
        if (last.service === '') {
          last.service = trimmed.slice('service: '.length);
        }
      } else if (inIngress && trimmed.startsWith('- service: ')) {
        tunnel.catchAll = trimmed.slice('- service: '.length);
      }
    }

    return tunnel;
  }
}
