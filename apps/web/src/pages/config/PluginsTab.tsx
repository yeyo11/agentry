import type { CliTextResult, InstalledPlugin, PluginScope } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, keys } from '../../api';
import { Collapsible, Select } from '../../components/controls';
import { Dialog, useConfirm } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, Skeleton, Tabs, Tag } from '../../components/ui';
import { timeAgo } from '../../lib/format';

const SCOPES: PluginScope[] = ['user', 'project', 'local'];

const TABS = [
  { id: 'installed', label: 'Installed' },
  { id: 'browse', label: 'Browse' },
  { id: 'marketplaces', label: 'Marketplaces' },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Action = 'install' | 'uninstall' | 'enable' | 'disable';

/** Runs a plugin CLI action, reports its output and refreshes every plugin list. */
function usePluginAction() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [lastOutput, setLastOutput] = useState<{ title: string; result: CliTextResult } | null>(null);

  const report = (title: string, result: CliTextResult) => {
    setLastOutput({ title, result });
    if (result.ok) toast.success(title, result.output.trim() || undefined);
    else toast.error(`${title} failed`, new Error(result.output.trim() || 'The CLI reported an error'));
    void queryClient.invalidateQueries({ queryKey: keys.plugins });
  };

  const mutation = useMutation({
    mutationFn: ({ action, plugin, scope }: { action: Action; plugin: string; scope?: PluginScope }) =>
      api.pluginAction(action, { plugin, scope }),
    onSuccess: (result, { action, plugin }) => report(`${action} ${plugin}`, result),
    onError: (err, { action, plugin }) => toast.error(`Could not ${action} ${plugin}`, err),
  });

  return { mutation, lastOutput, report, busyPlugin: mutation.isPending ? mutation.variables?.plugin : undefined };
}

function OutputPanel({ output }: { output: { title: string; result: CliTextResult } | null }) {
  if (!output?.result.output.trim()) return null;
  return (
    <Collapsible
      className="fold"
      title={
        <span>
          Last CLI output · <span className="mono">{output.title}</span> {output.result.ok ? <Tag tone="ok">ok</Tag> : <Tag tone="bad">failed</Tag>}
        </span>
      }
    >
      <pre className="code">{output.result.output}</pre>
    </Collapsible>
  );
}

function DetailsDrawer({ plugin, onClose }: { plugin: InstalledPlugin; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: keys.pluginDetails(plugin.id),
    queryFn: () => api.pluginDetails(plugin.id),
    staleTime: 60_000,
  });
  return (
    <Dialog title={plugin.name} variant="drawer" onClose={onClose}>
      <dl className="kv kv-narrow">
        <dt>Id</dt>
        <dd className="mono small break">{plugin.id}</dd>
        <dt>Version</dt>
        <dd>{plugin.version ?? '—'}</dd>
        <dt>Scope</dt>
        <dd>{plugin.scope}</dd>
        <dt>Installed</dt>
        <dd>{timeAgo(plugin.installedAt)}</dd>
        <dt>Path</dt>
        <dd className="mono small break">{plugin.installPath ?? '—'}</dd>
      </dl>
      <h3 className="dialog-section">Component inventory</h3>
      <ErrorBox error={error} />
      {isLoading ? <Skeleton rows={8} /> : <pre className="code">{data?.output.trim() || 'No details reported by the CLI.'}</pre>}
    </Dialog>
  );
}

