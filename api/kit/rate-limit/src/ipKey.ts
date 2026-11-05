import { isIP } from 'node:net';
import type { Request } from 'express';

/** "ip:203.0.113.7"; IPv6 grouped by /64 as "ip:2001:db8:0:1"; IPv4-mapped (dotted or hex) as IPv4;
 *  zone id stripped; missing req.ip gives "ip:unknown". */
export function ipKey(req: Request): string {
  const raw = req.ip;
  if (raw === undefined || raw.length === 0) return 'ip:unknown';
  const zoneAt = raw.indexOf('%');
  const address = zoneAt === -1 ? raw : raw.slice(0, zoneAt);
  const version = isIP(address);
  if (version === 4) return `ip:${address}`;
  if (version !== 6) return 'ip:unknown';
  const prefix = ipv6Prefix(address);
  return prefix === undefined ? 'ip:unknown' : `ip:${prefix}`;
}

/** First four hextets, or the embedded IPv4 for a ::ffff: address. */
function ipv6Prefix(ip: string): string | undefined {
  let address = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (dotted !== null) {
    const octets = [dotted[1], dotted[2], dotted[3], dotted[4]].map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    const a = octets[0];
    const b = octets[1];
    const c = octets[2];
    const d = octets[3];
    if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
    address = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ?? '';
  const tail = halves[1];
  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail !== undefined && tail.length > 0 ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return undefined;
  const hextets = [...headParts, ...new Array<string>(missing).fill('0'), ...tailParts].map((part) => parseInt(part, 16));
  if (hextets.length !== 8 || hextets.some((part) => Number.isNaN(part) || part < 0 || part > 0xffff)) return undefined;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  if (h0 === undefined || h1 === undefined || h2 === undefined || h3 === undefined || h4 === undefined || h5 === undefined || h6 === undefined || h7 === undefined) {
    return undefined;
  }
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return [h6 >> 8, h6 & 255, h7 >> 8, h7 & 255].join('.');
  }
  return [h0, h1, h2, h3].map((part) => part.toString(16)).join(':');
}
