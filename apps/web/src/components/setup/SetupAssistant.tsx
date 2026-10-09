import type { AuthConfig, AuthMode, CodeHostId, CodeHostStatus, SetupState, TrackerStatus } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ExternalLink, RefreshCw, Shield } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { Sheet } from '@agentry/ui/components/controls';
import { ProgramMark } from '@agentry/ui/components/BrandMark';
import { BrandMark, ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Illustration } from '@agentry/ui/components/illustrations';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { Empty, ErrorBox, Segmented, Skeleton, Tag } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { getToken } from '../../lib/auth';
import { useEventFeed } from '../../lib/events';
import { nothingFound } from '../../lib/first-run';
import { CLAUDE_CODE_ID, providerLink } from '../../lib/provider-state';
import { useProviders, useRefreshProviders } from '../../lib/providers';
import {
  advance,
  agentsReady,
  codeReady,
  hostTool,
  retreat,
  SETUP_STEPS,
  START,
  stepMarks,
  summaryRows,
  type SetupStep,
  type SummaryRow,
  type WizardState,
} from '../../lib/setup';
import { ProviderRow } from '../ProviderRow';
import { HostRow, TrackerRow, trackerReasonText } from '../../pages/config/integrations/rows';
import { OwnTokenForm, RevealedToken, useTokenActions } from '../../pages/config/security/token';
import { YoutrackAccess } from '../../pages/config/YoutrackAccess';
import { useProviderSignIn } from './provider-sign-in';
import { SecretsCallout } from './SecretsCard';
import { SignInPanel, SignInSheet } from './SignInPanel';
import { TailscaleRow } from './TailscaleRow';

/** Where each Settings tab of the summary is */
const WHERE: Record<SummaryRow['where'], string> = {
  security: '/settings?tab=security',
  providers: '/settings?tab=providers',
  integrations: '/settings?tab=integrations',
  remote: '/settings?tab=remote',
};

/**
 * The setup assistant (docs/plans/in-app-setup.md): on a first start it stands in for the whole app,
 * with no shell, and walks through Access, Agents, Code and work items, and Done. Every step can be
 * skipped, and every step is the same panel Settings shows, so what it sets up stays editable there.
 * It ends with Start (or Skip setup), which records it as seen: it never comes back.
 */
