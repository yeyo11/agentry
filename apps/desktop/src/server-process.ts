import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { LogFile } from './log.ts';

const READY_PREFIX = 'AGENTRY_READY ';
const READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

export interface ServerSpawn {
  entry: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Runs the bundled API on Electron's own Node (ELECTRON_RUN_AS_NODE) and tracks its lifecycle */
export class ServerProcess {
  private child: ChildProcess | undefined;
  private stopping = false;

  constructor(
    private readonly spec: ServerSpawn,
    private readonly log: LogFile,
    /** Called when the server dies without having been asked to stop */
    private readonly onCrash: (detail: string) => void,
  ) {}

  /** Resolves with the server URL once it printed its READY line */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      // The IPC channel makes the server exit by itself if this process dies without cleaning up
      const child = spawn(process.execPath, [this.spec.entry], {
        cwd: this.spec.cwd,
        env: { ...this.spec.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      this.child = child;
      this.stopping = false;
      this.log.line(`starting server: ${process.execPath} ${this.spec.entry} (pid ${child.pid})`);

      let ready = false;
      let stderrTail = '';
      const timer = setTimeout(() => {
        if (!ready) fail(new Error(`Server did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
      }, READY_TIMEOUT_MS);

      const fail = (err: Error) => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(err);
      };

      // Logs and the READY line share stdout; match by prefix instead of expecting the first line
      createInterface({ input: child.stdout! }).on('line', (line) => {
        this.log.write(`${line}\n`);
        if (ready || !line.startsWith(READY_PREFIX)) return;
        try {
          const { url } = JSON.parse(line.slice(READY_PREFIX.length)) as { url: string };
          ready = true;
          clearTimeout(timer);
          resolve(url);
        } catch {
          fail(new Error(`Malformed READY line: ${line}`));
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        this.log.write(chunk);
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      child.once('error', (err) => {
        this.log.line(`server failed to spawn: ${err.message}`);
        if (!ready) fail(err);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const how = signal ? `signal ${signal}` : `code ${code}`;
        this.log.line(`server exited with ${how}`);
        if (this.child === child) this.child = undefined;
        if (this.stopping) return;
        const detail = `The server exited with ${how}.${stderrTail ? `\n\n${stderrTail.trim()}` : ''}`;
        if (ready) this.onCrash(detail);
        else reject(new Error(detail));
      });
    });
  }

  /** SIGTERM, then SIGKILL if it does not leave within the grace period */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  get running(): boolean {
    return this.child !== undefined;
  }
}
