/**
 * Tiny ambient declaration for `sodium-native`.
 *
 * The package ships no .d.ts and we only use four functions. Importing real
 * `@types/sodium-native` would pull in API surfaces we don't touch and
 * version drift risk we don't want.
 *
 * Exposes both `import sodium from 'sodium-native'` (CJS-style default) and
 * `import * as sodium from 'sodium-native'` (namespace).
 */

declare module 'sodium-native' {
  interface SodiumApi {
    readonly crypto_secretbox_KEYBYTES: number;
    readonly crypto_secretbox_NONCEBYTES: number;
    readonly crypto_secretbox_MACBYTES: number;

    randombytes_buf(buf: Buffer): void;

    crypto_secretbox_easy(out: Buffer, message: Buffer, nonce: Buffer, key: Buffer): void;

    /** Returns false on auth failure; does NOT throw. */
    crypto_secretbox_open_easy(out: Buffer, ct: Buffer, nonce: Buffer, key: Buffer): boolean;
  }

  const sodium: SodiumApi;
  export = sodium;
}
