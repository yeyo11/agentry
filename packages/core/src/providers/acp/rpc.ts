import type { SessionIO } from '../driver.ts';

/** A JSON-RPC error answer: the agent's code and message, kept so callers can tell "sign in" from "broke". */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** ACP's "authentication required". */
export const AUTH_REQUIRED = -32000;
export const METHOD_NOT_FOUND = -32601;

type Params = Record<string, unknown>;

export interface RpcHandlers {
  /** The agent asks the client something; it must be answered with `respond` or `respondError` */
  request(id: number | string, method: string, params: Params): void;
  notification(method: string, params: Params): void;
  /** A stdout line that is not a JSON-RPC message */
  unreadable(line: string): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * JSON-RPC 2.0 over lines, the half every ACP agent shares: requests that resolve on their answer,
 * notifications, and the agent's own requests handed to whoever owns the session. A message is told
 * apart by its fields, not by the `jsonrpc` tag.
 */
export class JsonRpc {
  private next = 0;
  private readonly pending = new Map<number | string, Pending>();

  constructor(
    private readonly io: Pick<SessionIO, 'write'>,
    private readonly handlers: RpcHandlers,
  ) {}

  request<T = Record<string, unknown>>(method: string, params: Params): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Params): void {
    this.send({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  /** One line of the agent's stdout */
  line(text: string): void {
    if (!text.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.handlers.unreadable(text);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.handlers.unreadable(text);
      return;
    }
    const raw = message as Record<string, unknown>;
    const id = typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : undefined;
    const params = raw.params && typeof raw.params === 'object' ? (raw.params as Params) : {};
    if (typeof raw.method === 'string') {
      if (id === undefined) this.handlers.notification(raw.method, params);
      else this.handlers.request(id, raw.method, params);
      return;
    }
    if (id === undefined) {
      this.handlers.unreadable(text);
      return;
    }
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    const error = raw.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (error) {
      waiting.reject(new RpcError(typeof error.code === 'number' ? error.code : -32603, typeof error.message === 'string' ? error.message : `${waiting.method} failed`, error.data));
    } else {
      waiting.resolve(raw.result ?? {});
    }
  }

  /** The process is gone or the chat ended: nothing will answer what is still waiting */
  dispose(reason: string): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(new Error(reason));
  }

  private send(message: Record<string, unknown>): void {
    this.io.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
}
