import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AuthConfig, AuthMode, AuthTokenResult, OidcConfig, SetAuthTokenRequest, UpdateAuthConfigRequest } from '@agentry/shared';
import { writeAtomic } from '../config/files.ts';
import type { AuthEnv, CoreConfig } from '../paths.ts';
import { OidcVerifier } from './oidc.ts';

/**
 * What is on disk. The token itself is never here: only its SHA-256, so a stolen data volume
 * yields nothing that can be replayed against the API, and no route can echo it back.
 */
interface StoredAuth {
  mode: AuthMode;
  tokenHash?: string;
  /** Names the credential in an audit row, so rotating the token is visible in the history */
  tokenId?: string;
  tokenCreatedAt?: string;
  /**
   * SHA-256 of the last `AGENTRY_AUTH_TOKEN` that `AGENTRY_AUTH_TOKEN_RESET` applied. A deployment
   * that leaves the variable set would otherwise undo, on every restart, a token rotated since.
   */
  envResetHash?: string;
  oidc?: OidcConfig;
  readOnly: boolean;
}

const DEFAULTS: StoredAuth = { mode: 'none', readOnly: false };

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Compares digests, which are the same length, so the comparison cannot leak by timing out early. */
function sameSecret(presented: string, storedHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const digest = sha256(presented);
  return stored.length === digest.length && timingSafeEqual(stored, digest);
}

function parseMode(value: unknown): AuthMode {
  if (value === 'none' || value === 'token' || value === 'oidc') return value;
  throw new Error("mode must be 'none', 'token' or 'oidc'");
}

