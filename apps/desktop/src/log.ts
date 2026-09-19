import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

/** Append-only log file that rotates on open (name.log -> name.log.1 -> ...), keeping the last few runs */
export class LogFile {
  readonly path: string;
  private stream: WriteStream;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, name);
    if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) this.rotate();
    this.stream = createWriteStream(this.path, { flags: 'a' });
  }

  write(chunk: string | Buffer): void {
    this.stream.write(chunk);
  }

  /** Timestamped line, for the desktop shell's own messages */
  line(message: string): void {
    this.write(`${new Date().toISOString()} [desktop] ${message}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }

  private rotate(): void {
    rmSync(`${this.path}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
  }
}
