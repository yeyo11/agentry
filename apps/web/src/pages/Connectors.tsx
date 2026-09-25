import type { Connector, ConnectorAction, ConnectorKind, ConnectorsOverview } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ExternalLink, FileText, Info, Mail, Plug, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { Tooltip } from '../components/controls';
import { ICON_SM } from '../components/icons';
import { StatusDot } from '../components/motion';
import { Empty, ErrorBox, PageHeader, Skeleton, StatusBadge, Tag } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { connectorActionLabel, connectorLimitName, localized } from '../lib/server-strings';
import { useProjectScope } from '../lib/project-scope';
import '../insights.css';

const KIND_ICON: Record<ConnectorKind, LucideIcon> = { docs: FileText, gmail: Mail, calendar: CalendarDays, other: Plug };

function ConnectorStatus({ status }: { status: Connector['status'] }) {
  const { t } = useTranslation('connectors');
  if (status === 'connected') {
    return (
      <span className="connector-state">
        <StatusDot tone="ok" /> {t('status.connected')}
      </span>
    );
  }
  if (status === 'needs-auth') return <Tag tone="warn">{t('status.needsAuth')}</Tag>;
  // What the CLI does not say is shown as unknown, with the shape and the word of that status
  return <StatusBadge status="unknown" />;
}

/**
 * Authorising a connector happens in an interactive `claude` session or in claude.ai's settings:
 * there is no command that does it. The steps and links are the server's, so they stay true to what
 * the CLI actually offers.
 */
