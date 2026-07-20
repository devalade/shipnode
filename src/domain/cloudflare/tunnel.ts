import { Ingress, type IngressOriginRequest } from './ingress.js';

export class Tunnel {
  constructor(
    public name: string,
    public id?: string,
    public credentialsPath?: string,
    public ingress: Ingress[] = [],
    public catchAll: string = 'http_status:404',
  ) {}

  addIngress(
    hostname: string | undefined,
    service: string,
    originRequest?: IngressOriginRequest,
  ): void {
    if (!hostname) return;
    const existing = this.ingress.findIndex(
      (e) => e.hostname === hostname,
    );
    const entry: Ingress = { hostname, service };
    if (originRequest) entry.originRequest = originRequest;
    if (existing !== -1) {
      this.ingress[existing] = entry;
    } else {
      this.ingress.push(entry);
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
        if (entry.originRequest) {
          lines.push(`    originRequest:`);
          if (entry.originRequest.noTLSVerify) {
            lines.push(`      noTLSVerify: true`);
          }
          if (entry.originRequest.originServerName) {
            lines.push(`      originServerName: ${entry.originRequest.originServerName}`);
          }
          if (entry.originRequest.httpHostHeader) {
            lines.push(`      httpHostHeader: ${entry.originRequest.httpHostHeader}`);
          }
        }
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
    let inOriginRequest = false;

    for (const raw of lines) {
      const line = raw.trimEnd();
      const trimmed = line.trimStart();
      if (line.startsWith('tunnel: ')) {
        tunnel.id = line.slice('tunnel: '.length);
        inOriginRequest = false;
      } else if (line.startsWith('credentials-file: ')) {
        tunnel.credentialsPath = line.slice('credentials-file: '.length);
        inOriginRequest = false;
      } else if (trimmed === 'ingress:') {
        inIngress = true;
        inOriginRequest = false;
      } else if (inIngress && trimmed.startsWith('- hostname: ')) {
        inOriginRequest = false;
        const hostname = trimmed.slice('- hostname: '.length);
        tunnel.ingress.push({ hostname, service: '' });
      } else if (inIngress && trimmed === 'originRequest:') {
        inOriginRequest = true;
        const last = tunnel.ingress[tunnel.ingress.length - 1];
        if (last) last.originRequest = {};
      } else if (inIngress && inOriginRequest && trimmed.startsWith('noTLSVerify:')) {
        const last = tunnel.ingress[tunnel.ingress.length - 1];
        if (last?.originRequest) {
          last.originRequest.noTLSVerify = trimmed.includes('true');
        }
      } else if (inIngress && inOriginRequest && trimmed.startsWith('originServerName: ')) {
        const last = tunnel.ingress[tunnel.ingress.length - 1];
        if (last?.originRequest) {
          last.originRequest.originServerName = trimmed.slice('originServerName: '.length);
        }
      } else if (inIngress && inOriginRequest && trimmed.startsWith('httpHostHeader: ')) {
        const last = tunnel.ingress[tunnel.ingress.length - 1];
        if (last?.originRequest) {
          last.originRequest.httpHostHeader = trimmed.slice('httpHostHeader: '.length);
        }
      } else if (inIngress && trimmed.startsWith('service: ') && tunnel.ingress.length > 0) {
        inOriginRequest = false;
        const last = tunnel.ingress[tunnel.ingress.length - 1];
        if (last.service === '') {
          last.service = trimmed.slice('service: '.length);
        }
      } else if (inIngress && trimmed.startsWith('- service: ')) {
        inOriginRequest = false;
        tunnel.catchAll = trimmed.slice('- service: '.length);
      }
    }

    return tunnel;
  }
}
