import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

/**
 * A minimal software passkey for tests: it does what a phone or security key does
 * (creates a key pair, signs challenges), so the server's real verification runs.
 */

const b64u = (b: Buffer | Uint8Array | string) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

// Just enough CBOR for an attestation object and a COSE key.
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error('unsupported CBOR value');
}

export class SoftAuthenticator {
  private privateKey: KeyObject;
  private coseKey: Buffer;
  readonly credentialId = randomBytes(32);
  private counter = 0;
  userHandle = '';

  constructor(
    private origin: string,
    private rpId = new URL(origin).hostname,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    // kty EC2, alg ES256, crv P-256, x, y
    this.coseKey = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private authData(flags: number, attested: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    const parts: Buffer[] = [sha256(this.rpId), Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.coseKey);
    }
    return Buffer.concat(parts);
  }

  /** What the browser returns from navigator.credentials.create(). */
  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    // user present + user verified + attested credential data
    const authData = this.authData(0x01 | 0x04 | 0x40, true);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** What the browser returns from navigator.credentials.get(). `origin` lets a test play a phishing site. */
  authenticate(options: { challenge: string }, opts: { origin?: string; userVerified?: boolean } = {}) {
    const authData = this.authData(0x01 | (opts.userVerified === false ? 0 : 0x04), false);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, opts.origin);
    const signature = createSign('SHA256')
      .update(Buffer.concat([authData, sha256(clientDataJSON)]))
      .sign(this.privateKey);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
    };
  }
}
