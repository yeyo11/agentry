import type { CswapInfo } from '@agentry/shared';
import { Download, ExternalLink, RotateCw, TriangleAlert } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { Empty } from '@agentry/ui/components/ui';
import { cswapInstalling, cswapView } from '../../lib/cswap';

export const CSWAP_URL = 'https://github.com/realiti4/claude-swap';

/** The step Agentry's install is on, beside the braille spinner; `role="status"` reads it out as it moves. */
function InstallProgress({ cswap }: { cswap: CswapInfo }) {
  const { t } = useTranslation('accountsConfig');
  return (
    <span className="meta-icon cswap-progress" role="status">
      <Spinner />
      {cswap.managed.step === 'uv' ? t('cswap.downloadingUv') : t('cswap.installingCswap')}
    </span>
  );
}

function GuideLink({ primary }: { primary: boolean }) {
  const { t } = useTranslation('accountsConfig');
  return (
    <a className={primary ? 'btn btn-primary' : 'btn'} href={CSWAP_URL} target="_blank" rel="noreferrer">
      <ExternalLink {...ICON_SM} /> {t('page.installGuide')}
    </a>
  );
}

/**
 * The page without a claude-swap: the offer to install Agentry's own copy, its progress, why it
 * failed, or (where Agentry does not install it) the guide.
 */
export function CswapMissing({ cswap, onInstall, starting }: { cswap: CswapInfo; onInstall: () => void; starting: boolean }) {
  const { t } = useTranslation(['accountsConfig', 'config']);
  const view = cswapView(cswap);
  const hint = (
    <Trans
      t={t}
      i18nKey="config:accounts.notInstalledHint"
      components={{
        anchor: <a href={CSWAP_URL} target="_blank" rel="noreferrer" />,
        code: <code className="mono" />,
      }}
    />
  );

  if (view === 'failed') {
    return (
      <Empty
        illustration="cli-missing"
        tone="bad"
        title={t('cswap.failed')}
        action={
          <>
            <button type="button" className="btn btn-primary" onClick={onInstall} disabled={starting}>
              <RotateCw {...ICON_SM} /> {t('cswap.retry')}
            </button>
            <GuideLink primary={false} />
          </>
        }
      >
        {cswap.managed.error && <div className="mono small muted break">{cswap.managed.error}</div>}
      </Empty>
    );
  }

  if (view === 'offer' || view === 'installing') {
    return (
      <Empty
        illustration="cli-missing"
        tone="warn"
        title={t('config:accounts.notInstalled')}
        action={
          view === 'installing' ? (
            <InstallProgress cswap={cswap} />
          ) : (
            <>
              <button type="button" className="btn btn-primary" onClick={onInstall} disabled={starting}>
                <Download {...ICON_SM} /> {t('cswap.activate')}
              </button>
              <GuideLink primary={false} />
            </>
          )
        }
      >
        {hint} {t('cswap.activateHint')}
      </Empty>
    );
  }

  return (
    <Empty illustration="cli-missing" tone="warn" title={t('config:accounts.notInstalled')} action={<GuideLink primary />}>
      {hint}
      {cswap.error && <div className="muted small">{cswap.error}</div>}
    </Empty>
  );
}

/**
 * Above the accounts when the claude-swap in use is not the version Agentry parses, and while
 * Agentry's copy replaces it. Warn, with its icon and its words.
 */
export function CswapNotice({ cswap, onInstall, starting }: { cswap: CswapInfo; onInstall: () => void; starting: boolean }) {
  const { t } = useTranslation('accountsConfig');
  const installing = cswapInstalling(cswap);
  const failed = cswap.managed.state === 'failed';
  if (cswap.compatible && !installing) return null;
  const version = cswap.version ?? '';
  return (
    <div className={`alert ${failed && !installing ? 'alert-bad' : 'alert-warn'} cswap-notice`} data-testid="cswap-notice">
      <TriangleAlert {...ICON_SM} className="alert-icon" aria-hidden />
      <div className="alert-body">
        {!cswap.compatible && <span>{t('cswap.incompatible', { version, pinned: cswap.pinned })}</span>}
        {installing ? (
          <InstallProgress cswap={cswap} />
        ) : failed ? (
          <>
            <strong>{t('cswap.failed')}</strong>
            {cswap.managed.error && <span className="mono small muted break">{cswap.managed.error}</span>}
          </>
        ) : null}
        {!installing &&
          (cswap.managed.available ? (
            <button type="button" className="btn btn-small" onClick={onInstall} disabled={starting}>
              {failed ? <RotateCw {...ICON_SM} /> : <Download {...ICON_SM} />} {failed ? t('cswap.retry') : t('cswap.useManaged')}
            </button>
          ) : (
            <span className="small">{t('cswap.installPinned', { pinned: cswap.pinned })}</span>
          ))}
      </div>
    </div>
  );
}
