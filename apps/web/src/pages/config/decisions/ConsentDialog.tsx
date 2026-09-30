import type { DecisionMode, DecisionPointInfo, DecisionPreview, DecisionPointSettings, DecisionProviderId } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { Sheet } from '@agentry/ui/components/controls';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ICON } from '@agentry/ui/components/icons';
import { ErrorBox, Skeleton } from '@agentry/ui/components/ui';
import { formatBytes, formatNumber } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { approxTokens, consentProviders } from './model';

/** Where Jev runs; the dialog names it so nobody has to guess where the state goes. */
export const JEV_HOST = 'api.typesafe.ai';

/**
 * The question before a point leaves `off` (D12): the exact state it sends, how big it is and where
 * it goes. Agreeing records the consent against the state version that was shown, so a point whose
 * state changes asks again. A dialog on a desktop, a sheet on a phone.
 */
export function ConsentDialog({
  info,
  name,
  provider,
  mode,
  consent,
  onClose,
  onGranted,
}: {
  info: DecisionPointInfo;
  name: string;
  /** The provider the point will run on: what the consent covers */
  provider: DecisionProviderId;
  /** Where the point is going: shadow or active */
  mode: Exclude<DecisionMode, 'off'>;
  /** What was consented to so far, so the new consent adds to it */
  consent: DecisionPointSettings['consent'];
  onClose: () => void;
  onGranted: () => void;
}) {
  const { t } = useTranslation('decisions');
  const queryClient = useQueryClient();
  const narrow = useMediaQuery(NARROW);
  // Never cached: consenting to a preview that is out of date would be consenting to something unseen
  const preview = useQuery({ queryKey: keys.decisionPreview(info.id), queryFn: () => api.decisionPreview(info.id), gcTime: 0, staleTime: 0 });
  const grant = useMutation({
    mutationFn: (stateVersion: number) => api.putDecisionConsent(info.id, { granted: true, stateVersion, providers: consentProviders(info, consent, provider) }),
    onSuccess: (next) => {
      queryClient.setQueryData(keys.decisionSettings, next);
      void queryClient.invalidateQueries({ queryKey: keys.decisionPoints });
      onGranted();
    },
  });

  const title = t('consent.title', { mode: t(`points.modes.${mode}`).toLowerCase() });
  const leaves = provider === 'jev';
  const data = preview.data;

  const body = (
    <div className="dp-consent-body">
      <ConsentNotice leaves={leaves} />
      <ErrorBox error={preview.error ?? grant.error} />
      {preview.isPending ? (
        <Skeleton rows={4} />
      ) : (
        data && <PreviewBody data={data} leaves={leaves} />
      )}
      <span className="form-hint">{t('consent.withdraw')}</span>
    </div>
  );

  const actions = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('consent.cancel')}
      </button>
      <button type="button" className="btn btn-primary" data-autofocus disabled={!data || grant.isPending} onClick={() => data && grant.mutate(data.stateVersion)}>
        {grant.isPending ? t('consent.saving') : t('consent.agree', { mode: t(`points.modes.${mode}`).toLowerCase() })}
      </button>
    </>
  );

  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={title} description={`${info.id} · ${name}`} footer={<div className="dp-consent-actions">{actions}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={title} onClose={onClose} width={640} footer={actions}>
      <span className="dp-consent-sub">
        {info.id} · {name}
      </span>
      {body}
    </Dialog>
  );
}

/** The exact state a point sends, where it goes and how big it is: shared by the single and the bulk consent. */
export function PreviewBody({ data, leaves }: { data: DecisionPreview; leaves: boolean }) {
  const { t } = useTranslation('decisions');
  const json = JSON.stringify(data.state, null, 2);
  return (
    <>
    <div className="dp-consent-state">
      <span className="section-label">{data.source === 'last' ? t('consent.stateLast') : t('consent.stateBuilt')}</span>
      {/* Focusable so the keyboard can scroll it: the state is read in full or not at all */}
      <pre className="dp-preview" tabIndex={0} aria-label={t('consent.stateLabel')}>
        {json}
      </pre>
      {data.source === 'built' && <span className="form-hint">{t('consent.builtHint')}</span>}
    </div>
    <div className="dp-facts">
      <span className="dp-fact">
        <span>{t('consent.goesTo')}</span>
        <span>{leaves ? t('consent.goesToJev', { host: JEV_HOST }) : t('consent.goesToCli')}</span>
      </span>
      <span className="dp-fact">
        <span>{t('consent.size')}</span>
        <span>{t('consent.sizeValue', { size: formatBytes(data.bytes), tokens: formatNumber(approxTokens(data.bytes)) })}</span>
      </span>
      <span className="dp-fact">
        <span>{t('consent.version')}</span>
        <span>v{data.stateVersion}</span>
      </span>
    </div>
    </>
  );
}

/** Whether the state leaves the machine (Jev) or stays on it (the CLI): said before anything else. */
export function ConsentNotice({ leaves }: { leaves: boolean }) {
  const { t } = useTranslation('decisions');
  return (
    <div className={`alert ${leaves ? 'alert-warn' : 'alert-info'}`} role="note">
      {leaves ? <TriangleAlert className="alert-icon" {...ICON} /> : <ShieldCheck className="alert-icon" {...ICON} />}
      <div className="alert-body dp-note-card">
        <strong>{leaves ? t('consent.leavesTitle') : t('consent.staysTitle')}</strong>
        <span>{leaves ? t('consent.leavesBody', { host: JEV_HOST }) : t('consent.staysBody')}</span>
      </div>
    </div>
  );
}
