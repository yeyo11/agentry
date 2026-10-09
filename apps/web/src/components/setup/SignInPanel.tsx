import type { LoginMethod, LoginSession, SetupToolMethods } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { Clock, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Sheet } from '@agentry/ui/components/controls';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { CopyButton, ErrorBox, Segmented, Skeleton } from '@agentry/ui/components/ui';
import {
  CODEX_DEVICE_SETTINGS,
  failureOf,
  installLink,
  isPanelTool,
  keyLink,
  loginMethods,
  methodsOf,
  offersChoice,
  refusedKey,
  timeLeft,
  VIA_LABEL,
  variableChoices,
  variableLabel,
  type LoginFailure,
  type PanelTool,
} from '../../lib/setup';
import { useLogin } from './useLogin';

export type PanelLayout = 'inline' | 'sheet' | 'card';

export interface SignInPanelProps {
  tool: PanelTool;
  /** The tool's name as the row shows it ("Codex", "GitLab") */
  label: string;
  /** `gh` and `glab`: the host to start with; an empty string asks the person for one */
  host?: string | null;
  /**
   * `inline` opens under a row (`.prov-bin.signin-panel`), `sheet` fills a Sheet on a phone, and `card`
   * stays open on Settings → Account, where it is the form itself and has nothing to close.
   */
  layout?: PanelLayout;
  /**
   * A `card` that was opened by a button and can be put away again (Settings → Remote access) offers
   * Cancel like the other layouts; Settings → Account's card is the form itself and has none
   */
  closable?: boolean;
  onClose: () => void;
}

/**
 * The one sign-in panel (docs/design-system.md, "Setup"): the same in Settings → Providers,
 * Settings → Integrations, Settings → Account and the setup assistant, so nothing is assistant-only.
 * It offers what the vendor documents for the tool (`GET /setup`'s methods): a write-only key, and a
 * device code where there is one. A key never goes anywhere but the request that starts the sign-in.
 */
export function SignInPanel(props: SignInPanelProps) {
  const { t } = useTranslation('setup');
  const setup = useQuery({ queryKey: keys.setup, queryFn: ({ signal }) => api.setup({ signal }) });
  const methods = methodsOf(setup.data, props.tool);
  if (!methods) {
    return (
      <PanelFrame {...props} choice={null}>
        {setup.error ? <ErrorBox error={setup.error} title={t('panel.startFailed')} /> : <Skeleton rows={2} height={18} />}
      </PanelFrame>
    );
  }
  return <Panel {...props} methods={methods} sealed={setup.data?.secrets.sealed ?? false} />;
}

