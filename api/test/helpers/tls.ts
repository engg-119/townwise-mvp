// A self-signed certificate for a local HTTPS test server, made with node:crypto alone (no dependency, no key on disk):
// an ECDSA P-256 key and an X.509 v3 certificate, written in DER by hand, that names the given hosts in its
// subjectAltName and is good from an hour ago to a day from now. A client trusts it by passing `cert` as its `ca`, and
// then checks each host against it as for any certificate.
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

export interface TestCertificate {
  /** PKCS #8 PEM, for the server. */
  readonly key: string;
  /** PEM, for the server, and for the client as its only trusted CA. */
  readonly cert: string;
}

/** One DER value: its tag, its length (short or long form) and its contents. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const contents = Buffer.concat(parts);
  const size: number[] = [];
  for (let rest = contents.length; rest > 0; rest = Math.floor(rest / 256)) size.unshift(rest % 256);
  const length = contents.length < 0x80 ? [contents.length] : [0x80 | size.length, ...size];
  return Buffer.concat([Buffer.from([tag, ...length]), contents]);
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
/** AlgorithmIdentifier for ecdsa-with-SHA256 (1.2.840.10045.4.3.2), with no parameters. */
const ECDSA_WITH_SHA256 = sequence(Buffer.from('06082a8648ce3d040302', 'hex'));
/** The commonName (2.5.4.3) and subjectAltName (2.5.29.17) OIDs, encoded. */
const COMMON_NAME = Buffer.from('0603550403', 'hex');
const SUBJECT_ALT_NAME = Buffer.from('0603551d11', 'hex');

/** UTCTime, YYMMDDHHMMSSZ. */
function utcTime(at: Date): Buffer {
  return der(0x17, Buffer.from(`${at.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
}

export function selfSignedCertificate(hosts: readonly [string, ...string[]]): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = sequence(der(0x31, sequence(COMMON_NAME, der(0x0c, Buffer.from(hosts[0])))));
  const now = Date.now();
  // Each host as a dNSName ([2], implicit).
  const altNames = sequence(SUBJECT_ALT_NAME, der(0x04, sequence(...hosts.map((host) => der(0x82, Buffer.from(host))))));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    // A positive serial in minimal DER: a first byte of 1, then 7 random ones.
    der(0x02, Buffer.from([1]), randomBytes(7)),
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(now - 60 * 60_000)), utcTime(new Date(now + 24 * 60 * 60_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(altNames)),
  );
  // The signature as a BIT STRING with no unused bits.
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: new X509Certificate(certificate).toString() };
}
