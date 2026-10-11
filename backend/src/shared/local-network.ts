/**
 * Model endpoints may use loopback or an address on a private local network.
 * Host names are limited to localhost so public DNS names cannot bypass this
 * policy through DNS resolution or rebinding.
 */
export function isAllowedLocalModelHost(input: string): boolean {
  let host = input.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost") return true;

  const octets = host.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const values = octets.map(Number);
    if (values.some((part, index) => part > 255 || String(part) !== octets[index])) return false;
    const [a, b] = values;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }

  if (!host.includes(":")) return false;
  try {
    const parsed = new URL(`http://[${host}]/`);
    const normalized = parsed.hostname.slice(1, -1).toLowerCase();
    if (normalized === "::1") return true;
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
    return /^(fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized);
  } catch {
    return false;
  }
}

export function isAllowedLocalModelEndpoint(input: string): boolean {
  try {
    const endpoint = new URL(input);
    return (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      endpoint.username === "" && endpoint.password === "" &&
      isAllowedLocalModelHost(endpoint.hostname);
  } catch {
    return false;
  }
}
