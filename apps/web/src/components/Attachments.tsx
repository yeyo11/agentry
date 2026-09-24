import type { Attachment } from '@agentry/shared';
import { FileText, Image as ImageIcon, Loader2, Paperclip, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { api } from '../api';
import { withToken } from '../lib/auth';
import { errorMessage, formatBytes } from '../lib/format';
import { ICON_SM } from './icons';
import { isViewable, MediaViewer, type MediaItem } from './MediaViewer';

// ---------- in the transcript ----------

export interface AttachedFile {
  name: string;
  mediaType: string;
  sizeBytes: number;
  path: string;
  /** Set when the file is still in the upload store, which is what makes it viewable */
  uploadId: string | null;
}

const ATTACHED_RE = /\n*<attached-files>\n[^\n]*\n([\s\S]*?)\n?<\/attached-files>\s*$/;
const UPLOAD_ID_RE = /\/uploads\/([0-9a-f-]{36})\//;

/**
 * Splits the list of attached files the wrapper appends to a message from what the person typed,
 * so the transcript shows the files as files and the text as they wrote it.
 */
export function splitAttached(text: string): { text: string; files: AttachedFile[] } {
  const match = ATTACHED_RE.exec(text);
  if (!match) return { text, files: [] };
  const files = (match[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^- /, '').split(' | '))
    .filter((parts) => parts.length >= 4)
    .map(([name = '', mediaType = '', size = '', ...rest]) => {
      const path = rest.join(' | ');
      return { name, mediaType, sizeBytes: Number.parseInt(size, 10) || 0, path, uploadId: UPLOAD_ID_RE.exec(path)?.[1] ?? null };
    });
  return { text: text.slice(0, match.index), files };
}

// A thumbnail and a download link are the browser's own GETs: no header, so the credential (when
// there is one) travels in the query string, which this route accepts for exactly that reason.
const contentUrl = (id: string) => withToken(`/api/uploads/${encodeURIComponent(id)}/content`);
const isViewableImage = (type: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type);

function FileChip({ name, mediaType, sizeBytes, href, onOpen, children }: { name: string; mediaType: string; sizeBytes?: number; href?: string | null; onOpen?: () => void; children?: ReactNode }) {
  const Icon = mediaType.startsWith('image/') ? ImageIcon : FileText;
  const body = (
    <>
      <Icon {...ICON_SM} aria-hidden />
      <span className="attachment-name ellipsis">{name}</span>
      {sizeBytes ? <span className="muted small">{formatBytes(sizeBytes)}</span> : null}
      {children}
    </>
  );
  // A file the page can show opens over it; anything else is still the browser's to open
  if (onOpen) {
    return (
      <button type="button" className="attachment-chip" title={name} onClick={onOpen}>
        {body}
      </button>
    );
  }
  return href ? (
    <a className="attachment-chip" href={href} target="_blank" rel="noreferrer" title={name}>
      {body}
    </a>
  ) : (
    <span className="attachment-chip" title={name}>
      {body}
    </span>
  );
}

/**
 * Files attached to a message: thumbnails for images, a chip for anything else. What the page can
 * show opens in the viewer, at the file pressed, with the message's other files beside it.
 */
export function AttachedFiles({ files }: { files: AttachedFile[] }) {
  const [open, setOpen] = useState<number | null>(null);
  // The ones the viewer can show, and where each sits in it
  const shown = useMemo<MediaItem[]>(
    () => files.flatMap((f) => (f.uploadId && isViewable(f.mediaType) ? [{ name: f.name, mediaType: f.mediaType, sizeBytes: f.sizeBytes, url: contentUrl(f.uploadId) }] : [])),
    [files],
  );
  const at = (file: AttachedFile) => (file.uploadId ? shown.findIndex((item) => item.url === contentUrl(file.uploadId as string)) : -1);
  if (files.length === 0) return null;
  return (
    <div className="attachments">
      {files.map((f, i) =>
        f.uploadId && isViewableImage(f.mediaType) ? (
          <button key={i} type="button" className="attachment-thumb" title={f.name} onClick={() => setOpen(at(f))}>
            <img src={contentUrl(f.uploadId)} alt={f.name} loading="lazy" />
          </button>
        ) : (
          <FileChip
            key={i}
            name={f.name}
            mediaType={f.mediaType}
            sizeBytes={f.sizeBytes}
            href={f.uploadId ? contentUrl(f.uploadId) : null}
            onOpen={f.uploadId && isViewable(f.mediaType) ? () => setOpen(at(f)) : undefined}
          />
        ),
      )}
      {open !== null && open >= 0 && <MediaViewer items={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** An image or PDF in a message that did not come through the wrapper, e.g. pasted into a terminal. */
export function MediaBlock({ kind, mediaType, name, uploadId }: { kind: 'image' | 'document'; mediaType: string; name?: string; uploadId?: string }) {
  const { t } = useTranslation('components');
  if (uploadId && kind === 'image' && isViewableImage(mediaType)) {
    return <AttachedFiles files={[{ name: name ?? t('attachments.image'), mediaType, sizeBytes: 0, path: '', uploadId }]} />;
  }
  return (
    <div className="attachments">
      <FileChip name={name ?? (kind === 'image' ? t('attachments.imageTitle') : t('attachments.document'))} mediaType={mediaType} href={uploadId ? contentUrl(uploadId) : null} />
    </div>
  );
}

// ---------- in the composer ----------

interface Pending {
  key: number;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  attachment?: Attachment;
  error?: string;
  preview?: string;
}

/**
 * Files being attached to the next message. Each one uploads as soon as it is added, so sending
 * does not wait on it and a file that is refused says so while it can still be removed.
 */
export function useAttachments() {
  const [items, setItems] = useState<Pending[]>([]);
  const seq = useRef(0);
  // The previews this composer made, so each is let go exactly once: on removal, on clearing, or
  // when the composer goes away with files still in it. Not in the updaters: React may run those twice.
  const previews = useRef(new Map<number, string>());

  useEffect(() => {
    const held = previews.current;
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  const add = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      const key = ++seq.current;
      const preview = isViewableImage(file.type) ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.set(key, preview);
      setItems((prev) => [...prev, { key, name: file.name || i18n.t('components:attachments.pasted'), size: file.size, status: 'uploading', preview }]);
      api
        .uploadFile(file)
        .then((attachment) => setItems((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'ready', attachment } : p))))
        .catch((err: unknown) => setItems((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'error', error: errorMessage(err) } : p))));
    }
  }, []);

  const remove = useCallback((key: number) => {
    const preview = previews.current.get(key);
    if (preview) URL.revokeObjectURL(preview);
    previews.current.delete(key);
    setItems((prev) => prev.filter((p) => p.key !== key));
  }, []);

  const clear = useCallback(() => {
    for (const url of previews.current.values()) URL.revokeObjectURL(url);
    previews.current.clear();
    setItems([]);
  }, []);

  const ids = items.filter((p) => p.status === 'ready' && p.attachment).map((p) => (p.attachment as Attachment).id);
  const uploading = items.some((p) => p.status === 'uploading');
  const failed = items.some((p) => p.status === 'error');

  /** Drop files anywhere on the composer */
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      if (e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      add(e.dataTransfer.files);
    },
  };
  /** Paste screenshots and files straight into the text box */
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length === 0) return;
    e.preventDefault();
    add(e.clipboardData.files);
  };

  return { items, ids, uploading, failed, add, remove, clear, dropProps, onPaste };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

