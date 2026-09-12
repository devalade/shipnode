import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudflareApi } from '../../src/infrastructure/cloudflare/api.js';

type CfCall = { url: string; init?: RequestInit };

/**
 * Stubs the Cloudflare API. `records` is what GET /dns_records returns for
 * any hostname; every call is recorded so the test can assert which endpoint
 * and method the code chose.
 */
function stubApi(records: Array<{ id: string; type: string; name: string; content: string }>) {
  const calls: CfCall[] = [];

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });

    const isRead = !init?.method || init.method === 'GET';
    const result = isRead && url.includes('/dns_records') ? records : { id: 'written' };

    return {
      json: async () => ({ success: true, result }),
    } as Response;
  });

  return { api: new CloudflareApi('test-token'), calls };
}

describe('CloudflareApi.upsertDnsRecord', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a CNAME when the hostname only has records of other types', async () => {
    // An apex with Cloudflare Email Routing: MX and TXT, but no CNAME.
    const { api, calls } = stubApi([
      { id: 'mx-1', type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net' },
      { id: 'txt-1', type: 'TXT', name: 'example.com', content: 'v=spf1 -all' },
    ]);

    await api.upsertDnsRecord('zone-1', {
      type: 'CNAME',
      name: 'example.com',
      content: 'tunnel-id.cfargotunnel.com',
      proxied: true,
    });

    const write = calls.find((c) => c.init?.method && c.init.method !== 'GET');
    expect(write?.init?.method).toBe('POST');
    // Rewriting the MX record is what Cloudflare rejects with
    // "This record is managed by Email Routing".
    expect(write?.url).not.toContain('mx-1');
    expect(write?.url).not.toContain('txt-1');
  });

  it('updates the existing record of the same type', async () => {
    const { api, calls } = stubApi([
      { id: 'mx-1', type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net' },
      { id: 'cname-1', type: 'CNAME', name: 'example.com', content: 'old-tunnel.cfargotunnel.com' },
    ]);

    await api.upsertDnsRecord('zone-1', {
      type: 'CNAME',
      name: 'example.com',
      content: 'new-tunnel.cfargotunnel.com',
      proxied: true,
    });

    const write = calls.find((c) => c.init?.method && c.init.method !== 'GET');
    expect(write?.init?.method).toBe('PUT');
    expect(write?.url).toContain('cname-1');
  });
});
