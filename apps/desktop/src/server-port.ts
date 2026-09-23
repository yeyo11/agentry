import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The port the bundled server listened on last time.
 *
 * The shell used to start it on port 0 every launch, so the address changed on every start. Nothing
 * inside the app minded — it reads the real port back from the server's ready line — but everything
 * outside did: a browser bookmark, a tunnel whose host carries the port in its name, a service
 * worker registered under an origin that never comes back. Remembering the port makes the address
 * of a desktop install a fact rather than a lottery.
 *
 * It is a preference and not a promise: `listenOn` in the API falls back to a free port when this
 * one is taken, and whatever it settled on is written back here. The dev build keeps its own
 * userData directory, so the two never argue over the same number.
 */

const FILE = 'server-port.json';

/** Registered and user ports only: 0 is not a port to remember, and below 1024 needs privileges. */
const usable = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;

const fileIn = (userData: string): string => join(userData, FILE);

/** The remembered port, or null when there is none to trust. */
export function rememberedPort(userData: string): number | null {
  try {
    const { port } = JSON.parse(readFileSync(fileIn(userData), 'utf8')) as { port?: unknown };
    return usable(port) ? port : null;
  } catch {
    // No file yet, or one nobody can read: the next start picks a port and writes it
    return null;
  }
}

/** Records the port the server actually bound, which is not always the one it was asked for. */
export function rememberPort(userData: string, port: number): void {
  if (!usable(port)) return;
  try {
    writeFileSync(fileIn(userData), JSON.stringify({ port }));
  } catch {
    // Non-critical: the address moves again next launch, which is where this started
  }
}