function parseOidc(value: unknown): OidcConfig {
  if (typeof value !== 'object' || value === null) throw new Error('oidc must be an object');
  const { issuer, audience, clientId } = value as Record<string, unknown>;
  if (typeof issuer !== 'string' || !issuer.trim()) throw new Error('oidc.issuer is required');
  if (typeof audience !== 'string' || !audience.trim()) throw new Error('oidc.audience is required');
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error('oidc.issuer must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('oidc.issuer must be an http(s) URL');
  return {
    issuer: issuer.trim(),
    audience: audience.trim(),
    clientId: typeof clientId === 'string' ? clientId.trim() : '',
  };
}

/**
 * How the API is guarded, and the only thing that can answer "may this request in?".
 *
 * `none` is the default, because a local install behind loopback has always worked that way and
 * turning a guard on by itself would lock people out of their own wrapper on upgrade. The
 * environment can hand a fresh install its mode and token (a Helm chart with a Secret, a compose
 * file), and from then on the document in the data dir is what counts.
 */
export class AuthStore {
  private readonly file: string;
  private stored: StoredAuth = { ...DEFAULTS };
  private readonly oidcVerifier: OidcVerifier;
  /**
   * When this start replaced the token from the environment. The store has no database, so the
   * owner of both writes the audit row; nothing else should read it.
   */
  readonly environmentReset: { at: string } | null = null;

  constructor(config: CoreConfig, env: AuthEnv = config.authEnv, verifier = new OidcVerifier()) {
    this.file = join(config.dataDir, 'auth.json');
    this.oidcVerifier = verifier;
    if (existsSync(this.file)) {
      try {
        this.stored = { ...DEFAULTS, ...(JSON.parse(readFileSync(this.file, 'utf8')) as StoredAuth) };
      } catch (error) {
        // Falling back to the default would open a wrapper that was closed, so nothing starts
        // until a person looks at the file: an unreadable guard is not an absent one.
        throw new Error(`${this.file} is not readable as JSON (${error instanceof Error ? error.message : String(error)}); fix or delete it`);
      }
      const reset = resetFromEnvironment(env, this.stored);
      if (reset) {
        this.stored = reset;
        this.environmentReset = { at: reset.tokenCreatedAt ?? new Date().toISOString() };
        this.persistSync();
      }
    } else {
      this.stored = fromEnvironment(env);
      if (this.stored.mode !== 'none' || this.stored.readOnly) this.persistSync();
    }
  }

  private async persist(): Promise<void> {
    await writeAtomic(this.file, `${JSON.stringify(this.stored, null, 2)}\n`);
    chmodSync(this.file, 0o600);
  }

  /** The constructor cannot await, and a guard the environment asked for must be on disk before the first request. */
  private persistSync(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  /** The public shape: mode, whether a token exists, the OIDC fields — never the token. */
  get config(): AuthConfig {
    return {
      mode: this.stored.mode,
      tokenSet: Boolean(this.stored.tokenHash),
      ...(this.stored.oidc ? { oidc: this.stored.oidc } : {}),
      readOnly: this.stored.readOnly,
    };
  }

  get mode(): AuthMode {
    return this.stored.mode;
  }

  get readOnly(): boolean {
    return this.stored.readOnly;
  }

  async update(request: UpdateAuthConfigRequest): Promise<AuthConfig> {
    if (typeof request !== 'object' || request === null) throw new Error('body must be a JSON object');
    const next: StoredAuth = { ...this.stored };
    if (request.oidc !== undefined) {
      if (request.oidc === null) delete next.oidc;
      else next.oidc = parseOidc(request.oidc);
    }
    if (request.readOnly !== undefined) {
      if (typeof request.readOnly !== 'boolean') throw new Error('readOnly must be a boolean');
      next.readOnly = request.readOnly;
    }
    if (request.mode !== undefined) {
      const mode = parseMode(request.mode);
      // Turning a mode on without what it needs would lock everyone out on the next request
      if (mode === 'token' && !next.tokenHash) throw new Error('set a token before turning on token authentication');
      if (mode === 'oidc' && !next.oidc) throw new Error('configure the issuer and the audience before turning on OIDC');
      next.mode = mode;
    }
    this.stored = next;
    this.oidcVerifier.reset();
    await this.persist();
    return this.config;
  }

  /**
   * Sets or rotates the bearer token and returns it once, which is the only time it exists outside
   * the caller. A token Agentry generates is 32 random bytes: long enough that guessing it is not
   * a strategy, short enough to paste.
   */
  async setToken(request: SetAuthTokenRequest = {}): Promise<AuthTokenResult> {
    const given = typeof request.token === 'string' ? request.token.trim() : '';
    if (request.token !== undefined && typeof request.token !== 'string') throw new Error('token must be a string');
    if (given && given.length < 16) throw new Error('a token of your own must be at least 16 characters');
    const token = given || randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    this.stored = {
      ...this.stored,
      tokenHash: sha256(token).toString('hex'),
      tokenId: randomBytes(4).toString('hex'),
      tokenCreatedAt: createdAt,
    };
    await this.persist();
    return { token, createdAt };
  }

  /** Removes the token. Refused while it is the credential in use, which would lock everyone out. */
  async clearToken(): Promise<AuthConfig> {
    if (this.stored.mode === 'token') throw new Error('switch the mode away from `token` before removing the token');
    // `envResetHash` stays: forgetting it would let a variable still set re-apply a token removed on purpose
    const { tokenHash: _hash, tokenId: _id, tokenCreatedAt: _createdAt, ...rest } = this.stored;
    this.stored = rest;
    await this.persist();
    return this.config;
  }

  /**
   * Who is knocking, from the credential they presented: a token id, an OIDC subject, or `local`
   * when nothing guards the API. `null` means the credential is not good, and the caller answers
   * 401 without saying which part of it was wrong.
   */
  async actorFor(credential: string | undefined): Promise<string | null> {
    if (this.stored.mode === 'none') return 'local';
    if (!credential) return null;
    if (this.stored.mode === 'token') {
      if (!this.stored.tokenHash || !sameSecret(credential, this.stored.tokenHash)) return null;
      return `token:${this.stored.tokenId ?? 'default'}`;
    }
    const oidc = this.stored.oidc;
    if (!oidc) return null;
    try {
      return await this.oidcVerifier.verify(credential, oidc);
    } catch {
      return null;
    }
  }
}

/**
 * A fresh install takes its guard from the environment, so an image can be deployed already
 * closed. `AGENTRY_AUTH_TOKEN` is hashed on the way in like any other: the variable is read once
 * and its value is never written down.
 */
function fromEnvironment(env: AuthEnv): StoredAuth {
  const stored: StoredAuth = { ...DEFAULTS };
  const token = env.AGENTRY_AUTH_TOKEN?.trim();
  if (token) {
    stored.tokenHash = sha256(token).toString('hex');
    stored.tokenId = 'env';
    stored.tokenCreatedAt = new Date().toISOString();
    stored.mode = 'token';
    // Seeding already applied this value, so a reset flag left on does not apply it a second time
    if (flagOn(env.AGENTRY_AUTH_TOKEN_RESET)) stored.envResetHash = stored.tokenHash;
  }
  const issuer = env.AGENTRY_OIDC_ISSUER?.trim();
  const audience = env.AGENTRY_OIDC_AUDIENCE?.trim();
  if (issuer && audience) {
    stored.oidc = { issuer, audience, clientId: env.AGENTRY_OIDC_CLIENT_ID?.trim() ?? '' };
    stored.mode = 'oidc';
  }
  const mode = env.AGENTRY_AUTH_MODE?.trim();
  if (mode) {
    const parsed = parseMode(mode);
    if (parsed === 'token' && !stored.tokenHash) throw new Error('AGENTRY_AUTH_MODE=token needs AGENTRY_AUTH_TOKEN');
    if (parsed === 'oidc' && !stored.oidc) throw new Error('AGENTRY_AUTH_MODE=oidc needs AGENTRY_OIDC_ISSUER and AGENTRY_OIDC_AUDIENCE');
    stored.mode = parsed;
  }
  const readOnly = env.AGENTRY_READ_ONLY?.trim();
  if (readOnly) stored.readOnly = flagOn(readOnly);
  return stored;
}

function flagOn(value: string | undefined): boolean {
  const flag = value?.trim();
  return Boolean(flag) && flag !== '0' && flag?.toLowerCase() !== 'false';
}

/**
 * The way back in for someone who lost the token and cannot reach the data volume (a pod, a
 * managed host): `AGENTRY_AUTH_TOKEN_RESET=1` with `AGENTRY_AUTH_TOKEN` replaces the stored hash on
 * start. It changes the credential only; the mode, OIDC and read-only stay what the document says,
 * because the reset is about a lost secret, not about reconfiguring the guard. Returns `null` when
 * there is nothing to do, including a value already applied by an earlier start.
 */
function resetFromEnvironment(env: AuthEnv, stored: StoredAuth): StoredAuth | null {
  if (!flagOn(env.AGENTRY_AUTH_TOKEN_RESET)) return null;
  const token = env.AGENTRY_AUTH_TOKEN?.trim();
  // A reset that silently did nothing would leave the person locked out and wondering why
  if (!token) throw new Error('AGENTRY_AUTH_TOKEN_RESET needs AGENTRY_AUTH_TOKEN');
  const hash = sha256(token).toString('hex');
  if (stored.envResetHash === hash) return null;
  return { ...stored, tokenHash: hash, tokenId: 'env', tokenCreatedAt: new Date().toISOString(), envResetHash: hash };
}
