const CF_API = 'https://api.cloudflare.com/client/v4';

export interface CfTunnel {
  id: string;
  name: string;
  account_tag: string;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

export class CloudflareApi {
  constructor(private apiToken: string) {}

  async fetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${CF_API}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> ?? {}),
      },
    });
    const json = await res.json() as { success: boolean; errors?: { message: string }[]; result: T };
    if (!json.success) {
      const msg = json.errors?.map((e) => e.message).join(', ') ?? 'Unknown error';
      throw new Error(`Cloudflare API error (${path}): ${msg}`);
    }
    return json.result;
  }

  async getZoneId(zone: string): Promise<string> {
    const zones = await this.fetch<{ id: string }[]>(`/zones?name=${zone}`);
    if (!zones.length) throw new Error(`Zone "${zone}" not found`);
    return zones[0].id;
  }

  /**
   * Returns the first account the token has access to. Tokens created for a
   * specific account only see that account, which is the intended usage.
   */
  async getAccountId(): Promise<string> {
    const accounts = await this.fetch<{ id: string; name: string }[]>('/accounts');
    if (!accounts.length) throw new Error('Token has no account access — check its scope');
    return accounts[0].id;
  }

  async findTunnel(accountId: string, name: string): Promise<CfTunnel | null> {
    const tunnels = await this.fetch<CfTunnel[]>(
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    return tunnels.find((t) => t.name === name) ?? null;
  }

  /**
   * Creates a tunnel with a caller-supplied secret so we can construct the
   * credentials file locally (Cloudflare only echoes the secret back in the
   * POST response; there's no way to re-fetch it later). config_src=local
   * means cloudflared reads /etc/cloudflared/config.yml on the host — the
   * config-file model shipnode has always used.
   */
  async createTunnel(accountId: string, name: string, secretBase64: string): Promise<CfTunnel> {
    return this.fetch<CfTunnel>(`/accounts/${accountId}/cfd_tunnel`, {
      method: 'POST',
      body: JSON.stringify({ name, tunnel_secret: secretBase64, config_src: 'local' }),
    });
  }

  async getDnsRecords(zoneId: string, hostname: string): Promise<CfDnsRecord[]> {
    return this.fetch<CfDnsRecord[]>(`/zones/${zoneId}/dns_records?name=${hostname}`);
  }

  async createDnsRecord(zoneId: string, record: { type: string; name: string; content: string; proxied?: boolean }): Promise<CfDnsRecord> {
    return this.fetch<CfDnsRecord>(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ ...record, ttl: 1 }),
    });
  }

  async updateDnsRecord(zoneId: string, recordId: string, record: { type: string; name: string; content: string; proxied?: boolean }): Promise<CfDnsRecord> {
    return this.fetch<CfDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...record, ttl: 1 }),
    });
  }

  /**
   * Idempotent: creates a record if none exists for the hostname, or updates
   * the existing one to point at `content`. Returns the resulting record.
   */
  async upsertDnsRecord(zoneId: string, record: { type: string; name: string; content: string; proxied?: boolean }): Promise<CfDnsRecord> {
    const existing = await this.getDnsRecords(zoneId, record.name);
    if (existing.length === 0) return this.createDnsRecord(zoneId, record);
    return this.updateDnsRecord(zoneId, existing[0].id, record);
  }

  async getCloudflareIps(): Promise<{ ipv4_cidrs: string[]; ipv6_cidrs: string[] }> {
    return this.fetch('/ips');
  }

  async verifyToken(): Promise<void> {
    await this.fetch('/accounts');
  }
}