function Panel({ tool, label, host = null, layout = 'inline', closable = false, onClose, methods, sealed }: SignInPanelProps & { methods: SetupToolMethods; sealed: boolean }) {
  const { t } = useTranslation('setup');
  const toast = useToast();
  const choices = loginMethods(methods);
  const [method, setMethod] = useState<LoginMethod>(choices[0] ?? 'key');
  const [hostDraft, setHostDraft] = useState(host ?? methods.defaultHost ?? '');
  const onSucceeded = useCallback(() => {
    if (layout === 'card') toast.success(t('panel.signedIn', { label }));
    else onClose();
  }, [layout, label, onClose, t, toast]);
  const closes = layout !== 'card' || closable;
  const login = useLogin({ onSucceeded, onCancelled: closes ? onClose : () => undefined });
  const { session } = login;
  const failure = failureOf(session);
  const hostName = hostDraft.trim();
  // Copilot's Code is gh's sign-in to the host Copilot uses: the panel names who is really asked for a code
  const via = methods.deviceVia;
  const viaLabel = via ? (VIA_LABEL[via.tool] ?? via.tool) : null;

  const startDevice = useCallback(() => {
    login.start({ tool, method: 'device', ...(methods.needsHost ? { host: hostName } : {}) });
  }, [login, tool, methods.needsHost, hostName]);

  // An agent's code is asked for as soon as the panel opens on Code: opening it is the person asking.
  // A host CLI waits for its host to be named first.
  const asked = useRef(false);
  useEffect(() => {
    if (method !== 'device' || methods.needsHost || asked.current || session !== null || login.starting) return;
    asked.current = true;
    startDevice();
  }, [method, methods.needsHost, session, login.starting, startDevice]);

  // A panel that closes while its code waits stops the CLI, instead of leaving it waiting for nobody
  const live = useRef<{ id: string; live: boolean } | null>(null);
  live.current = session ? { id: session.id, live: login.live } : null;
  useEffect(
    () => () => {
      if (live.current?.live) void api.cancelLogin(live.current.id).catch(() => undefined);
    },
    [],
  );

  const choose = (next: LoginMethod) => {
    if (next === method) return;
    if (login.live) login.cancel();
    else login.reset();
    asked.current = false;
    setMethod(next);
  };

  const choice = offersChoice(methods) ? (
    <Segmented
      label={t('panel.method')}
      value={method}
      onChange={choose}
      className={layout === 'sheet' ? 'signin-choice wide' : 'signin-choice'}
      // Tailscale's sign-in is a link with no code, so it is named for what the person gets
      options={choices.map((value) => ({ value, label: tool === 'tailscale' && value === 'device' ? t('panel.methods.link') : t(`panel.methods.${value}`) }))}
    />
  ) : null;

  const cancelButton = closes && (
    <button type="button" className={layout === 'sheet' ? 'btn' : 'btn prov-quiet'} onClick={() => (login.live ? login.cancel() : onClose())}>
      {t('panel.cancel')}
    </button>
  );

  let body: ReactNode;
  let actions: ReactNode;
  if (failure && session) {
    body = <FailureNote failure={failure} label={label} />;
    actions = (
      <>
        <FailureAction
          failure={failure}
          tool={isPanelTool(session.tool) ? session.tool : tool}
          primary={layout === 'sheet'}
          onRetry={() => (session.method === 'device' ? startDevice() : login.reset())}
          onUseKey={() => choose('key')}
        />
        {cancelButton}
      </>
    );
  } else if (method === 'device') {
    // Until the CLI shows its code the panel says it is asking; a host CLI first asks for its host
    const askingHost = methods.needsHost && session === null && !login.starting;
    body = (
      <>
        {tool === 'codex' && <CodexNote />}
        {via && viaLabel && <p className="signin-note">{t('panel.viaNote', { label, via: viaLabel, cli: via.tool, host: via.host ?? '' })}</p>}
        {session?.state === 'waiting-for-person' && session.url ? (
          <DeviceCode session={session} label={label} />
        ) : askingHost ? (
          <HostField label={label} value={hostDraft} example={methods.defaultHost} onChange={setHostDraft} />
        ) : (
          <div className="signin-wait signin-starting" role="status">
            <Spinner />
            {/* Tailscale's sign-in is a link to open, with no code */}
            {tool === 'tailscale' ? t('panel.startingLink', { label }) : t('panel.starting', { label: viaLabel ?? label })}
          </div>
        )}
        <ErrorBox error={login.startError} title={t('panel.startFailed')} />
      </>
    );
    actions = (
      <>
        {askingHost && (
          <button type="button" className={layout === 'sheet' ? 'btn btn-primary' : 'btn'} disabled={hostName === ''} onClick={startDevice}>
            {t('panel.getCode')}
          </button>
        )}
        {cancelButton}
      </>
    );
  } else {
    return (
      <PanelFrame tool={tool} label={label} layout={layout} onClose={onClose} choice={choice}>
        <KeyForm
          tool={tool}
          label={label}
          methods={methods}
          sealed={sealed}
          layout={layout}
          host={hostDraft}
          onHost={setHostDraft}
          busy={login.starting}
          error={login.startError}
          onSubmit={(secret, variable) =>
            login.start({
              tool,
              method: 'key',
              secret,
              ...(methods.needsHost ? { host: hostName } : {}),
              ...(variable ? { variable } : {}),
            })
          }
          cancel={cancelButton}
        />
      </PanelFrame>
    );
  }

  return (
    <PanelFrame tool={tool} label={label} layout={layout} onClose={onClose} choice={choice}>
      {body}
      <div className={layout === 'sheet' ? 'prov-sheet-actions' : 'signin-actions'}>{actions}</div>
    </PanelFrame>
  );
}

/** The panel's box: under the row on a desktop, the body of a Sheet on a phone, or a card's content. */
function PanelFrame({ label, layout = 'inline', choice, children }: Pick<SignInPanelProps, 'tool' | 'label' | 'layout' | 'onClose'> & { choice: ReactNode; children: ReactNode }) {
  const { t } = useTranslation('setup');
  const title = t('panel.title', { label });
  if (layout === 'sheet') {
    return (
      <div className="prov-sheet-body signin-sheet-body">
        {choice}
        {children}
      </div>
    );
  }
  if (layout === 'card') {
    return (
      <div className="signin-card-body" role="group" aria-label={title}>
        {choice && <div className="signin-panel-head">{choice}</div>}
        {children}
      </div>
    );
  }
  return (
    <div className="prov-bin signin-panel" role="group" aria-label={title}>
      <div className="signin-panel-head">
        <span className="section-label grow">{title}</span>
        {choice}
      </div>
      {children}
    </div>
  );
}

/** The panel as a Sheet, for a phone: the same pieces, its own title, the one primary being its action. */
export function SignInSheet(props: Omit<SignInPanelProps, 'layout'>) {
  const { t } = useTranslation('setup');
  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()} title={t('panel.title', { label: props.label })} className="prov-sheet signin-sheet">
      <SignInPanel {...props} layout="sheet" />
    </Sheet>
  );
}

