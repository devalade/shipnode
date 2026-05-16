const IPV4_REGEX = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
const HOSTNAME_LABEL_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export function isValidIpOrHostname(input: string): boolean {
  if (!input) return false;

  if (IPV4_REGEX.test(input)) {
    const octets = input.split('.').map(Number);
    return octets.every((o) => o >= 0 && o <= 255);
  }

  const labels = input.split('.');
  if (labels.length < 1) return false;
  if (!labels.every((label) => HOSTNAME_LABEL_REGEX.test(label))) return false;

  const hasLetter = labels.some((label) => /[a-zA-Z]/.test(label));
  return hasLetter;
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isValidDomain(domain: string): boolean {
  if (!domain) return true;
  if (/^https?:\/\//.test(domain)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => HOSTNAME_LABEL_REGEX.test(label));
}

export function isValidPm2Name(name: string): boolean {
  if (!name) return false;
  if (name.length > 64) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
