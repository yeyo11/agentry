import type { EffectiveEnvironment } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, keys } from '../api';
import { timeAgo } from '../lib/format';
import { ErrorBox, Skeleton, Tag } from './ui';

const MCP_TONE: Record<string, string> = { connected: 'ok', failed: 'bad', 'needs-auth': 'warn', pending: 'muted' };

function ChipGroup({ label, items, mono = true }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <details className="env-group">
      <summary>
        <span>{label}</span>
        <span className={`count ${items.length > 0 ? 'count-on' : ''}`}>{items.length}</span>
      </summary>
      {items.length === 0 ? (
        <div className="small muted">None loaded</div>
      ) : (
        <div className="chips">
          {items.map((item) => (
            <span key={item} className={`chip chip-static ${mono ? 'mono' : ''}`} title={item}>
              <span className="ellipsis">{item}</span>
            </span>
          ))}
        </div>
      )}
    </details>
  );
}

function EnvironmentBody({ env }: { env: EffectiveEnvironment }) {
  const memory = Object.entries(env.memoryPaths);
  return (
    <div className="stack-tight">
      <div className="meta">
        <span title={env.observedAt}>observed {timeAgo(env.observedAt)}</span>
        {env.model && <span className="mono">{env.model}</span>}
        {env.cliVersion && <span>CLI {env.cliVersion}</span>}
        {env.permissionMode && <span>{env.permissionMode}</span>}
        {env.outputStyle && <span>style: {env.outputStyle}</span>}
        <Link to={`/runs/${env.runId}`}>source run</Link>
      </div>
      <details className="env-group" open={env.mcpServers.some((s) => s.status !== 'connected')}>
        <summary>
          <span>MCP servers</span>
          <span className={`count ${env.mcpServers.length > 0 ? 'count-on' : ''}`}>{env.mcpServers.length}</span>
        </summary>
        {env.mcpServers.length === 0 ? (
          <div className="small muted">None loaded</div>
        ) : (
          <div className="chips">
            {env.mcpServers.map((server) => (
              <span key={server.name} className="chip chip-static" title={server.source ? `source: ${server.source}` : undefined}>
                <span className="ellipsis">{server.name}</span> <Tag tone={MCP_TONE[server.status] ?? 'muted'}>{server.status}</Tag>
              </span>
            ))}
          </div>
        )}
      </details>
      <ChipGroup label="Tools" items={env.tools} />
      <ChipGroup label="Agents" items={env.agents} />
      <ChipGroup label="Skills" items={env.skills} />
      <ChipGroup label="Slash commands" items={env.slashCommands.map((c) => (c.startsWith('/') ? c : `/${c}`))} />
      <ChipGroup label="Plugins" items={env.plugins.map((p) => p.name)} />
      <details className="env-group">
        <summary>
          <span>Memory paths</span>
          <span className={`count ${memory.length > 0 ? 'count-on' : ''}`}>{memory.length}</span>
        </summary>
        {memory.length === 0 ? (
          <div className="small muted">None reported</div>
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
      </details>
    </div>
  );
}

/**
 * What Claude actually loaded in the latest wrapper run in `cwd`: the ground truth that the
 * configuration files only describe. `live` keeps polling while a run is in progress.
 */
export function EnvironmentPanel({ cwd, live = false }: { cwd: string; live?: boolean }) {
  const { data, error, isLoading } = useQuery({
    queryKey: keys.environments(cwd),
    queryFn: () => api.environments(cwd),
    refetchInterval: live ? 5000 : false,
    enabled: Boolean(cwd),
  });
  const env = data?.[0];

  if (isLoading) return <Skeleton rows={3} />;
  if (error) return <ErrorBox error={error} />;
  if (!env) return <div className="small muted">Start a run in this project to see what Claude loads.</div>;
  return <EnvironmentBody env={env} />;
}
