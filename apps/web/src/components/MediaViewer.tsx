/**
 * The files of a message, looked at without leaving it.
 *
 * A thumbnail used to be a link: pressing it handed the raw file to a new browser tab, which loses
 * the conversation, the other files of the message and any way back on a phone. Here they open over
 * the page — the image fitted to the window, the rest of the message's files an arrow away — and
 * the tab and the download are still offered, for when that is what was wanted.
 */
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '../lib/format';
import { ICON, ICON_SM } from './icons';

export interface MediaItem {
  name: string;
  mediaType: string;
  sizeBytes?: number;
  /** Where the file is served from, credential included */
  url: string;
}

const isImage = (type: string) => type.startsWith('image/');
const isPdf = (type: string) => type === 'application/pdf';

/** Whether this file has anything to show beyond its name: what makes a thumbnail worth pressing. */
export const isViewable = (type: string): boolean => isImage(type) || isPdf(type);

function Body({ item }: { item: MediaItem }): ReactNode {
  const { t } = useTranslation('components');
  if (isImage(item.mediaType)) return <img className="viewer-image" src={item.url} alt={item.name} />;
  if (isPdf(item.mediaType)) return <iframe className="viewer-pdf" src={item.url} title={item.name} />;
  return <p className="viewer-plain">{t('viewer.noPreview')}</p>;
}

export function MediaViewer({ items, index, onIndex, onClose }: { items: MediaItem[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const { t } = useTranslation('components');
  const panel = useRef<HTMLDivElement>(null);
  const item = items[index];
  const many = items.length > 1;
  const step = useCallback((by: number) => onIndex((index + by + items.length) % items.length), [index, items.length, onIndex]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      } else if (many && event.key === 'ArrowRight') {
        step(1);
      } else if (many && event.key === 'ArrowLeft') {
        step(-1);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [many, onClose, step]);

  if (!item) return null;
  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label={item.name} onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="viewer-bar">
        <span className="viewer-name ellipsis" title={item.name}>
          {item.name}
        </span>
        {item.sizeBytes ? <span className="viewer-size">{formatBytes(item.sizeBytes)}</span> : null}
        {many && <span className="viewer-count">{t('viewer.count', { n: index + 1, total: items.length })}</span>}
        <a className="icon-btn" href={item.url} download={item.name} aria-label={t('viewer.download')} title={t('viewer.download')}>
          <Download {...ICON_SM} />
        </a>
        <a className="icon-btn" href={item.url} target="_blank" rel="noreferrer" aria-label={t('viewer.openTab')} title={t('viewer.openTab')}>
          <ExternalLink {...ICON_SM} />
        </a>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('viewer.close')} title={t('viewer.close')}>
          <X {...ICON} />
        </button>
      </div>
      {/* Focusable so the arrows reach it straight away, and so Escape has somewhere to come from */}
      <div className="viewer-stage" ref={panel} tabIndex={-1}>
        {many && (
          <button type="button" className="viewer-step is-back" onClick={() => step(-1)} aria-label={t('viewer.previous')}>
            <ChevronLeft {...ICON} />
          </button>
        )}
        <Body item={item} />
        {many && (
          <button type="button" className="viewer-step is-next" onClick={() => step(1)} aria-label={t('viewer.next')}>
            <ChevronRight {...ICON} />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
