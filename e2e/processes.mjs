// Stopping what the harness started. Everything here works from the PID of a process the harness
// spawned itself (as the leader of its own process group), never from a name or a command line:
// a pattern match would also hit somebody else's Chrome or a second run beside this one.

import { existsSync, readdirSync, readFileSync } from 'node:fs';

/** Sleeps without an event loop, so it works inside an 'exit' handler, which cannot await. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * True while a live process belongs to the group led by `pid`. A killed process that nobody has
 * waited for yet is a zombie: it still answers `kill(pid, 0)`, and inside an 'exit' handler
 * nothing can reap it, so on Linux the zombies are told apart in /proc.
 */
export function groupAlive(pid) {
  if (existsSync('/proc/self/stat')) {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        // "pid (comm) state ppid pgrp ...": comm may hold spaces and parentheses, so split after the last ')'
        const [state, , pgrp] = readFileSync(`/proc/${entry}/stat`, 'utf8').replace(/^.*\)\s+/s, '').split(' ');
        if (Number(pgrp) === pid && state !== 'Z' && state !== 'X') return true;
      } catch {
        // it exited while we looked
      }
    }
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but is not ours to signal: still alive
    return error.code === 'EPERM';
  }
}

/**
 * Ends the process group led by `pid` and returns once it is gone. Synchronous on purpose: the
 * callers run from 'exit', the one hook every way out of the process passes through.
 * SIGTERM first when `graceMs` allows it, so a server can close its database; SIGKILL for what is left.
 */
export function killGroup(pid, { graceMs = 0 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const send = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // the group is already gone
    }
  };
  if (graceMs > 0) {
    send('SIGTERM');
    for (let waited = 0; waited < graceMs && groupAlive(pid); waited += 50) pause(50);
  }
  if (!groupAlive(pid)) return;
  send('SIGKILL');
  // SIGKILL cannot be caught, but the kernel still needs a moment to reap the group
  for (let waited = 0; waited < 2000 && groupAlive(pid); waited += 20) pause(20);
}
