export type RpcId = number | string;

/** An error reply of the server: `-32600` for an unknown method or a refused call. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcHandlers {
  /** A request of the server: it waits for `respond` or `fail` */
  request(id: RpcId, method: string, params: Record<string, unknown>): void;
  notification(method: string, params: Record<string, unknown>): void;
  /** A line that is not JSON, or JSON that is not a message */
  unreadable(line: string): void;
}

/** A call the server has not answered by then is not going to be answered. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * JSON-RPC over JSONL, as `codex app-server` speaks it. What it sends carries `"jsonrpc":"2.0"`;
 * what it reads may not (the server omits it, recorded), so a message is told apart by its shape: an
 * `id` with a `method` is a request of the server, a `method` alone a notification, an `id` alone
 * the answer to one of ours.
 */
export class JsonRpc {
  private seq = 0;
  private readonly pending = new Map<RpcId, { resolve: (value: never) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly write: (text: string) => void,
    private readonly handlers: RpcHandlers,
  ) {}

  private send(message: Record<string, unknown>): void {
    this.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request<T>(method: string, params?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex did not answer ${method} in time`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject, timer });
      this.send({ id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send({ method, ...(params ? { params } : {}) });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  fail(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  /** One line of stdout. */
  line(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      if (text.trim()) this.handlers.unreadable(text);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.handlers.unreadable(text);
      return;
    }
    const raw = message as Record<string, unknown>;
    const id = typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : undefined;
    const params = raw.params && typeof raw.params === 'object' ? (raw.params as Record<string, unknown>) : {};
    if (typeof raw.method === 'string') {
      if (id !== undefined) this.handlers.request(id, raw.method, params);
      else this.handlers.notification(raw.method, params);
      return;
    }
    if (id === undefined) {
      this.handlers.unreadable(text);
      return;
    }
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    const error = raw.error as { code?: unknown; message?: unknown } | undefined;
    if (error) call.reject(new RpcError(typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'the server refused the call'));
    else call.resolve(raw.result as never);
  }

  /** The process is gone, or the chat is: nobody will answer what is still waiting. */
  dispose(reason: string): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