function ExternalText({ href, children, className = 'c-accent signin-link' }: { href: string; children: ReactNode; className?: string }) {
  const { t } = useTranslation('setup');
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink {...ICON_SM} />
      <span className="sr-only"> ({t('panel.opensNewTab')})</span>
    </a>
  );
}

function CodexNote() {
  const { t } = useTranslation('setup');
  return (
    <>
      <p className="signin-note">{t('panel.codexNote')}</p>
      <ExternalText href={CODEX_DEVICE_SETTINGS}>{t('panel.codexLink')}</ExternalText>
    </>
  );
}

function HostField({ label, value, example, onChange }: { label: string; value: string; example: string | null; onChange: (value: string) => void }) {
  const { t } = useTranslation('setup');
  return (
    <label className="field field-mono">
      <span className="field-label">{t('panel.host')}</span>
      <input
        className="mono"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        inputMode="url"
        placeholder={example ?? ''}
        aria-label={t('panel.hostAria', { label })}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** Ticks once a second while a code waits, so "expires in" counts down; nothing else on the panel moves. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * A code waiting for the person: where to go, the code large in mono with Copy, and the braille
 * spinner beside "Waiting for you to approve". Its box carries the energy border: it is the screen's
 * one live surface while it waits. A sign-in with no code (Tailscale's login URL) shows the link
 * with Copy in the code's place, since opening it on another device is the whole of it.
 */
export function DeviceCode({ session, label }: { session: LoginSession; label: string }) {
  const { t } = useTranslation('setup');
  const now = useNow(true);
  const url = session.url ?? '';
  const code = session.code ?? '';
  if (!code) {
    return (
      <div className="signin-device live-energy" role="group" aria-label={t('panel.linkAria', { label })}>
        <ol className="signin-steps">
          <li>
            <span className="n">1</span>
            <span>{t('panel.openLink')}</span>
          </li>
          <li>
            <span className="n">2</span>
            <span>{t('panel.approveLink')}</span>
          </li>
        </ol>
        <div className="signin-code-box">
          <ExternalText href={url} className="signin-url">
            {url.replace(/^https:\/\//, '')}
          </ExternalText>
          <CopyButton text={url} label={t('panel.copyLink')} shown />
        </div>
        <div className="signin-wait">
          <Spinner />
          <span role="status">{t('panel.waiting')}</span>
          <span className="left">{t('panel.expiresIn', { left: timeLeft(session.expiresAt, now) })}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="signin-device live-energy" role="group" aria-label={t('panel.codeAria', { label })}>
      <ol className="signin-steps">
        <li>
          <span className="n">1</span>
          <span>
            {t('panel.open')}{' '}
            <ExternalText href={url} className="signin-url">
              {url.replace(/^https:\/\//, '')}
            </ExternalText>
          </span>
        </li>
        <li>
          <span className="n">2</span>
          <span>{t('panel.type')}</span>
        </li>
      </ol>
      <div className="signin-code-box">
        <span className="signin-code" data-testid="signin-code">
          {code}
        </span>
        <CopyButton text={code} label={t('panel.copyCode')} shown />
      </div>
      <div className="signin-wait">
        <Spinner />
        <span role="status">{t('panel.waiting')}</span>
        <span className="left">{t('panel.expiresIn', { left: timeLeft(session.expiresAt, now) })}</span>
      </div>
    </div>
  );
}

function FailureNote({ failure, label }: { failure: LoginFailure; label: string }) {
  const { t } = useTranslation('setup');
  const Icon = failure.tone === 'warn' ? Clock : TriangleAlert;
  return (
    <div className={`signin-result${failure.tone === 'warn' ? ' warn' : ''}`} role="alert" data-code={failure.code}>
      <Icon {...ICON} className="ico" />
      <div className="signin-result-text">
        <span>{t(`panel.fail.${failure.code}`, { label })}</span>
        <span className="mono">{failure.code}</span>
      </div>
    </div>
  );
}

function FailureAction({
  failure,
  tool,
  primary,
  onRetry,
  onUseKey,
}: {
  failure: LoginFailure;
  tool: PanelTool;
  primary: boolean;
  onRetry: () => void;
  onUseKey: () => void;
}) {
  const { t } = useTranslation('setup');
  const cls = primary ? 'btn btn-primary' : 'btn';
  const words = t(`panel.action.${failure.action}`);
  switch (failure.action) {
    case 'install': {
      const href = installLink(tool);
      return href ? (
        <ExternalText href={href} className={cls}>
          {words}
        </ExternalText>
      ) : null;
    }
    case 'use-key':
      return (
        <button type="button" className={cls} onClick={onUseKey}>
          {words}
        </button>
      );
    case 'retry':
    case 'new-code':
      return (
        <button type="button" className={cls} onClick={onRetry} data-action={failure.action}>
          <RefreshCw {...ICON_SM} />
          {words}
        </button>
      );
  }
}

/**
 * The key: a write-only field (never prefilled, cleared once sent), where to make one, and where it
 * goes. A tool whose key may go in several variables chooses one first.
 */
function KeyForm({
  tool,
  label,
  methods,
  sealed,
  layout,
  host,
  onHost,
  busy,
  error,
  onSubmit,
  cancel,
}: {
  tool: PanelTool;
  label: string;
  methods: SetupToolMethods;
  sealed: boolean;
  layout: PanelLayout;
  host: string;
  onHost: (host: string) => void;
  busy: boolean;
  error: unknown;
  onSubmit: (secret: string, variable: string | null) => void;
  cancel: ReactNode;
}) {
  const { t } = useTranslation('setup');
  const variables = variableChoices(methods);
  const [variable, setVariable] = useState<string>(variables[0] ?? methods.variables[0] ?? '');
  const [secret, setSecret] = useState('');
  const typed = secret.trim();
  const refused = refusedKey(tool, typed);
  const canSave = typed !== '' && refused === null && (!methods.needsHost || host.trim() !== '') && !busy;
  const claudeApiKey = tool === 'claude-code' && variable === 'ANTHROPIC_API_KEY';
  const link = keyLink(tool, host);

  const fieldLabel =
    tool === 'claude-code'
      ? t(`panel.variables.${claudeApiKey ? 'apiKey' : 'oauthToken'}`)
      : tool === 'opencode'
        ? variable
        : t(`panel.field.${tool}`);
  const placeholder =
    tool === 'claude-code'
      ? claudeApiKey
        ? 'sk-ant-api03-…'
        : 'sk-ant-oat01-…'
      : tool === 'tailscale'
        ? 'tskey-auth-…'
        : tool === 'copilot'
          ? 'github_pat_…'
          : methods.key === 'stdin'
          ? t('panel.pasteToken')
          : t('panel.pasteKey');
  const kept = t(sealed ? 'panel.hint.envSealed' : 'panel.hint.envPlain', { label });
  const hint =
    tool === 'opencode'
      ? t('panel.hint.opencode')
      : tool === 'copilot'
        ? `${t('panel.hint.copilot')} ${kept}`
        : methods.key === 'env'
          ? kept
          : t(`panel.hint.${tool as 'codex' | 'gh' | 'glab' | 'tailscale'}`);

  const submit = () => {
    if (!canSave) return;
    onSubmit(typed, methods.key === 'env' && variable ? variable : null);
    setSecret('');
  };

  return (
    <form
      className="signin-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {variables.length > 0 && (
        <Segmented
          label={tool === 'claude-code' ? t('panel.variable') : t('panel.variableProvider')}
          value={variable}
          onChange={setVariable}
          className={layout === 'sheet' ? 'signin-choice wide' : 'signin-choice'}
          options={variables.map((value) => {
            const shown = variableLabel(tool, value);
            return { value, label: shown.kind === 'copy' ? t(`panel.variables.${shown.key}`) : shown.name };
          })}
        />
      )}
      {tool === 'claude-code' && (
        <p className="signin-note">
          {claudeApiKey ? t('panel.claudeApiKey') : <Trans t={t} i18nKey="panel.claude" components={{ b: <strong />, code: <code /> }} />}
        </p>
      )}
      {tool === 'claude-code' && link && <ExternalText href={link}>{t('panel.link.claude-code')}</ExternalText>}
      {methods.needsHost && <HostField label={label} value={host} example={methods.defaultHost} onChange={onHost} />}
      <label className={`field field-mono${tool === 'opencode' ? ' field-variable' : ''}`}>
        <span className="field-label">{fieldLabel}</span>
        <input
          className="mono"
          type="password"
          value={secret}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={placeholder}
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      {tool !== 'claude-code' && link && (
        <ExternalText href={link}>{t(`panel.link.${tool as 'codex' | 'gemini' | 'copilot' | 'gh' | 'glab' | 'tailscale'}`, { host: host.trim() || methods.defaultHost || '' })}</ExternalText>
      )}
      {refused ? (
        <span className="field-error" role="alert">
          {t(`panel.refused.${refused}`)}
        </span>
      ) : (
        <span className="form-hint">{hint}</span>
      )}
      <ErrorBox error={error} title={t('panel.startFailed')} />
      <div className={layout === 'sheet' ? 'prov-sheet-actions' : 'signin-actions'}>
        <button type="submit" className={layout === 'sheet' ? 'btn btn-primary' : 'btn'} disabled={!canSave}>
          {busy && <Spinner />}
          {busy ? t('panel.saving') : t('panel.save')}
        </button>
        {cancel}
      </div>
    </form>
  );
}
