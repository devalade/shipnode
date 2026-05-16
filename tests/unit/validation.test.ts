import { describe, it, expect } from 'vitest';
import { isValidIpOrHostname, isValidPort, isValidDomain, isValidPm2Name } from '../../src/domain/validation/ip.js';

describe('isValidIpOrHostname', () => {
  it('accepts valid IPv4 addresses', () => {
    expect(isValidIpOrHostname('192.168.1.1')).toBe(true);
    expect(isValidIpOrHostname('10.0.0.1')).toBe(true);
    expect(isValidIpOrHostname('0.0.0.0')).toBe(true);
    expect(isValidIpOrHostname('255.255.255.255')).toBe(true);
  });

  it('rejects invalid IPv4 addresses', () => {
    expect(isValidIpOrHostname('999.999.999.999')).toBe(false);
    expect(isValidIpOrHostname('256.1.1.1')).toBe(false);
  });

  it('accepts valid hostnames', () => {
    expect(isValidIpOrHostname('example.com')).toBe(true);
    expect(isValidIpOrHostname('sub.example.com')).toBe(true);
    expect(isValidIpOrHostname('my-server')).toBe(true);
    expect(isValidIpOrHostname('a.b.c.d.example.com')).toBe(true);
  });

  it('rejects invalid hostnames', () => {
    expect(isValidIpOrHostname('-example.com')).toBe(false);
    expect(isValidIpOrHostname('example-.com')).toBe(false);
    expect(isValidIpOrHostname('example..com')).toBe(false);
    expect(isValidIpOrHostname('1.2.3')).toBe(false);
    expect(isValidIpOrHostname('')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(isValidIpOrHostname('')).toBe(false);
  });
});

describe('isValidPort', () => {
  it('accepts valid ports', () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(22)).toBe(true);
    expect(isValidPort(80)).toBe(true);
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(3000)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it('rejects invalid ports', () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(3.14)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
  });
});

describe('isValidDomain', () => {
  it('accepts valid domains', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('api.example.com')).toBe(true);
    expect(isValidDomain('my-app.io')).toBe(true);
  });

  it('accepts empty string', () => {
    expect(isValidDomain('')).toBe(true);
  });

  it('rejects domains with protocol', () => {
    expect(isValidDomain('http://example.com')).toBe(false);
    expect(isValidDomain('https://example.com')).toBe(false);
  });

  it('rejects invalid domains', () => {
    expect(isValidDomain('-example.com')).toBe(false);
    expect(isValidDomain('example..com')).toBe(false);
  });
});

describe('isValidPm2Name', () => {
  it('accepts valid names', () => {
    expect(isValidPm2Name('myapp')).toBe(true);
    expect(isValidPm2Name('my-app')).toBe(true);
    expect(isValidPm2Name('my_app')).toBe(true);
    expect(isValidPm2Name('MyApp123')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidPm2Name('')).toBe(false);
    expect(isValidPm2Name('my app')).toBe(false);
    expect(isValidPm2Name('my.app')).toBe(false);
    expect(isValidPm2Name('a'.repeat(65))).toBe(false);
  });
});
