import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { useFallbackInterval } from '../lib/feed';
import { timeAgo } from '../lib/format';
import { Collapsible } from './controls/Collapsible';
import { ErrorBox, Skeleton, Tag } from './ui';

const MCP_TONE: Record<string, string> = { connected: 'ok', failed: 'bad', 'needs-auth': 'warn', pending: 'muted' };

function ChipGroup({ label, items, mono = true }: { label: string; items: string[]; mono?: boolean }) {
  const { t } = useTranslation('components');
  return (
    <Collapsible
      className="env-group"
      title={
        <>
          <span>{label}</span>
          <span className={`count ${items.length > 0 ? 'count-on' : ''}`}>{items.length}</span>
        </>
      }
    >
      {items.length === 0 ? (
        <div className="small muted">{t('environment.noneLoaded')}</div>
      ) : (
        <div className="chips">
          {items.map((item) => (
            <span key={item} className={`chip chip-static ${mono ? 'mono' : ''}`} title={item}>
              <span className="ellipsis">{item}</span>
            </span>
          ))}
        </div>
      )}
    </Collapsible>
  );
}

/** What Claude loaded: a chat carries it (`Chat.environment`) and `GET /environments` serves it per directory. */
export interface LoadedEnvironment {
  observedAt: string;
  model: string | null;
  permissionMode: string | null;
  outputStyle: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: string; source?: string }>;
  agents: string[];
  skills: string[];
  slashCommands: string[];
  plugins: Array<{ name: string }>;
  memoryPaths: Record<string, string>;
  cliVersion?: string | null;
  /** The chat whose start reported it, when it is not the one being looked at */
  chatId?: string;
}

export function EnvironmentBody({ env }: { env: LoadedEnvironment }) {
  const { t } = useTranslation('components');
  const memory = Object.entries(env.memoryPaths);
  return (
    <div className="stack-tight">
      <div className="meta">
        <span title={env.observedAt}>{t('environment.observed', { time: timeAgo(env.observedAt) })}</span>
        {env.model && <span className="mono">{env.model}</span>}
        {env.cliVersion && <span>{t('environment.cliVersion', { version: env.cliVersion })}</span>}
        {env.permissionMode && <span>{env.permissionMode}</span>}
        {env.outputStyle && <span>{t('environment.style', { style: env.outputStyle })}</span>}
        {env.chatId && <Link to={`/chats/${env.chatId}`}>{t('environment.sourceChat')}</Link>}
      </div>
      <Collapsible
        className="env-group"
        defaultOpen={env.mcpServers.some((s) => s.status !== 'connected')}
        title={
          <>
            <span>{t('environment.mcpServers')}</span>
            <span className={`count ${env.mcpServers.length > 0 ? 'count-on' : ''}`}>{env.mcpServers.length}</span>
          </>
        }
      >
        {env.mcpServers.length === 0 ? (
          <div className="small muted">{t('environment.noneLoaded')}</div>
        ) : (
          <div className="chips">
            {env.mcpServers.map((server) => (
              <span key={server.name} className="chip chip-static" title={server.source ? t('environment.source', { source: server.source }) : undefined}>
                <span className="ellipsis">{server.name}</span> <Tag tone={MCP_TONE[server.status] ?? 'muted'}>{server.status}</Tag>
              </span>
            ))}
          </div>
        )}
      </Collapsible>
      <ChipGroup label={t('environment.tools')} items={env.tools} />
      <ChipGroup label={t('environment.agents')} items={env.agents} />
      <ChipGroup label={t('environment.skills')} items={env.skills} />
      <ChipGroup label={t('environment.slashCommands')} items={env.slashCommands.map((c) => (c.startsWith('/') ? c : `/${c}`))} />
      <ChipGroup label={t('environment.plugins')} items={env.plugins.map((p) => p.name)} />
      <Collapsible
        className="env-group"
        title={
          <>
            <span>{t('environment.memoryPaths')}</span>
            <span className={`count ${memory.length > 0 ? 'count-on' : ''}`}>{memory.length}</span>
          </>
        }
      >
        {memory.length === 0 ? (
          <div className="small muted">{t('environment.noneReported')}</div>
        ) : (
          <dl className="kv kv-narrow">
            {memory.map(([key, path]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{key}</dt>
                <dd className="mono small break">{path}</dd>
              </div>
            ))}
          </dl>
        )}
      </Collapsible>
    </div>
  );
}

/**
 * What Claude actually loaded in the latest chat Agentry started in `cwd`: the ground truth that the
 * configuration files only describe. `live` keeps it refreshed while a chat is in progress: the event
 * feed does it, and a slow poll stands in while the feed is down.
 */
export function EnvironmentPanel({ cwd, live = false }: { cwd: string; live?: boolean }) {
  const { t } = useTranslation('components');
  const fallback = useFallbackInterval();
  const { data, error, isLoading } = useQuery({
    queryKey: keys.environments(cwd),
    queryFn: () => api.environments(cwd),
    refetchInterval: live ? fallback : false,
    enabled: Boolean(cwd),
  });
  const env = data?.[0];

  if (isLoading) return <Skeleton rows={3} />;
  if (error) return <ErrorBox error={error} />;
  if (!env) return <div className="small muted">{t('environment.empty')}</div>;
  return <EnvironmentBody env={env} />;
}
