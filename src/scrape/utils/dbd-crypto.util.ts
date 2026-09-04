// @ts-nocheck — Web Crypto + DecompressionStream (Node 18+ / browser)
/**
 * Decrypt DBD envelope responses (x-encrypted: true).
 * Works in Node 18+ (Web Crypto) and can be inlined for page.evaluate.
 */

export interface DbdEnvelope {
  kid: number;
  salt: string;
  iv: string;
  ct: string;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '==='.slice((s.length + 3) % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin);
}

function parseJwtPayload(jwt: string): { encKey: string; exp: number } {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('invalid jwt');
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

async function deriveAesKey(
  keyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<CryptoKey> {
  const km = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, km, 256);
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

async function tryDecompress(data: Uint8Array, format: string): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream(format as CompressionFormat);
    const blob = new Blob([data as BlobPart]);
    const stream = blob.stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function inflateMaybe(data: Uint8Array): Promise<Uint8Array> {
  for (const format of ['deflate-raw', 'deflate', 'gzip'] as const) {
    const out = await tryDecompress(data, format);
    if (out) return out;
  }
  return data;
}

export async function decryptEnvelope<T>(
  env: DbdEnvelope,
  path: string,
  accessToken: string,
): Promise<T> {
  if (!accessToken) throw new Error('missing access token');
  const { encKey, exp } = parseJwtPayload(accessToken);
  if (!encKey) throw new Error('jwt missing encKey claim');
  if (exp && exp < Date.now() / 1000) throw new Error('access token expired');

  const keyMat = b64urlToBytes(encKey);
  const salt = b64urlToBytes(env.salt);
  const iv = b64urlToBytes(env.iv);
  const ct = b64urlToBytes(env.ct);
  const infoStr = `bdw|v${env.kid}|${path}`;
  const infoBytes = new TextEncoder().encode(infoStr);
  const info = new Uint8Array(infoBytes);

  const aesKey = await deriveAesKey(keyMat, salt, info);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: info }, aesKey, ct);
  const inflated = await inflateMaybe(new Uint8Array(plain));
  const json = new TextDecoder().decode(inflated);
  return JSON.parse(json) as T;
}
