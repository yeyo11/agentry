import type { Connector, ConnectorAction, ConnectorKind, ConnectorsOverview } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ExternalLink, FileText, Mail, MessageSquarePlus, Plug, RefreshCw, ShieldQuestion, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys } from '../api';
import { ICON_SM } from '../components/icons';
import { Card, Empty, ErrorBox, PageHeader, Skeleton, StatusBadge, Tag } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useProjectScope } from '../lib/project-scope';

const KIND_ICON: Record<ConnectorKind, LucideIcon> = { docs: FileText, gmail: Mail, calendar: CalendarDays, other: Plug };

function ConnectorStatus({ status }: { status: Connector['status'] }) {
  const { t } = useTranslation('connectors');
  if (status === 'connected') return <Tag tone="ok">{t('status.connected')}</Tag>;
  if (status === 'needs-auth') return <Tag tone="warn">{t('status.needsAuth')}</Tag>;
  // What the CLI does not say is shown as unknown, with the shape and the word of that status
  return <StatusBadge status="unknown" />;
}

/**
 * Authorising a connector happens in an interactive `claude` session or in claude.ai's settings:
 * there is no command that does it. The steps and links are the server's, so they stay true to what
 * the CLI actually offers.
 */
function Authorisation({ guide }: { guide: ConnectorsOverview['authorisation'] }) {
  const { t } = useTranslation('connectors');
  return (
    <div className="stack-tight">
      <div className="strong small">{t('authorise.title')}</div>
      <ol className="small">
        {guide.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="meta">
        {guide.links.map((link) => (
          <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="meta-icon">
            <ExternalLink {...ICON_SM} /> {link.label}
          </a>
        ))}
      </div>
    </div>
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
  return (
    <Card
      title={
        <span className="title-icon">
          <Icon {...ICON_SM} /> <span className="break">{connector.name}</span>
        </span>
      }
      actions={<ConnectorStatus status={connector.status} />}
    >
      {connector.detail && <p className="muted small break">{t('cliSays', { detail: connector.detail })}</p>}
      {actions.length > 0 && (
        <div className="stack-tight">
          <div className="strong small">{t('ask.title')}</div>
          <div className="task-actions">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="btn btn-small"
                disabled={pending !== null}
                onClick={() => onAsk(connector, action)}
                aria-label={t('ask.named', { action: action.label, connector: connector.name })}
              >
                <MessageSquarePlus {...ICON_SM} /> {pending === `${connector.id}:${action.id}` ? t('ask.starting') : action.label}
              </button>
            ))}
          </div>
          <p className="muted small">{t('ask.hint')}</p>
        </div>
      )}
      {connector.status === 'needs-auth' && <Authorisation guide={guide} />}
      {connector.status === 'connected' && actions.length === 0 && <p className="muted small">{t('ask.none')}</p>}
    </Card>
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

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={data ? t('subtitle', { when: formatDateTime(data.checkedAt) }) : t('subtitleLoading')}
        actions={
          <button type="button" className="btn btn-small" onClick={() => refresh.mutate()} disabled={refresh.isPending || isFetching}>
            <RefreshCw {...ICON_SM} /> {refresh.isPending ? t('refreshing') : t('refresh')}
          </button>
        }
      />
      <p className="muted small">{t('intro')}</p>
      <ErrorBox error={error ?? refresh.error ?? ask.error} />

      {isLoading ? (
        <Skeleton rows={4} height={20} />
      ) : data ? (
        <>
          {data.error && (
            <div className="alert alert-warn" role="alert">
              <div className="alert-body">
                <div className="strong">{t('cliFailed')}</div>
                <div className="small break">{data.error}</div>
              </div>
            </div>
          )}
          {data.connectors.length === 0 && !data.error ? (
            <Empty icon={Plug} title={t('none')}>
              {t('noneHint')}
            </Empty>
          ) : (
            <div className="grid-2">
              {data.connectors.map((connector) => (
                <ConnectorCard key={connector.id} connector={connector} guide={data.authorisation} pending={pending} onAsk={(c, action) => ask.mutate({ connector: c, action })} />
              ))}
            </div>
          )}
          {data.notListed.length > 0 && !data.error && (
            <p className="muted small">{t('notListed', { kinds: data.notListed.map((kind) => t(`kinds.${kind}`)).join(', ') })}</p>
          )}
          {(data.connectors.length === 0 || data.notListed.length > 0) && !data.error && <Authorisation guide={data.authorisation} />}

          <Card
            title={
              <span className="title-icon">
                <ShieldQuestion {...ICON_SM} /> {t('unavailable.title')}
              </span>
            }
          >
            <p className="small">{t('unavailable.intro')}</p>
            <ul className="list">
              {data.unavailable.map((item) => (
                <li key={item.id} className="stack-tight">
                  <span className="strong small">{item.name}</span>
                  <span className="muted small">{item.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
    </>
  );
}
