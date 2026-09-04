// @ts-nocheck — self-contained browser function for page.evaluate
/**
 * Self-contained browser-side DBD API fetcher for page.evaluate.
 * Must not reference imports — Playwright serializes only the function body.
 */
export async function browserFetchDbdApi(
  path: string,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  function b64urlToBytes(s: string): Uint8Array {
    const pad = '==='.slice((s.length + 3) % 4);
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function parseJwtPayload(jwt: string): { encKey: string; exp: number } {
    const part = jwt.split('.')[1];
    if (!part) throw new Error('invalid jwt');
    const json = new TextDecoder().decode(b64urlToBytes(part));
    return JSON.parse(json);
  }

  async function deriveAesKey(keyMaterial: Uint8Array, salt: Uint8Array, info: Uint8Array) {
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
    for (const format of ['deflate-raw', 'deflate', 'gzip']) {
      const out = await tryDecompress(data, format);
      if (out) return out;
    }
    return data;
  }

  async function decryptEnvelope(env: { kid: number; salt: string; iv: string; ct: string }, apiPath: string, accessToken: string) {
    const { encKey, exp } = parseJwtPayload(accessToken);
    if (!encKey) throw new Error('jwt missing encKey claim');
    if (exp && exp < Date.now() / 1000) throw new Error('access token expired');

    const keyMat = b64urlToBytes(encKey);
    const salt = b64urlToBytes(env.salt);
    const iv = b64urlToBytes(env.iv);
    const ct = b64urlToBytes(env.ct);
    const infoStr = `bdw|v${env.kid}|${apiPath}`;
    const infoBytes = new TextEncoder().encode(infoStr);
    const info = new Uint8Array(infoBytes.length);
    info.set(infoBytes);

    const aesKey = await deriveAesKey(keyMat, salt, info);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: info }, aesKey, ct);
    const inflated = await inflateMaybe(new Uint8Array(plain));
    return JSON.parse(new TextDecoder().decode(inflated));
  }

  try {
    let idToken = '';
    let lastRefreshStatus = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const refresh = await fetch('/api/refresh', { method: 'POST', credentials: 'include' });
      lastRefreshStatus = refresh.status;
      if (refresh.ok) {
        idToken = (await refresh.json()).idToken;
        break;
      }
      await new Promise(r => setTimeout(r, 2500 * attempt));
    }
    if (!idToken) {
      return { ok: false, status: lastRefreshStatus, data: null, error: `refresh failed: ${lastRefreshStatus}` };
    }

    const res = await fetch(path, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${idToken}`,
        referer: location.origin + '/',
      },
      credentials: 'include',
    });

    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: `api ${path} -> ${res.status}` };
    }

    const encrypted = (res.headers.get('x-encrypted') ?? '').toLowerCase() === 'true';
    const text = await res.text();
    if (!text) return { ok: true, status: res.status, data: null };

    const json = JSON.parse(text);
    const pathname = path.split('?')[0]!;
    const data = encrypted ? await decryptEnvelope(json, pathname, idToken) : json;
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: (e as Error).message };
  }
}