export function AttachButton({ state, disabled, compact }: { state: AttachmentsState; disabled?: boolean; compact?: boolean }) {
  const { t } = useTranslation('components');
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={compact ? 'icon-btn composer-attach' : 'btn btn-small'}
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-label={t('attachments.attachFiles')}
        title={t('attachments.attachHint')}
      >
        <Paperclip {...ICON_SM} />
        {!compact && ` ${t('attachments.attach')}`}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) state.add(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** What is about to be sent, with a way to take each file back out. */
export function AttachmentTray({ state }: { state: AttachmentsState }) {
  const { t } = useTranslation('components');
  if (state.items.length === 0) return null;
  return (
    <div className="attachments attachments-pending" aria-live="polite">
      {state.items.map((p) => (
        <span key={p.key} className={`attachment-chip ${p.status === 'error' ? 'is-error' : ''}`} title={p.error ?? p.name}>
          {p.preview ? <img className="attachment-mini" src={p.preview} alt="" /> : <FileText {...ICON_SM} aria-hidden />}
          <span className="attachment-name ellipsis">{p.name}</span>
          {p.status === 'uploading' ? (
            <>
              <Loader2 {...ICON_SM} className="spin" />
              <span className="muted small">{t('attachments.uploading')}…</span>
            </>
          ) : p.status === 'error' ? (
            <>
              <TriangleAlert {...ICON_SM} className="attachment-error" />
              <span className="small attachment-error">{p.error}</span>
            </>
          ) : (
            <span className="muted small">{formatBytes(p.size)}</span>
          )}
          <button type="button" className="icon-btn" onClick={() => state.remove(p.key)} aria-label={t('attachments.remove', { name: p.name })}>
            <X {...ICON_SM} />
          </button>
        </span>
      ))}
    </div>
  );
}
