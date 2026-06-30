const CF_API = 'https://api.cloudflare.com/client/v4';

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
      throw new Error(`Cloudflare API error: ${msg}`);
    }
    return json.result;
  }

  async getZoneId(zone: string): Promise<string> {
    const zones = await this.fetch<{ id: string }[]>(`/zones?name=${zone}`);
    if (!zones.length) throw new Error(`Zone "${zone}" not found`);
    return zones[0].id;
  }

  async getDnsRecords(zoneId: string, hostname: string): Promise<{ type: string; content: string }[]> {
    return this.fetch(`/zones/${zoneId}/dns_records?name=${hostname}`);
  }

  async getCloudflareIps(): Promise<{ ipv4_cidrs: string[]; ipv6_cidrs: string[] }> {
    return this.fetch('/ips');
  }

  async verifyToken(): Promise<void> {
    await this.fetch('/accounts');
  }
}
