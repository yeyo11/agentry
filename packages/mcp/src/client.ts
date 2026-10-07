/** Longest a request to the API may take before the tool answers with an error */
export const REQUEST_TIMEOUT_MS = 15_000;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface ClientOptions {
  /** `AGENTRY_API_URL`, which already ends in `/api` */
  baseUrl: string;
  token?: string | undefined;
  chatId?: string | undefined;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** An answer the API gave that is not a success, or a request that never got one */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface ApiClient {
  get(path: string, query?: Query): Promise<unknown>;
  /** The write tools' only way out: a POST or a PATCH with a JSON body, nothing else */
  send(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown>;
  /** Kept so the refusal belongs to the client, not to whoever calls it */
  request(method: string, path: string, query?: Query): Promise<unknown>;
}

/** The base URL from the environment, or null when it is not an http(s) URL */
export function apiUrlFrom(value: string | undefined): string | null {
  const url = value?.trim();
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/** `request` and `get` only read; `send` is the one way to write, and only POST and PATCH: nothing here deletes */
export function createClient(options: ClientOptions): ApiClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  // Informational: it grants nothing, it lets a later audit attribute the call
  if (options.chatId) headers['x-agentry-chat'] = options.chatId;

  async function perform(method: string, path: string, query: Query = {}, body?: unknown): Promise<unknown> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') search.set(key, String(value));
    const qs = search.toString();
    const url = `${options.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return text;
        }
      }
      throw new ApiError(failure(res.status, text), res.status);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const why = controller.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : err instanceof Error ? err.message : String(err);
      throw new ApiError(`could not reach ${options.baseUrl}: ${why}`, null);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    request: (method, path, query) => (method === 'GET' ? perform(method, path, query) : Promise.reject(new ApiError(`this server only reads: ${method} is refused`, null))),
    get: (path, query) => perform('GET', path, query),
    send: (method, path, body) => perform(method, path, {}, body ?? {}),
  };
}

function failure(status: number, body: string): string {
  let reason = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') reason = parsed.error;
  } catch {
    // not JSON: the body is the reason
  }
  if (status === 401) return `401: Agentry's API is guarded and this chat has no token (CW-10)${reason ? ` (${reason})` : ''}`;
  return `${status}: ${reason || 'request failed'}`;
}