function AuthorisationSteps({ guide }: { guide: ConnectorsOverview['authorisation'] }) {
  return (
    <>
      <ol className="connector-steps">
        {guide.steps.map((step, index) => (
          <li key={step.code}>
            <span className="count">{index + 1}</span>
            <span>{localized(step)}</span>
          </li>
        ))}
      </ol>
      {guide.links.length > 0 && (
        <div className="connector-links">
          {guide.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="meta-icon">
              {localized(link.label)} <ExternalLink {...ICON_SM} />
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function ConnectorCard({
  connector,
  guide,
  pending,
  onAsk,
}: {
  connector: Connector;
  guide: ConnectorsOverview['authorisation'];
  pending: string | null;
  onAsk: (connector: Connector, action: ConnectorAction) => void;
}) {
  const { t } = useTranslation('connectors');
  const Icon = KIND_ICON[connector.kind];
  const actions = connector.actions ?? [];
  const tone = connector.status === 'connected' ? 'is-ok' : connector.status === 'needs-auth' ? 'is-warn' : 'is-muted';
  return (
    <li className={`connector-row ${tone}`}>
      <div className="connector-head">
        <span className="connector-mark" aria-hidden>
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <div className="connector-main">
          <h2 className="connector-name break">{connector.name}</h2>
          <ConnectorStatus status={connector.status} />
          {connector.detail && connector.status !== 'connected' && <span className="mono small muted break">{t('cliSays', { detail: connector.detail })}</span>}
        </div>
        {actions.length > 0 && (
          <div className="task-actions connector-actions">
            {actions.map((action) => (
              <Tooltip key={action.id} content={t('ask.hint')}>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={pending !== null}
                  onClick={() => onAsk(connector, action)}
                  aria-label={t('ask.named', { action: connectorActionLabel(action), connector: connector.name })}
                >
                  <Sparkles {...ICON_SM} /> {pending === `${connector.id}:${action.id}` ? t('ask.starting') : t('ask.try', { action: connectorActionLabel(action) })}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {connector.status === 'needs-auth' && (
        <div className="connector-body">
          <AuthorisationSteps guide={guide} />
        </div>
      )}
      {connector.status === 'connected' && actions.length === 0 && <p className="muted small connector-body">{t('ask.none')}</p>}
    </li>
  );
}

export function Connectors() {
  const { t } = useTranslation(['connectors', 'common']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = useProjectScope();
  // The CLI connects to every server to answer, which takes seconds: the server caches it for a
  // minute, and the button asks again on purpose
  const { data, error, isLoading, isFetching } = useQuery({ queryKey: keys.connectors, queryFn: () => api.connectors(), staleTime: 60_000 });
  const refresh = useMutation({
    mutationFn: () => api.connectors(true),
    onSuccess: (next) => queryClient.setQueryData(keys.connectors, next),
  });
  const ask = useMutation({
    mutationFn: ({ action }: { connector: Connector; action: ConnectorAction }) =>
      // Its permission prompts come to the panel: a connector's tools are not pre-approved
      api.createChat({ prompt: action.prompt, permissionPrompts: 'host', ...(project?.exists ? { cwd: project.path } : {}) }),
    onSuccess: (chat) => navigate(`/chats/${chat.id}`),
  });
  const pending = ask.isPending && ask.variables ? `${ask.variables.connector.id}:${ask.variables.action.id}` : null;

  const connectors = data?.connectors ?? [];
  const needsAuth = connectors.filter((c) => c.status === 'needs-auth');
  // Nothing usable and every one waiting on a person: that is the page's news, so it leads
  const allBlocked = connectors.length > 0 && needsAuth.length === connectors.length;
  // The steps are said once: inside a card that needs them, or on their own when no card shows them
  const stepsInCard = needsAuth.length > 0;

  return (
    <div className="connectors">
      <PageHeader
        title={t('title')}
        subtitle={t('intro')}
        actions={
          <>
            <span className="mono small muted connectors-checked">{data ? t('subtitle', { when: formatDateTime(data.checkedAt) }) : t('subtitleLoading')}</span>
            <button type="button" className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending || isFetching}>
              <RefreshCw {...ICON_SM} /> {refresh.isPending ? t('refreshing') : t('refresh')}
            </button>
          </>
        }
      />
      <ErrorBox error={error ?? refresh.error ?? ask.error} />

      {isLoading ? (
        <Skeleton rows={4} height={20} />
      ) : data ? (
        <div className="connectors-layout">
          <div className="connectors-main">
            {data.error && (
              <div className="alert alert-warn" role="alert">
                <div className="alert-body">
                  <div className="strong">{t('cliFailed')}</div>
                  <div className="small break">{data.error}</div>
                </div>
              </div>
            )}
            {allBlocked && !data.error && (
              <div className="card connectors-lead">
                <Empty illustration="connector" tone="warn" size="sm" title={t('blocked.title', { count: connectors.length, name: connectors[0]?.name ?? '' })}>
                  {t('blocked.body')}
                </Empty>
              </div>
            )}
            {connectors.length === 0 && !data.error ? (
              <div className="card connectors-lead">
                <Empty illustration="connector" size="sm" title={t('none')}>
                  {t('noneHint')}
                </Empty>
              </div>
            ) : (
              connectors.length > 0 && (
                <ul className="lrows connectors-list">
                  {connectors.map((connector) => (
                    <ConnectorCard key={connector.id} connector={connector} guide={data.authorisation} pending={pending} onAsk={(c, action) => ask.mutate({ connector: c, action })} />
                  ))}
                </ul>
              )
            )}
            {!stepsInCard && !data.error && (connectors.length === 0 || data.notListed.length > 0) && (
              <section className="card connector-guide">
                <h2 className="connector-name">{t('authorise.title')}</h2>
                <AuthorisationSteps guide={data.authorisation} />
              </section>
            )}
            {data.notListed.length > 0 && !data.error && (
              <div className="alert connectors-callout" role="note">
                <Info size={16} strokeWidth={1.75} aria-hidden className="alert-icon" />
                <div className="alert-body">
                  {t('notListed', { kinds: data.notListed.map((kind) => t(`kinds.${kind}`)).join(', ') })}
                  {stepsInCard && ` ${t('notListedSame')}`}
                </div>
              </div>
            )}
          </div>

          <aside className="connectors-side" aria-labelledby="connectors-unavailable">
            <h2 id="connectors-unavailable" className="connectors-side-title">
              {t('unavailable.title')}
            </h2>
            <p className="small muted">{t('unavailable.intro')}</p>
            <ul className="connectors-limits">
              {data.unavailable.map((item) => (
                <li key={item.id} className="connectors-limit">
                  <span className="strong">{connectorLimitName(item)}</span>
                  <span className="muted small">{localized(item.reason)}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
