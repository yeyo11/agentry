import type { ProviderStatus } from '@agentry/shared';
import { Activity, ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { firstReady, groupProviders, nothingFound } from '../lib/first-run';
import { NARROW, useMediaQuery } from '../lib/media';
import { CLAUDE_CODE_ID, providerLink } from '../lib/provider-state';
import { useRefreshProviders } from '../lib/providers';
import { BrandMark, ICON, ICON_SM } from './icons';
import { ProviderRow } from './ProviderRow';
import { Spinner } from './Spinner';
import { Empty } from './ui';

/**
 * The first-run Providers step (docs/plans/multi-provider.md, P2): which agents Agentry found on
 * this machine, grouped by what is left to do, and the way in with the first one that is ready. It
 * stands in for the whole app, with no shell, and can always be skipped. What it reads is the
 * detector's answer, so an install or a sign-in made in a terminal appears in it on its own.
 */
export function ProvidersStep({ statuses, onFinish }: { statuses: ProviderStatus[]; onFinish: () => void }) {
  const { t } = useTranslation('providers');
  const phone = useMediaQuery(NARROW);
  const refresh = useRefreshProviders();
  const checking = refresh.isPending;
  const ready = firstReady(statuses);
  const empty = nothingFound(statuses) && !checking;
  const recheck = () => refresh.mutate();

  const head = (
    <div className="prov-first-brand">
      <BrandMark size={26} />
      <span className="prov-first-name">Agentry</span>
      <span className="grow" />
      <span className="section-label">{t('firstRun.label')}</span>
    </div>
  );

  const recheckButton = (className: string) => (
    <button type="button" className={className} onClick={recheck} disabled={checking} data-action="recheck">
      {checking ? <Spinner /> : <RefreshCw {...ICON} />}
      {t('firstRun.recheck')}
    </button>
  );
  const skip = (
    <button type="button" className="btn prov-quiet" onClick={onFinish} data-action="skip">
      {t('firstRun.skip')}
    </button>
  );

  if (empty) {
    const installLink = providerLink(CLAUDE_CODE_ID, 'install');
    const others = statuses.filter((status) => status.id !== CLAUDE_CODE_ID && providerLink(status.id, 'install'));
    return (
      <div className="prov-first-page" data-step="empty">
        <div className="prov-first">
          {head}
          <Empty
            illustration="install"
            size="md"
            title={t('firstRun.empty.title')}
            action={
              <>
                {installLink && (
                  <a className="btn btn-primary" href={installLink} target="_blank" rel="noopener noreferrer">
                    {t('firstRun.empty.install')}
                    <ExternalLink {...ICON_SM} />
                    <span className="sr-only"> ({t('row.opensNewTab')})</span>
                  </a>
                )}
                {recheckButton('btn')}
              </>
            }
          >
            {t('firstRun.empty.body')}
          </Empty>
          {others.length > 0 && (
            <div className="prov-others">
              <span className="section-label">{t('firstRun.empty.others')}</span>
              <div className="prov-others-list">
                {others.map((status) => (
                  <a key={status.id} className="prov-chip" href={providerLink(status.id, 'install') ?? undefined} target="_blank" rel="noopener noreferrer">
                    {status.label}
                    <ExternalLink {...ICON_SM} />
                    <span className="sr-only"> ({t('row.opensNewTab')})</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          <div className="prov-first-skip">{skip}</div>
        </div>
      </div>
    );
  }

  const groups = groupProviders(statuses);
  // While it re-checks, only what is not already answered is shown as being read
  const isChecking = (status: ProviderStatus) => checking && status.state !== 'ready';
  const actions = (
    <>
      <span className="prov-step-note grow" role={checking ? 'status' : undefined}>
        {checking ? <Spinner /> : <Activity {...ICON_SM} />}
        {checking ? t('firstRun.checking') : t('firstRun.watching')}
      </span>
      {recheckButton('btn prov-quiet')}
      {skip}
      {ready ? (
        <button type="button" className="btn btn-primary" onClick={onFinish} data-action="continue">
          {t('firstRun.continueWith', { name: ready.label })}
        </button>
      ) : (
        checking && (
          <button type="button" className="btn btn-primary" disabled>
            {t('firstRun.continue')}
          </button>
        )
      )}
    </>
  );

  return (
    <div className="prov-first-page" data-step="list" data-checking={checking || undefined}>
      <div className="prov-first">
        {head}
        <div className="prov-first-intro">
          <h1 className="text-display">{checking ? t('firstRun.checkingTitle') : t('firstRun.title')}</h1>
          <p>{phone ? t('firstRun.introPhone') : t('firstRun.intro')}</p>
        </div>
        {groups.map(({ group, providers }) => (
          <div key={group} className="prov-group" aria-busy={checking || undefined}>
            <div className="prov-group-head">
              <h2 className="section-label">{t(`firstRun.group.${group}`)}</h2>
              <span className="mono small muted">{providers.length}</span>
            </div>
            <section className="card prov-list">
              {providers.map((status) => (
                <ProviderRow
                  key={status.id}
                  status={status}
                  variant={phone ? 'cell' : 'row'}
                  compact
                  checking={isChecking(status)}
                  isDefault={status.id === ready?.id}
                  onRetry={recheck}
                />
              ))}
            </section>
          </div>
        ))}
        <div className={phone ? 'prov-first-foot' : 'prov-first-actions'}>{actions}</div>
      </div>
    </div>
  );
}
