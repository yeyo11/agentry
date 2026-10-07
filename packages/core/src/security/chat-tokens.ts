import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A chat token is refused after this long even while its process lives. One turn ends long before
 * it; the cap is there for a process whose `exit` never reached us, so no token outlives a day.
 */
export const CHAT_TOKEN_MAX_AGE_MS = 24 * 60 * 60_000;

/** Makes a leaked chat token recognisable in a log or a paste, apart from the owner's token. */
export const CHAT_TOKEN_PREFIX = 'agc_';

/** Who a request made with a chat token is, in an audit row and to the guard. */
export const chatActor = (chatId: string): string => `chat:${chatId}`;

interface Minted {
  /** SHA-256 of the token; the token itself is never held */
  hash: Buffer;
  chatId: string;
  /** The process the token was minted for, so revoking one process never touches another's */
  pid: number | undefined;
  mintedAt: number;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * The credentials Agentry hands the CLI processes it spawns (`AGENTRY_API_TOKEN`), so a chat can
 * call the wrapper that started it when the API is guarded.
 *
 * In memory only, and only as hashes: nothing here reaches `auth.json`, SQLite or a log, so a
 * restart of the wrapper revokes every chat token by construction, and a heap dump holds nothing
 * that can be replayed. Keyed by the hash, so lookup is one map read; the comparison after it is
 * `timingSafeEqual` anyway, like the owner's token.
 */
export class ChatTokenStore {
  private readonly tokens = new Map<string, Minted>();

  /** The clock is a parameter so a test can age a token past its maximum without waiting a day. */
  constructor(private readonly now: () => number = Date.now) {}

  /** A fresh token for one process of one chat. The caller hands it over and revokes it at exit. */
  mint(chatId: string, pid?: number): string {
    this.sweep();
    const token = `${CHAT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const hash = sha256(token);
    this.tokens.set(hash.toString('hex'), { hash, chatId, pid, mintedAt: this.now() });
    return token;
  }

  /** The process id is only known once `spawn` returned, after the token had to be in its environment. */
  attach(token: string, pid: number | undefined): void {
    const minted = this.tokens.get(sha256(token).toString('hex'));
    if (minted) minted.pid = pid;
  }

  /** The chat a live, unexpired token belongs to, or null. */
  verify(presented: string): string | null {
    if (!presented.startsWith(CHAT_TOKEN_PREFIX)) return null;
    const digest = sha256(presented);
    const key = digest.toString('hex');
    const minted = this.tokens.get(key);
    if (!minted || !timingSafeEqual(minted.hash, digest)) return null;
    if (this.now() - minted.mintedAt >= CHAT_TOKEN_MAX_AGE_MS) {
      this.tokens.delete(key);
      return null;
    }
    return minted.chatId;
  }

  /** Whether a word is a token this store minted, expired or not: for masking, never for access. */
  holds(word: string): boolean {
    return word.startsWith(CHAT_TOKEN_PREFIX) && this.tokens.has(sha256(word).toString('hex'));
  }

  revoke(token: string): void {
    this.tokens.delete(sha256(token).toString('hex'));
  }

  /** The wrapper is shutting down: no chat token outlives the processes it stops. */
  revokeAll(): void {
    this.tokens.clear();
  }

  /** Tokens held right now, expired ones included until the next sweep. */
  get size(): number {
    return this.tokens.size;
  }

  /** Expired entries are dropped as new ones arrive, so a lost `exit` cannot grow the map forever. */
  private sweep(): void {
    const now = this.now();
    for (const [key, minted] of this.tokens) if (now - minted.mintedAt >= CHAT_TOKEN_MAX_AGE_MS) this.tokens.delete(key);
  }
}
