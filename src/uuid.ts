/** The parts of the Web Crypto API used here. */
interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * Returns a random UUID (version 4).
 *
 * `crypto.randomUUID` only exists in secure contexts (`https://` and
 * `localhost`), so on a plain `http://` page it is undefined and calling it
 * would throw. `crypto.getRandomValues` is available everywhere, so it is used
 * as the fallback, with `Math.random` as the last resort for runtimes without
 * any `crypto`.
 */
export function generateId(): string {
  const cryptoApi: CryptoLike | undefined = (
    globalThis as { crypto?: CryptoLike }
  ).crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const bytes: Uint8Array = new Uint8Array(16);
  if (
    cryptoApi !== undefined &&
    typeof cryptoApi.getRandomValues === 'function'
  ) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string = Array.from(bytes, (byte: number): string =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
