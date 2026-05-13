/**
 * At-rest secret encryption using libsodium's `crypto_secretbox_easy`
 * (XSalsa20-Poly1305). One key, fresh nonce per encrypt, authenticated
 * ciphertext. Envelope shape: `{ v: 1, nonce: hex, ct: hex }`.
 *
 * Why secretbox over AES-GCM:
 *   - libsodium is misuse-resistant. The biggest GCM footgun (nonce reuse)
 *     is harder to commit accidentally with the API shape.
 *   - It's been the default in production crypto stacks for a decade.
 *
 * Rotation: see `packages/storage/src/secrets/rotate.ts` (post-M1).
 */

import sodium from 'sodium-native';

export interface Envelope {
  readonly v: 1;
  readonly nonce: string; // hex
  readonly ct: string; // hex
}

const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES;
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES;
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES;

export class SecretBox {
  private readonly key: Buffer;

  /** `keyHex` must be 32 bytes (64 hex chars). Validated in @gcr/config. */
  constructor(keyHex: string) {
    const buf = Buffer.from(keyHex, 'hex');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`SecretBox key must be ${KEY_BYTES} bytes (got ${buf.length})`);
    }
    this.key = buf;
  }

  encrypt(plaintext: string): Envelope {
    const message = Buffer.from(plaintext, 'utf8');
    const nonce = Buffer.allocUnsafe(NONCE_BYTES);
    sodium.randombytes_buf(nonce);
    const ct = Buffer.allocUnsafe(message.length + MAC_BYTES);
    sodium.crypto_secretbox_easy(ct, message, nonce, this.key);
    return { v: 1, nonce: nonce.toString('hex'), ct: ct.toString('hex') };
  }

  decrypt(envelope: Envelope): string {
    if (envelope.v !== 1) throw new Error(`unsupported envelope version: ${envelope.v}`);
    const nonce = Buffer.from(envelope.nonce, 'hex');
    const ct = Buffer.from(envelope.ct, 'hex');
    if (nonce.length !== NONCE_BYTES) throw new Error('nonce length wrong');
    if (ct.length < MAC_BYTES) throw new Error('ciphertext too short');
    const out = Buffer.allocUnsafe(ct.length - MAC_BYTES);
    const ok = sodium.crypto_secretbox_open_easy(out, ct, nonce, this.key);
    if (!ok) throw new Error('secretbox: authentication failed');
    return out.toString('utf8');
  }

  /** Convenience: encrypt to JSON string (what the DB stores). */
  encryptToJson(plaintext: string): string {
    return JSON.stringify(this.encrypt(plaintext));
  }

  /** Convenience: decrypt from a JSON envelope string. */
  decryptFromJson(json: string): string {
    return this.decrypt(JSON.parse(json) as Envelope);
  }
}
