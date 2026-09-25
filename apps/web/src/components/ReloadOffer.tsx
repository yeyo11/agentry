import { RefreshCw, X } from 'lucide-react';
import { lazy, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { dismissReloadOffer, isChunkLoadError, noticeStaleChunk, reloadApp, useReloadOffer } from '../lib/reload';
import { ICON, ICON_SM } from './icons';
import { Empty } from './ui';

function ReloadButton() {
  const { t } = useTranslation('shell');
  const [reloading, setReloading] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-primary btn-small"
      disabled={reloading}
      onClick={() => {
        setReloading(true);
        void reloadApp();
      }}
    >
      {reloading ? <span className="spinner" aria-hidden /> : <RefreshCw {...ICON_SM} />}
      {reloading ? t('reload.reloading') : t('reload.action')}
    </button>
  );
}

/**
 * The offer to reload once the server runs another build. It sits above the page and blocks
 * nothing: whoever is halfway through a message finishes it first.
 */
export function ReloadBanner() {
  const { t } = useTranslation('shell');
  const offer = useReloadOffer();
  if (!offer) return null;
  return (
    <div className="alert alert-info reload-banner" role="status" data-testid="reload-banner">
      <RefreshCw className="alert-icon" {...ICON_SM} />
      <span className="alert-body reload-banner-text">
        {offer.reason === 'updated' ? t('reload.updated', { version: offer.version }) : t('reload.stale')}
      </span>
      <ReloadButton />
      <button type="button" className="icon-btn" aria-label={t('reload.dismiss')} onClick={dismissReloadOffer}>
        <X {...ICON} />
      </button>
    </div>
  );
}

/** What a route whose code is gone shows instead of an error: the same way out as the banner. */
function StalePage() {
  const { t } = useTranslation('shell');
  return (
    <Empty icon={RefreshCw} title={t('reload.stalePage')} action={<ReloadButton />}>
      {t('reload.stalePageHint')}
    </Empty>
  );
}

/**
 * `React.lazy`, for code that may have been deployed away. A chunk the server no longer has raises
 * the reload offer and renders `fallback` (a page that says so) instead of taking the app down with
 * it; any other failure is thrown as before.
 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ComponentType<P> = StalePage) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch (error) {
      if (!isChunkLoadError(error)) throw error;
      noticeStaleChunk();
      return { default: fallback };
    }
  });
}
