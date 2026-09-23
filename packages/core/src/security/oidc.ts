import { constants, createPublicKey, verify as verifySignature, type KeyObject, type VerifyKeyObjectInput } from 'node:crypto';
import type { OidcConfig } from '@agentry/shared';

/**
 * JWT validation against the issuer's JWKS, with no dependency: Node can build a public key from a
 * JWK and verify with it, which is the whole of what checking a signed token needs.
 *
 * Only the signature, the issuer, the audience, the authorised party and the lifetime are checked.
 * Agentry never starts an authorisation code flow and never talks to the token endpoint: whoever
 * puts the panel behind an identity provider brings the token, from a proxy or from their own
 * client.
 */

/** JOSE algorithms Node can verify from a JWK, and how each one is passed to `crypto.verify`. */
const ALGORITHMS: Record<string, { hash: string; options?: Omit<VerifyKeyObjectInput, 'key'> }> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', options: { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } },
  PS384: { hash: 'sha384', options: { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } },
  PS512: { hash: 'sha512', options: { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } },
  // A raw (r‖s) signature, which is what JWS carries, not the DER the default expects
  ES256: { hash: 'sha256', options: { dsaEncoding: 'ieee-p1363' } },
  ES384: { hash: 'sha384', options: { dsaEncoding: 'ieee-p1363' } },
  ES512: { hash: 'sha512', options: { dsaEncoding: 'ieee-p1363' } },
};

/** Clocks between an issuer and this host are never exactly the same. */
const SKEW_SECONDS = 60;
const KEYS_TTL_MS = 10 * 60_000;
/** An unknown `kid` refetches the key set, but no faster than this: it is a remote call a caller controls. */
const REFETCH_MIN_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

interface Jwk extends Record<string, unknown> {
  kid?: string;
  alg?: string;
  use?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  /** The party the token was issued to; present when it is not simply the audience */
  azp?: string;
  exp?: number;
  nbf?: number;
}

interface CachedKeys {
  at: number;
  keys: Jwk[];
  jwksUri: string;
}

const decodePart = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Trailing slashes are not significant in an issuer, and providers are inconsistent about them. */
const sameIssuer = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class OidcVerifier {
  private cache = new Map<string, CachedKeys>();
  private lastFetch = new Map<string, number>();

  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {}

  /** Forgets every cached key set, so a configuration change is picked up at once. */
  reset(): void {
    this.cache.clear();
    this.lastFetch.clear();
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url} answered ${String(res.status)}`);
    const body = (await res.json()) as unknown;
    if (typeof body !== 'object' || body === null) throw new Error(`${url} did not answer with a JSON object`);
    return body as Record<string, unknown>;
  }

  /**
   * The key set of an issuer, from its discovery document. The well-known JWKS path is tried when
   * discovery is not served, which is what a minimal issuer (and a test one) exposes.
   */
  private async fetchKeys(issuer: string): Promise<CachedKeys> {
    const base = issuer.replace(/\/+$/, '');
    let jwksUri = `${base}/.well-known/jwks.json`;
    try {
      const discovery = await this.getJson(`${base}/.well-known/openid-configuration`);
      if (typeof discovery.jwks_uri === 'string') jwksUri = discovery.jwks_uri;
    } catch {
      // No discovery document: the conventional JWKS path is the remaining thing to try
    }
    const document = await this.getJson(jwksUri);
    const keys = Array.isArray(document.keys) ? (document.keys as Jwk[]) : [];
    if (keys.length === 0) throw new Error(`${jwksUri} carries no keys`);
    return { at: Date.now(), keys, jwksUri };
  }

  private async keysFor(issuer: string, kid: string | undefined): Promise<Jwk[]> {
    const cached = this.cache.get(issuer);
    if (cached) {
      const fresh = Date.now() - cached.at < KEYS_TTL_MS;
      const known = kid === undefined || cached.keys.some((key) => key.kid === kid);
      if (fresh && known) return cached.keys;
      // Stale, or signed with a key we have not seen: refetch, but never once per request — the
      // kid comes from whoever is knocking, and refetching on each one is a way in to the issuer.
      if (Date.now() - (this.lastFetch.get(issuer) ?? 0) < REFETCH_MIN_MS) return cached.keys;
    }
    this.lastFetch.set(issuer, Date.now());
    const loaded = await this.fetchKeys(issuer);
    this.cache.set(issuer, loaded);
    return loaded.keys;
  }

  /**
   * Checks a bearer JWT and answers with its subject, which is the actor an audit row records.
   * Throws with the reason it failed; the caller turns that into one 401.
   */
  async verify(token: string, config: OidcConfig): Promise<string> {
    const parts = token.split('.');
    const [rawHeader, rawPayload, rawSignature] = parts;
    if (parts.length !== 3 || !rawHeader || !rawPayload || !rawSignature) throw new Error('not a signed JWT');

    let header: JwtHeader;
    let claims: JwtClaims;
    try {
      header = decodePart(rawHeader) as JwtHeader;
      claims = decodePart(rawPayload) as JwtClaims;
    } catch {
      throw new Error('the token is not readable');
    }

    const algorithm = header.alg ? ALGORITHMS[header.alg] : undefined;
    if (!algorithm) throw new Error(`unsupported algorithm ${header.alg ?? 'none'}`);

    if (!claims.iss || !sameIssuer(claims.iss, config.issuer)) throw new Error('the token was issued by someone else');
    const audience = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!audience.includes(config.audience)) throw new Error('the token is for another audience');
    // OpenID Connect Core 1.0 §3.1.3.7: `azp` names the client the token was issued to, and is
    // there only when it differs from the audience. A configured client id must therefore reject a
    // token that names another one, and accept a token that names none — anything else would turn
    // the setting into a lockout for the issuers that omit it.
    if (config.clientId && typeof claims.azp === 'string' && claims.azp !== config.clientId) {
      throw new Error('the token was issued to another client');
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number') throw new Error('the token has no expiry');
    if (claims.exp + SKEW_SECONDS < now) throw new Error('the token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > now) throw new Error('the token is not valid yet');
    if (!claims.sub) throw new Error('the token has no subject');

    const data = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
    const signature = Buffer.from(rawSignature, 'base64url');
    const keys = await this.keysFor(config.issuer, header.kid);
    const candidates = header.kid ? keys.filter((key) => key.kid === header.kid) : keys;
    if (candidates.length === 0) throw new Error('no key of the issuer matches the token');

    for (const jwk of candidates) {
      if (jwk.use && jwk.use !== 'sig') continue;
      if (jwk.alg && jwk.alg !== header.alg) continue;
      let key: KeyObject;
      try {
        key = createPublicKey({ key: jwk as never, format: 'jwk' });
      } catch {
        continue; // a key Node cannot build (an unsupported curve) is not the one that signed it
      }
      if (verifySignature(algorithm.hash, data, { key, ...algorithm.options }, signature)) return claims.sub;
    }
    throw new Error('the signature does not match the issuer keys');
  }
}