export function SetupAssistant({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation('setup');
  const phone = useMediaQuery(NARROW);
  // The shell is not mounted yet, and the sign-ins move through the event feed
  useEventFeed();
  const [wizard, setWizard] = useState<WizardState>(START);
  const setup = useQuery({ queryKey: keys.setup, queryFn: ({ signal }) => api.setup({ signal }) });
  const at = SETUP_STEPS.indexOf(wizard.step) + 1;
  const name = t(`steps.${wizard.step}`);

  const go = (next: WizardState) => {
    setWizard(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="prov-first-page setup-page" data-setup-step={wizard.step}>
      <main className="prov-first setup">
        <div className="prov-first-brand">
          <BrandMark size={26} />
          <span className="prov-first-name">Agentry</span>
          <span className="grow" />
          <span className="section-label">{phone ? t('labelPhone', { n: at, total: SETUP_STEPS.length, name }) : t('label', { n: at, total: SETUP_STEPS.length })}</span>
          {/* On a phone the header has room for the step's name only; Skip on each step gets there too */}
          {wizard.step !== 'done' && !phone && (
            <button type="button" className="btn prov-quiet btn-small" data-action="skip-all" onClick={onFinish}>
              {t('skipAll')}
            </button>
          )}
        </div>
        <StepBar wizard={wizard} bare={phone} />
        {!setup.data ? (
          setup.error ? <ErrorBox error={setup.error} /> : <Skeleton rows={4} />
        ) : wizard.step === 'access' ? (
          <AccessStep setup={setup.data} phone={phone} />
        ) : wizard.step === 'agents' ? (
          <AgentsStep phone={phone} />
        ) : wizard.step === 'code' ? (
          <CodeStep phone={phone} />
        ) : (
          <DoneStep setup={setup.data} skipped={wizard.skipped} phone={phone} onLeave={onFinish} />
        )}
        <Foot wizard={wizard} phone={phone} onBack={() => go(retreat(wizard))} onSkip={() => go(advance(wizard, true))} onContinue={() => go(advance(wizard))} onFinish={onFinish} />
      </main>
    </div>
  );
}

/** The step bar. On a phone only the bars show: the names stay for screen readers, and the header names the step. */
function StepBar({ wizard, bare }: { wizard: WizardState; bare: boolean }) {
  const { t } = useTranslation('setup');
  return (
    <ol className={`setup-steps${bare ? ' setup-steps-bare' : ''}`} aria-label={t('steps.aria')}>
      {stepMarks(wizard).map(({ step, mark }, i) => (
        <li key={step} className={`setup-step is-${mark}`} aria-current={mark === 'current' ? 'step' : undefined} data-step={step}>
          <span className="setup-step-name">
            {mark === 'done' ? <Check {...ICON_SM} /> : <span className="n">{i + 1}</span>}
            {t(`steps.${step}`)}
          </span>
          {mark === 'skipped' && <span className="setup-step-skip">{t('steps.skipped')}</span>}
        </li>
      ))}
    </ol>
  );
}

function useReadyNote(step: SetupStep): string | null {
  const { t } = useTranslation('setup');
  const providers = useProviders();
  const hosts = useQuery({ queryKey: keys.hosts, queryFn: () => api.hosts(), enabled: step === 'code' });
  const trackers = useQuery({ queryKey: keys.trackers, queryFn: () => api.trackers(), enabled: step === 'code' });
  if (step === 'access') return t('foot.later');
  if (step === 'agents' && providers.data) {
    const { ready, total } = agentsReady(providers.data.filter((status) => status.reason !== 'disabled'));
    return total > 0 ? t('foot.ready', { count: ready, total }) : null;
  }
  if (step === 'code' && hosts.data) {
    const youtrack = trackers.data?.find((s) => s.id === 'youtrack');
    const { ready, total } = codeReady(hosts.data, youtrack?.state === 'ready');
    return t('foot.ready', { count: ready, total });
  }
  return null;
}

/**
 * Back, the step's count, Skip and Continue; Done has Back and Start. Continue is the screen's one
 * primary (with the logo, its two gradient surfaces), on a phone full width with the rest under it.
 */
function Foot({
  wizard,
  phone,
  onBack,
  onSkip,
  onContinue,
  onFinish,
}: {
  wizard: WizardState;
  phone: boolean;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
  onFinish: () => void;
}) {
  const { t } = useTranslation('setup');
  const note = useReadyNote(wizard.step);
  const first = wizard.step === SETUP_STEPS[0];
  const last = wizard.step === 'done';
  const back = !first && (
    <button type="button" className="btn prov-quiet" data-action="back" onClick={onBack}>
      <ChevronLeft {...ICON} />
      {t('foot.back')}
    </button>
  );
  const skip = !last && (
    <button type="button" className="btn prov-quiet" data-action="skip" onClick={onSkip}>
      {t('foot.skip')}
    </button>
  );
  const primary = last ? (
    <button type="button" className="btn btn-primary" data-action="start" onClick={onFinish}>
      {t('foot.start')}
    </button>
  ) : (
    <button type="button" className="btn btn-primary" data-action="continue" onClick={onContinue}>
      {t('foot.continue')}
    </button>
  );

  if (phone) {
    return (
      <div className="prov-first-foot setup-m-foot">
        {primary}
        {(back || skip) && (
          <div className="setup-m-foot-row">
            {back}
            {skip}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="setup-foot">
      {back}
      {note && <span className="prov-step-note">{note}</span>}
      <span className="grow" />
      {skip}
      {primary}
    </div>
  );
}

function Intro({ title, text }: { title: string; text: string }) {
  return (
    <div className="prov-first-intro">
      <h1 className="text-display">{title}</h1>
      <p>{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------- Access

const SETUP_MODES: AuthMode[] = ['none', 'token'];

/**
 * Step 1: who may open Agentry, and from where. The mode (None or Token) and the token shown once,
 * from the same pieces as Settings → Security; OIDC and the read-only mode stay there. Turning Token
 * on makes a token first when this browser holds none, so the step can never lock the person out.
 * Below it, Tailscale, which Remote access goes through: signed in here where Agentry runs it (the
 * Docker image), shown as it stands where it is the machine's own, and left out where the deploy
 * offers no tunnel or the machine has no Tailscale.
 */
function AccessStep({ setup, phone }: { setup: SetupState; phone: boolean }) {
  const { t } = useTranslation(['setup', 'config']);
  const auth = useQuery({ queryKey: keys.securityAuth, queryFn: ({ signal }) => api.securityAuth({ signal }) });
  const [tailscaleOpen, setTailscaleOpen] = useState(false);
  const mode = auth.data?.mode ?? setup.access.mode;
  const tailscale = setup.tailscale;
  const showTailscale = tailscale.enabled && (tailscale.managed || tailscale.state !== 'missing');
  return (
    <>
      <Intro title={t('setup:access.title')} text={phone ? t('setup:access.introPhone') : t(`setup:access.intro.${mode}`)} />
      {auth.data ? <AccessCard auth={auth.data} /> : auth.error ? <ErrorBox error={auth.error} /> : <Skeleton rows={3} />}
      {showTailscale && (
        <section className="card prov-list" aria-label={t('setup:remote.aria')}>
          <TailscaleRow summary={tailscale} phone={phone} open={tailscaleOpen} onToggle={setTailscaleOpen} />
        </section>
      )}
      {!phone && <SecretsCallout secrets={setup.secrets} />}
    </>
  );
}

function AccessCard({ auth }: { auth: AuthConfig }) {
  const { t } = useTranslation(['setup', 'config']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const token = useTokenActions(auth);
  const [own, setOwn] = useState(false);
  const update = useMutation({
    mutationFn: api.updateSecurityAuth,
    onSuccess: (config) => {
      queryClient.setQueryData(keys.securityAuth, config);
      void queryClient.invalidateQueries({ queryKey: keys.setup });
    },
    onError: (err) => toast.error(t('config:security.saveFailed'), err),
  });
  const busy = token.busy || update.isPending;

  const choose = async (mode: AuthMode) => {
    if (mode === auth.mode) return;
    // This browser has to hold the token before the guard asks for it
    if (mode === 'token' && (!auth.tokenSet || !getToken())) {
      const made = await token.set.mutateAsync(undefined).catch(() => null);
      if (!made) return;
    }
    update.mutate({ mode });
  };

  return (
    <section className="card setup-access" aria-labelledby="setup-access-title">
      <div className="setup-card-head">
        <Shield {...ICON} className="muted" />
        <h2 id="setup-access-title" className="grow">
          {t('setup:steps.access')}
        </h2>
        <Tag tone={auth.mode === 'none' ? 'warn' : 'ok'}>{t(`config:security.access.modes.${auth.mode}.tag`)}</Tag>
      </div>
      {auth.mode === 'oidc' ? (
        <p className="small muted">{t('setup:access.oidc')}</p>
      ) : (
        <>
          <Segmented
            label={t('config:security.access.modeLabel')}
            value={auth.mode}
            onChange={(mode) => void choose(mode)}
            disabled={busy || auth.readOnly}
            options={SETUP_MODES.map((value) => ({ value, label: t(`config:security.access.modes.${value}.label`) }))}
          />
          <p className="small muted">{t('setup:access.body')}</p>
          {auth.readOnly && <p className="small muted">{t('setup:access.readOnly')}</p>}
          <RevealedToken boxed body={t('setup:access.shownOnceBody')} />
          {!auth.readOnly && (
            <div className="form-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void token.generate()}>
                {busy && <Spinner />}
                {auth.tokenSet ? t('setup:access.generateAnother') : t('config:security.token.generate')}
              </button>
              <button type="button" className="btn prov-quiet" disabled={busy || own} onClick={() => setOwn(true)}>
                {t('config:security.token.own')}
              </button>
            </div>
          )}
          {own && <OwnTokenForm primary={false} busy={busy} onSave={(value) => token.set.mutate(value, { onSuccess: () => setOwn(false) })} onCancel={() => setOwn(false)} />}
        </>
      )}
      <span className="form-hint">{t('setup:access.more')}</span>
    </section>
  );
}

// ---------------------------------------------------------------- Agents

/** Step 2: every agent's row, with Sign in where it is signed out; the panel under the row (a Sheet on a phone). */
function AgentsStep({ phone }: { phone: boolean }) {
  const { t } = useTranslation(['setup', 'providers']);
  const providers = useProviders();
  const refresh = useRefreshProviders();
  const signIn = useProviderSignIn();
  const intro = <Intro title={t('setup:agents.title')} text={phone ? t('setup:agents.introPhone') : t('setup:agents.intro')} />;

  if (providers.error) return <>{intro}<ErrorBox error={providers.error} /></>;
  if (!providers.data) {
    return (
      <>
        {intro}
        <section className="card prov-list" aria-busy>
          <Skeleton rows={5} />
        </section>
      </>
    );
  }
  // A provider switched off in Settings is not offered here: it is not even looked for
  const statuses = providers.data.filter((status) => status.reason !== 'disabled');
  if (nothingFound(statuses) && !refresh.isPending) return <NothingFound onRecheck={() => refresh.mutate()} checking={refresh.isPending} />;

  return (
    <>
      {intro}
      <section className="card prov-list" aria-label={t('setup:agents.aria')}>
        {statuses.map((status) => (
          <div key={status.id} className="prov-item">
            <ProviderRow
              status={status}
              variant={phone ? 'cell' : 'row'}
              compact
              checking={refresh.isPending && status.state !== 'ready'}
              onRetry={() => refresh.mutate()}
              {...signIn.rowProps(status)}
            />
            {!phone && signIn.inline(status)}
          </div>
        ))}
      </section>
      {phone && signIn.sheet(statuses)}
    </>
  );
}

/** No agent on the machine: the Install page of the first choice, and the others as chips (the first run's empty state). */
function NothingFound({ onRecheck, checking }: { onRecheck: () => void; checking: boolean }) {
  const { t } = useTranslation('providers');
  const install = providerLink(CLAUDE_CODE_ID, 'install');
  return (
    <Empty
      illustration="install"
      size="md"
      title={t('firstRun.empty.title')}
      action={
        <>
          {install && (
            <a className="btn" href={install} target="_blank" rel="noopener noreferrer">
              {t('firstRun.empty.install')}
              <ExternalLink {...ICON_SM} />
              <span className="sr-only"> ({t('row.opensNewTab')})</span>
            </a>
          )}
          <button type="button" className="btn prov-quiet" onClick={onRecheck} disabled={checking} data-action="recheck">
            {checking ? <Spinner /> : <RefreshCw {...ICON_SM} />}
            {t('firstRun.recheck')}
          </button>
        </>
      }
    >
      {t('firstRun.empty.body')}
    </Empty>
  );
}

// ---------------------------------------------------------------- Code and work items

/** Step 3: GitHub and GitLab with their sign-in panel, per host, and YouTrack with its access form. */
function CodeStep({ phone }: { phone: boolean }) {
  const { t } = useTranslation(['setup', 'integrations']);
  const { t: tIntegrations } = useTranslation('integrations');
  const queryClient = useQueryClient();
  const hosts = useQuery({ queryKey: keys.hosts, queryFn: () => api.hosts() });
  const trackers = useQuery({ queryKey: keys.trackers, queryFn: () => api.trackers() });
  const refresh = useMutation({
    mutationFn: () => Promise.all([api.refreshHosts(), api.refreshTrackers()]),
    onSuccess: ([freshHosts, freshTrackers]) => {
      queryClient.setQueryData(keys.hosts, freshHosts);
      queryClient.setQueryData(keys.trackers, freshTrackers);
    },
  });
  const [signInOf, setSignInOf] = useState<{ id: CodeHostId; host: string | null } | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const intro = <Intro title={t('setup:code.title')} text={phone ? t('setup:code.introPhone') : t('setup:code.intro')} />;

  const failed = hosts.error ?? trackers.error;
  if (failed) return <>{intro}<ErrorBox error={failed} /></>;
  if (!hosts.data || !trackers.data) {
    return (
      <>
        {intro}
        <section className="card prov-list" aria-busy>
          <Skeleton rows={3} />
        </section>
      </>
    );
  }
  const youtrack = trackers.data.find((s): s is TrackerStatus => s.id === 'youtrack');
  const openHost: CodeHostStatus | undefined = signInOf ? hosts.data.find((s) => s.id === signInOf.id) : undefined;
  const reasonOf = (fresh: TrackerStatus, address: string) => trackerReasonText(tIntegrations, fresh, address);

  return (
    <>
      {intro}
      <section className="card prov-list" aria-label={t('setup:code.aria')}>
        {hosts.data.map((status) => (
          <HostRow
            key={status.id}
            status={status}
            enabled
            variant={phone ? 'cell' : 'row'}
            open={signInOf?.id === status.id}
            checking={refresh.isPending}
            onRetry={() => refresh.mutate()}
            onSignIn={(host) => {
              setAccessOpen(false);
              setSignInOf((now) => (now?.id === status.id && now.host === host ? null : { id: status.id, host }));
            }}
            panel={
              !phone && signInOf?.id === status.id ? (
                <SignInPanel key={`${status.id}:${signInOf.host ?? ''}`} tool={hostTool(status.id)} label={status.label} host={signInOf.host} onClose={() => setSignInOf(null)} />
              ) : null
            }
          />
        ))}
        {youtrack && (
          <TrackerRow
            status={youtrack}
            enabled
            variant={phone ? 'cell' : 'row'}
            open={accessOpen}
            accessOpen={accessOpen}
            checking={refresh.isPending}
            onRetry={() => refresh.mutate()}
            onConnect={() => {
              setSignInOf(null);
              setAccessOpen((now) => !now);
            }}
            panel={!phone && accessOpen ? <YoutrackAccess onDone={() => setAccessOpen(false)} reasonOf={reasonOf} /> : null}
          />
        )}
      </section>
      {phone && signInOf && openHost && (
        <SignInSheet key={`${openHost.id}:${signInOf.host ?? ''}`} tool={hostTool(openHost.id)} label={openHost.label} host={signInOf.host} onClose={() => setSignInOf(null)} />
      )}
      {phone && accessOpen && (
        <Sheet open onOpenChange={(next) => !next && setAccessOpen(false)} title={t('integrations:tracker.credentials.title')} className="prov-sheet">
          <YoutrackAccess sheet onDone={() => setAccessOpen(false)} reasonOf={reasonOf} />
        </Sheet>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Done

/** Step 4: what is ready, what was skipped, and where each is changed. The one screen with an illustration. */
function DoneStep({ setup, skipped, phone, onLeave }: { setup: SetupState; skipped: SetupStep[]; phone: boolean; onLeave: () => void }) {
  const { t } = useTranslation(['setup', 'providers', 'config']);
  const providers = useProviders();
  const hosts = useQuery({ queryKey: keys.hosts, queryFn: () => api.hosts() });
  const trackers = useQuery({ queryKey: keys.trackers, queryFn: () => api.trackers() });
  const access = useQuery({ queryKey: keys.youtrackCredentials, queryFn: ({ signal }) => api.youtrackCredentials({ signal }) });
  const youtrack = trackers.data?.find((s) => s.id === 'youtrack');
  const rows = summaryRows({
    access: setup.access,
    providers: (providers.data ?? []).filter((status) => status.reason !== 'disabled'),
    hosts: hosts.data ?? [],
    youtrack: youtrack ? { state: youtrack.state, host: access.data?.host ?? null, user: youtrack.user ?? null } : null,
    tailscale: setup.tailscale,
    skipped,
  });

  const detail = (row: SummaryRow): string => {
    if (row.kind === 'access') return t(`config:security.access.modes.${row.detail as AuthMode}.label`);
    if (row.badge === 'ready') return row.host && row.detail ? t('setup:done.onHost', { user: row.detail, host: row.host }) : (row.detail ?? '');
    return row.kind === 'youtrack' || row.kind === 'tailscale' ? t('setup:done.notConnected') : t('setup:done.noAccount');
  };
  const badge = (row: SummaryRow): ReactNode => {
    switch (row.badge) {
      case 'ready':
        return <Tag tone="ok">{t('providers:state.ready')}</Tag>;
      case 'signed-out':
        return <Tag tone="warn">{t('providers:state.signed-out')}</Tag>;
      case 'skipped':
        return <Tag>{t('setup:done.skipped')}</Tag>;
      case 'open':
        return <Tag>{t('setup:done.open')}</Tag>;
    }
  };

  return (
    <>
      <div className={phone ? 'setup-done-head phone' : 'setup-done-head'}>
        <Illustration name="welcome" size={phone ? 'sm' : 'md'} />
        <div className="prov-first-intro">
          <h1 className="text-display">{t('setup:done.title')}</h1>
          <p>{phone ? t('setup:done.introPhone') : t('setup:done.intro')}</p>
        </div>
      </div>
      <section className="card prov-list" aria-label={t('setup:done.aria')}>
        {rows.map((row) => (
          <div key={row.id} className="setup-sum-row" data-tool={row.id}>
            {row.kind === 'access' ? (
              <span className="setup-sum-ico">
                <Shield {...ICON} />
              </span>
            ) : (
              <ProgramMark id={row.id} label={row.label} />
            )}
            <span className="setup-sum-text">
              <span className="setup-sum-name">{row.kind === 'access' ? t('setup:done.access') : row.label}</span>
              <span className="setup-sum-detail ellipsis">{detail(row)}</span>
            </span>
            {badge(row)}
            <Link className="setup-where" to={WHERE[row.where]} onClick={onLeave}>
              {t(`setup:done.where.${row.where}`)}
            </Link>
          </div>
        ))}
      </section>
    </>
  );
}
