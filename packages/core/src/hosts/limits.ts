import type { HostCall } from './exec.ts';

/** A call waited its admission time without a free slot: reported as the `busy` reason */
export class HostBusyError extends Error {
  constructor(readonly cli: HostCall['cli']) {
    super(`too many ${cli} processes at once`);
    this.name = 'HostBusyError';
  }
}

export interface HostLimiterOptions {
  /** Processes per CLI at once in this Agentry process */
  perCli?: number;
  /** How long a call waits for a slot before it is `busy` */
  admissionMs?: number;
}

export const DEFAULT_PER_CLI = 4;
export const DEFAULT_ADMISSION_MS = 30_000;

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

/** At most `perCli` processes per CLI, queued in arrival order, each waiting at most `admissionMs`. */
export class HostLimiter {
  private readonly perCli: number;
  private readonly admissionMs: number;
  private readonly running = new Map<HostCall['cli'], number>();
  private readonly queues = new Map<HostCall['cli'], Waiter[]>();

  constructor(options: HostLimiterOptions = {}) {
    this.perCli = options.perCli ?? DEFAULT_PER_CLI;
    this.admissionMs = options.admissionMs ?? DEFAULT_ADMISSION_MS;
  }

  /** Resolves with the function that gives the slot back (call it once); rejects with `HostBusyError` after the admission time */
  acquire(cli: HostCall['cli']): Promise<() => void> {
    const used = this.running.get(cli) ?? 0;
    if (used < this.perCli) {
      this.running.set(cli, used + 1);
      return Promise.resolve(this.releaser(cli));
    }
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(cli) ?? [];
      this.queues.set(cli, queue);
      const waiter: Waiter = {
        // The slot passes straight to the waiter, so `running` stays where it was
        grant: () => resolve(this.releaser(cli)),
        timer: setTimeout(() => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(new HostBusyError(cli));
        }, this.admissionMs),
      };
      queue.push(waiter);
    });
  }

  private releaser(cli: HostCall['cli']): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queues.get(cli)?.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant();
        return;
      }
      this.running.set(cli, Math.max(0, (this.running.get(cli) ?? 1) - 1));
    };
  }

  /** Processes running now for a CLI, for tests and the status line */
  active(cli: HostCall['cli']): number {
    return this.running.get(cli) ?? 0;
  }
}

/** The one limiter of this process: every call to a host CLI goes through it */
export const hostLimiter = new HostLimiter();
