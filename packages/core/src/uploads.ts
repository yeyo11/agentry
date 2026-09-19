import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Attachment } from '@agentry/shared';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the Messages API accepts per block, and a ceiling for files Claude only reads from disk. */
export const UPLOAD_LIMITS = { image: 5 * 1024 * 1024, pdf: 32 * 1024 * 1024, file: 50 * 1024 * 1024 } as const;

/** Types Claude can see as images. SVG is not one: it is text, and served inline it could run script. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

/** The type the bytes say they are, not what the name claims: an image block with the wrong type is rejected. */
export function sniffMediaType(bytes: Buffer, name: string): string {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** A name safe to use as a file name: no directories, no control characters, never empty. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || 'file';
}

/**
 * Files attached to messages, kept in the data dir rather than in any project: attaching a file must
 * not show up in a repository's `git status`. Every run is given read access to this directory.
 */
export class UploadStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'uploads');
    // Passed to every run with --add-dir, which needs it to exist
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(name: string, bytes: Buffer): Attachment {
    if (bytes.length === 0) throw new Error('the file is empty');
    const fileName = safeName(name);
    const mediaType = sniffMediaType(bytes, fileName);
    const kind: Attachment['kind'] = IMAGE_TYPES.has(mediaType) ? 'image' : mediaType === 'application/pdf' ? 'pdf' : 'file';
    const limit = UPLOAD_LIMITS[kind];
    if (bytes.length > limit) {
      throw new Error(`${fileName} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; ${kind === 'file' ? 'files' : `${kind}s`} can be at most ${limit / 1024 / 1024} MB`);
    }
    const id = randomUUID();
    const folder = join(this.dir, id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, fileName);
    writeFileSync(path, bytes, { mode: 0o600 });
    const attachment: Attachment = { id, name: fileName, mediaType, kind, sizeBytes: bytes.length, path, createdAt: new Date().toISOString() };
    writeFileSync(join(folder, 'meta.json'), JSON.stringify(attachment));
    return attachment;
  }

  get(id: string): Attachment {
    const meta = ID_RE.test(id) ? join(this.dir, id, 'meta.json') : null;
    if (!meta || !existsSync(meta)) throw new Error('upload not found');
    return JSON.parse(readFileSync(meta, 'utf8')) as Attachment;
  }

  read(id: string): { attachment: Attachment; bytes: Buffer } {
    const attachment = this.get(id);
    return { attachment, bytes: readFileSync(attachment.path) };
  }
}

/** Marks the list of attached files inside a message, so the transcript can show them as files. */
export const ATTACHED_OPEN = '<attached-files>';
export const ATTACHED_CLOSE = '</attached-files>';

/**
 * A user turn with files: images and PDFs as content blocks Claude sees directly, and a list naming
 * every file with its path, which is how Claude reaches any other kind and can reopen the rest.
 */
export function composeContent(text: string, attachments: Attachment[], read: (id: string) => Buffer): unknown[] {
  const blocks: unknown[] = [];
  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: read(a.id).toString('base64') } });
    } else if (a.kind === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: a.mediaType, data: read(a.id).toString('base64') }, title: a.name });
    }
  }
  const list = attachments.map((a) => `- ${a.name} | ${a.mediaType} | ${a.sizeBytes} bytes | ${a.path}`).join('\n');
  const note = `${ATTACHED_OPEN}\nFiles attached to this message (images and PDFs are also included above; read the others from their path):\n${list}\n${ATTACHED_CLOSE}`;
  blocks.push({ type: 'text', text: text.trim() ? `${text}\n\n${note}` : note });
  return blocks;
}
