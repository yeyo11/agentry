import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AgentryDistribution, StorageKind, StorageLocation, StorageReport } from '@agentry/shared';

/**
 * Whether the folders that hold the wrapper's state would survive replacing the container, read from
 * the mount table the process itself sees (`/proc/self/mountinfo`). Updating an image means removing
 * the container and starting another from it, and what was not on a volume with a name goes with it:
 * the sign-in, every transcript, the projects. The image declares `VOLUME` for all three folders, so
 * a command that names only some of them still starts, quietly, with the others on volumes Docker
 * made on its own, which the next command does not reattach.
 */

export interface Mount {
  /** Where it is attached in this process's view */
  point: string;
  /** The path on the source filesystem that the mount shows: for a Docker volume, its folder under /var/lib/docker/volumes */
  root: string;
  fsType: string;
}

/** `\040` is how the kernel writes a space (and `\011`, `\012` and `\134`) in a mount table */
const unescape = (text: string): string => text.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

export function parseMountInfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    const dash = fields.indexOf('-');
    // id parent major:minor root mount-point options [optional fields…] - fstype source super-options
    const [root, point, fsType] = [fields[3], fields[4], fields[dash + 1]];
    if (dash < 6 || !root || !point || !fsType) continue;
    mounts.push({ point: unescape(point), root: unescape(root), fsType });
  }
  return mounts;
}

/** The mount a folder is on: the one attached at the longest prefix of it */
function mountOf(path: string, mounts: readonly Mount[]): Mount | null {
  let best: Mount | null = null;
  for (const mount of mounts) {
    const covers = mount.point === sep || path === mount.point || path.startsWith(`${mount.point}${sep}`);
    // Later lines shadow earlier ones at the same point (a mount over a mount)
    if (covers && (!best || mount.point.length >= best.point.length)) best = mount;
  }
  return best;
}

/** A volume Docker named by a 64-digit id, and so one nobody named */
const ANONYMOUS_VOLUME = /\/volumes\/[0-9a-f]{64}\/_data(\/|$)/;
const EMPTY_DIR = /kubernetes\.io~empty-dir/;
const MEMORY_FS = new Set(['tmpfs', 'ramfs']);

export function classify(path: string, mounts: readonly Mount[]): StorageKind {
  const mount = mountOf(resolve(path), mounts);
  if (!mount) return 'unknown';
  if (MEMORY_FS.has(mount.fsType) || EMPTY_DIR.test(mount.root)) return 'temporary';
  if (ANONYMOUS_VOLUME.test(mount.root)) return 'anonymous';
  // The root of the container's own filesystem: the folder is part of the image's layers
  if (mount.point === sep) return 'container';
  return 'persistent';
}

const SURVIVES: ReadonlySet<StorageKind> = new Set(['persistent', 'unknown']);

export function storageReport(
  distribution: AgentryDistribution,
  folders: { config: string; data: string; workspace: string },
  mountTable: () => string = () => readFileSync('/proc/self/mountinfo', 'utf8'),
): StorageReport {
  if (distribution !== 'docker') return { distribution, checked: false, locations: [], atRisk: false };
  let mounts: Mount[] = [];
  try {
    mounts = parseMountInfo(mountTable());
  } catch {
    // no /proc (not Linux, or hidden): every folder reads as unknown, which warns of nothing
  }
  const locations: StorageLocation[] = (['config', 'data', 'workspace'] as const).map((id) => ({ id, path: folders[id], kind: classify(folders[id], mounts) }));
  return { distribution, checked: true, locations, atRisk: locations.some((location) => !SURVIVES.has(location.kind)) };
}