function InstalledTab({ actions }: { actions: ReturnType<typeof usePluginAction> }) {
  const confirm = useConfirm();
  const { data, error, isLoading } = useQuery({ queryKey: keys.plugins, queryFn: api.plugins });
  const [details, setDetails] = useState<InstalledPlugin | null>(null);
  const installed = data?.installed ?? [];
  const { mutation, busyPlugin } = actions;

  return (
    <Card title={`Installed plugins${installed.length ? ` (${installed.length})` : ''}`}>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={4} />
      ) : installed.length === 0 ? (
        <Empty title="No plugins installed">Plugins bundle commands, agents, skills, hooks and MCP servers. Find some in Browse.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Marketplace</th>
                <th>Version</th>
                <th>Scope</th>
                <th>Updated</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {installed.map((plugin) => {
                const busy = busyPlugin === plugin.id;
                return (
                  <tr key={`${plugin.id}:${plugin.scope}`} className={busy ? 'row-busy' : ''}>
                    <td className="strong">{plugin.name}</td>
                    <td className="mono small">{plugin.marketplace}</td>
                    <td className="mono small">{plugin.version ?? '—'}</td>
                    <td>
                      <Tag tone="info">{plugin.scope}</Tag>
                    </td>
                    <td className="small muted nowrap">{timeAgo(plugin.lastUpdated ?? plugin.installedAt)}</td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={plugin.enabled}
                        aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                        className={`switch ${plugin.enabled ? 'switch-on' : ''}`}
                        disabled={mutation.isPending}
                        onClick={() =>
                          mutation.mutate({
                            action: plugin.enabled ? 'disable' : 'enable',
                            plugin: plugin.id,
                            scope: plugin.scope as PluginScope,
                          })
                        }
                      >
                        <span className="switch-knob" />
                      </button>
                    </td>
                    <td>
                      <div className="row-actions">
                        {busy && <span className="spinner" aria-label="Working" />}
                        <button className="btn btn-small" onClick={() => setDetails(plugin)}>
                          Details
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          disabled={mutation.isPending}
                          onClick={() =>
                            void confirm({
                              title: `Uninstall ${plugin.name}?`,
                              body: 'Its commands, agents, skills, hooks and MCP servers stop being available in new sessions.',
                              confirmLabel: 'Uninstall',
                              danger: true,
                            }).then(
                              (ok) => ok && mutation.mutate({ action: 'uninstall', plugin: plugin.id, scope: plugin.scope as PluginScope }),
                            )
                          }
                        >
                          Uninstall
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {details && <DetailsDrawer plugin={details} onClose={() => setDetails(null)} />}
    </Card>
  );
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function BrowseTab({ actions }: { actions: ReturnType<typeof usePluginAction> }) {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<PluginScope>('user');
  const query = useDebounced(search.trim(), 300);
  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: keys.availablePlugins(query),
    queryFn: () => api.availablePlugins(query),
    placeholderData: (previous) => previous,
  });
  const { mutation, busyPlugin } = actions;
  const plugins = data ?? [];

  return (
    <Card
      title="Browse marketplaces"
      actions={
        <div className="toolbar">
          <label className="small muted" htmlFor="install-scope">
            Install scope
          </label>
          <Select<PluginScope> id="install-scope" value={scope} onChange={setScope} options={SCOPES.map((s) => ({ value: s, label: s }))} />
        </div>
      }
    >
      <div className="search-box">
        <input
          type="search"
          value={search}
          placeholder="Search plugins by name, description or marketplace…"
          aria-label="Search plugins"
          onChange={(e) => setSearch(e.target.value)}
        />
        {isFetching && <span className="spinner" aria-label="Searching" />}
      </div>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={6} />
      ) : plugins.length === 0 ? (
        <Empty title="No plugins match">{query ? 'Try another search, or add a marketplace.' : 'Add a marketplace to browse its plugins.'}</Empty>
      ) : (
        <>
          <div className="list">
            {plugins.map((plugin) => {
              const busy = busyPlugin === plugin.pluginId;
              return (
                <div key={plugin.pluginId} className={`list-row ${busy ? 'row-busy' : ''}`}>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span className="strong">{plugin.name}</span>
                      {plugin.version && <span className="mono small muted">{plugin.version}</span>}
                      {plugin.installed && <Tag tone="ok">installed</Tag>}
                    </div>
                    <div className="small muted" title={plugin.description}>
                      {plugin.description || 'No description'}
                    </div>
                    <div className="small muted mono">{plugin.marketplaceName}</div>
                  </div>
                  <button
                    className="btn btn-small btn-primary"
                    disabled={plugin.installed || mutation.isPending}
                    onClick={() => mutation.mutate({ action: 'install', plugin: plugin.pluginId, scope })}
                  >
                    {busy ? (
                      <>
                        <span className="spinner" /> Installing…
                      </>
                    ) : plugin.installed ? (
                      'Installed'
                    ) : (
                      'Install'
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          {plugins.length >= 100 && <p className="small muted">Showing the first 100 results. Refine the search to see more.</p>}
        </>
      )}
    </Card>
  );
}

function MarketplacesTab({ report }: { report: ReturnType<typeof usePluginAction>['report'] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, isLoading } = useQuery({ queryKey: keys.plugins, queryFn: api.plugins });
  const [source, setSource] = useState('');
  const marketplaces = data?.marketplaces ?? [];
  const refreshAvailable = () => void queryClient.invalidateQueries({ queryKey: ['plugins', 'available'] });

  const add = useMutation({
    mutationFn: () => api.addMarketplace(source.trim()),
    onSuccess: (result) => {
      report(`add marketplace ${source.trim()}`, result);
      if (result.ok) setSource('');
      refreshAvailable();
    },
    onError: (err) => toast.error('Could not add the marketplace', err),
  });
  const update = useMutation({
    mutationFn: (name?: string) => api.updateMarketplaces(name),
    onSuccess: (result, name) => {
      report(name ? `update marketplace ${name}` : 'update all marketplaces', result);
      refreshAvailable();
    },
    onError: (err) => toast.error('Could not update', err),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.removeMarketplace(name),
    onSuccess: (result, name) => {
      report(`remove marketplace ${name}`, result);
      refreshAvailable();
    },
    onError: (err) => toast.error('Could not remove the marketplace', err),
  });
  const busy = add.isPending || update.isPending || remove.isPending;

  return (
    <Card
      title="Marketplaces"
      actions={
        <button className="btn btn-small" disabled={busy || marketplaces.length === 0} onClick={() => update.mutate(undefined)}>
          {update.isPending && update.variables === undefined ? (
            <>
              <span className="spinner" /> Updating…
            </>
          ) : (
            'Update all'
          )}
        </button>
      }
    >
      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (source.trim()) add.mutate();
        }}
      >
        <input
          className="mono"
          value={source}
          placeholder="owner/repo · https://example.com/marketplace.json · /path/to/marketplace"
          aria-label="Marketplace source"
          onChange={(e) => setSource(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!source.trim() || busy}>
          {add.isPending ? (
            <>
              <span className="spinner" /> Adding…
            </>
          ) : (
            'Add marketplace'
          )}
        </button>
      </form>
      <p className="small muted">A marketplace is a catalog of plugins: a GitHub repository, a URL or a local path.</p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={3} />
      ) : marketplaces.length === 0 ? (
        <Empty title="No marketplaces configured">Add one above to start browsing plugins.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Source</th>
                <th>Location</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {marketplaces.map((marketplace) => {
                const rowBusy =
                  (update.isPending && update.variables === marketplace.name) || (remove.isPending && remove.variables === marketplace.name);
                return (
                  <tr key={marketplace.name} className={rowBusy ? 'row-busy' : ''}>
                    <td className="strong">{marketplace.name}</td>
                    <td>
                      <Tag>{marketplace.source}</Tag>
                    </td>
                    <td className="mono small break" title={marketplace.location}>
                      {marketplace.location}
                    </td>
                    <td>
                      <div className="row-actions">
                        {rowBusy && <span className="spinner" aria-label="Working" />}
                        <button className="btn btn-small" disabled={busy} onClick={() => update.mutate(marketplace.name)}>
                          Update
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          disabled={busy}
                          onClick={() =>
                            void confirm({
                              title: `Remove marketplace ${marketplace.name}?`,
                              body: 'Plugins installed from it may stop receiving updates.',
                              confirmLabel: 'Remove',
                              danger: true,
                            }).then((ok) => ok && remove.mutate(marketplace.name))
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function PluginsTab() {
  const [params, setParams] = useSearchParams();
  // `tab` belongs to the Settings page around this one, so the sections use their own parameter
  const tab: TabId = TABS.find((t) => t.id === params.get('section'))?.id ?? 'installed';
  const actions = usePluginAction();

  return (
    <>
      <p className="small muted">
        Extensions for Claude Code: commands, agents, skills, hooks and MCP servers packaged together. Actions run the CLI and can
        take up to a minute.
      </p>
      <Tabs
        label="Plugin sections"
        value={tab}
        tabs={TABS}
        onChange={(id) =>
          setParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              next.set('section', id);
              return next;
            },
            { replace: true },
          )
        }
      />
      {tab === 'installed' && <InstalledTab actions={actions} />}
      {tab === 'browse' && <BrowseTab actions={actions} />}
      {tab === 'marketplaces' && <MarketplacesTab report={actions.report} />}
      <OutputPanel output={actions.lastOutput} />
    </>
  );
}
