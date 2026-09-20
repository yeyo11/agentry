import type { CliTextResult, InstalledPlugin, PluginScope } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { api, keys } from '../../api';
import { Collapsible, Select } from '../../components/controls';
import { Dialog, useConfirm } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, Skeleton, TabPanel, Tabs, Tag, useTabGroup } from '../../components/ui';
import { timeAgo } from '../../lib/format';

const SCOPES: PluginScope[] = ['user', 'project', 'local'];

const TABS = ['installed', 'browse', 'marketplaces'] as const;
type TabId = (typeof TABS)[number];

type Action = 'install' | 'uninstall' | 'enable' | 'disable';

/** Runs a plugin CLI action, reports its output and refreshes every plugin list. */
function usePluginAction() {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [lastOutput, setLastOutput] = useState<{ title: string; result: CliTextResult } | null>(null);

  const report = (title: string, result: CliTextResult) => {
    setLastOutput({ title, result });
    if (result.ok) toast.success(title, result.output.trim() || undefined);
    else toast.error(t('plugins.failed', { title }), new Error(result.output.trim() || t('plugins.cliError')));
    void queryClient.invalidateQueries({ queryKey: keys.plugins });
  };

  const mutation = useMutation({
    mutationFn: ({ action, plugin, scope }: { action: Action; plugin: string; scope?: PluginScope }) =>
      api.pluginAction(action, { plugin, scope }),
    // The title reads like the CLI subcommand that ran, so it stays untranslated
    onSuccess: (result, { action, plugin }) => report(`${action} ${plugin}`, result),
    onError: (err, { action, plugin }) => toast.error(t(`plugins.actionFailed.${action}`, { plugin }), err),
  });

  return { mutation, lastOutput, report, busyPlugin: mutation.isPending ? mutation.variables?.plugin : undefined };
}

function OutputPanel({ output }: { output: { title: string; result: CliTextResult } | null }) {
  const { t } = useTranslation(['config', 'common']);
  if (!output?.result.output.trim()) return null;
  return (
    <Collapsible
      className="fold"
      title={
        <span>
          {t('plugins.lastOutput')} · <span className="mono">{output.title}</span>{' '}
          {output.result.ok ? <Tag tone="ok">{t('plugins.ok')}</Tag> : <Tag tone="bad">{t('plugins.failedTag')}</Tag>}
        </span>
      }
    >
      <pre className="code" role="group" aria-label={t('plugins.cliOutput')} tabIndex={0}>
        {output.result.output}
      </pre>
    </Collapsible>
  );
}

function DetailsDrawer({ plugin, onClose }: { plugin: InstalledPlugin; onClose: () => void }) {
  const { t } = useTranslation(['config', 'common']);
  const { data, error, isLoading } = useQuery({
    queryKey: keys.pluginDetails(plugin.id),
    queryFn: () => api.pluginDetails(plugin.id),
    staleTime: 60_000,
  });
  return (
    <Dialog title={plugin.name} variant="drawer" onClose={onClose}>
      <dl className="kv kv-narrow">
        <dt>{t('plugins.id')}</dt>
        <dd className="mono small break">{plugin.id}</dd>
        <dt>{t('plugins.version')}</dt>
        <dd>{plugin.version ?? '—'}</dd>
        <dt>{t('scope.label')}</dt>
        <dd>{plugin.scope}</dd>
        <dt>{t('plugins.installedAt')}</dt>
        <dd>{timeAgo(plugin.installedAt)}</dd>
        <dt>{t('files.path')}</dt>
        <dd className="mono small break">{plugin.installPath ?? '—'}</dd>
      </dl>
      <h3 className="dialog-section">{t('plugins.inventory')}</h3>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={8} />
      ) : (
        <pre className="code" role="group" aria-label={t('plugins.inventory')} tabIndex={0}>
          {data?.output.trim() || t('plugins.noDetails')}
        </pre>
      )}
    </Dialog>
  );
}

function InstalledTab({ actions }: { actions: ReturnType<typeof usePluginAction> }) {
  const { t } = useTranslation(['config', 'common']);
  const confirm = useConfirm();
  const { data, error, isLoading } = useQuery({ queryKey: keys.plugins, queryFn: api.plugins });
  const [details, setDetails] = useState<InstalledPlugin | null>(null);
  const installed = data?.installed ?? [];
  const { mutation, busyPlugin } = actions;

  return (
    <Card title={installed.length ? t('plugins.installedCount', { count: installed.length }) : t('plugins.installedTitle')}>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={4} />
      ) : installed.length === 0 ? (
        <Empty title={t('plugins.noneInstalled')}>{t('plugins.noneInstalledHint')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('plugins.plugin')}</th>
                <th scope="col">{t('plugins.marketplace')}</th>
                <th scope="col">{t('plugins.version')}</th>
                <th scope="col">{t('mcp.scope')}</th>
                <th scope="col">{t('plugins.updated')}</th>
                <th scope="col">{t('plugins.enabled')}</th>
                <th scope="col">
                  <span className="sr-only">{t('mcp.actions')}</span>
                </th>
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
                        aria-label={plugin.enabled ? t('plugins.disable', { name: plugin.name }) : t('plugins.enable', { name: plugin.name })}
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
                        {busy && <span className="spinner" role="img" aria-label={t('plugins.working')} />}
                        <button type="button" className="btn btn-small" aria-label={t('plugins.detailsOf', { name: plugin.name })} onClick={() => setDetails(plugin)}>
                          {t('plugins.details')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          aria-label={t('plugins.uninstallNamed', { name: plugin.name })}
                          disabled={mutation.isPending}
                          onClick={() =>
                            void confirm({
                              title: t('plugins.uninstallTitle', { name: plugin.name }),
                              body: t('plugins.uninstallBody'),
                              confirmLabel: t('plugins.uninstall'),
                              danger: true,
                            }).then(
                              (ok) => ok && mutation.mutate({ action: 'uninstall', plugin: plugin.id, scope: plugin.scope as PluginScope }),
                            )
                          }
                        >
                          {t('plugins.uninstall')}
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
  const { t } = useTranslation(['config', 'common']);
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
      title={t('plugins.browseTitle')}
      actions={
        <div className="toolbar">
          <label className="small muted" htmlFor="install-scope">
            {t('plugins.installScope')}
          </label>
          <Select<PluginScope> id="install-scope" value={scope} onChange={setScope} options={SCOPES.map((s) => ({ value: s, label: s }))} />
        </div>
      }
    >
      <div className="search-box">
        <input
          type="search"
          value={search}
          placeholder={t('plugins.searchPlaceholder')}
          aria-label={t('plugins.search')}
          onChange={(e) => setSearch(e.target.value)}
        />
        {isFetching && <span className="spinner" role="img" aria-label={t('plugins.searching')} />}
      </div>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={6} />
      ) : plugins.length === 0 ? (
        <Empty title={t('plugins.noMatch')}>{query ? t('plugins.noMatchSearch') : t('plugins.noMatchHint')}</Empty>
      ) : (
        <>
          <ul className="list">
            {plugins.map((plugin) => {
              const busy = busyPlugin === plugin.pluginId;
              return (
                <li key={plugin.pluginId} className={`list-row ${busy ? 'row-busy' : ''}`}>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span className="strong">{plugin.name}</span>
                      {plugin.version && <span className="mono small muted">{plugin.version}</span>}
                      {plugin.installed && <Tag tone="ok">{t('plugins.installedTag')}</Tag>}
                    </div>
                    <div className="small muted">
                      {plugin.description || t('resources.noDescription')}
                    </div>
                    <div className="small muted mono">{plugin.marketplaceName}</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    aria-label={busy ? undefined : `${plugin.installed ? 'Installed' : 'Install'} ${plugin.name}`}
                    disabled={plugin.installed || mutation.isPending}
                    onClick={() => mutation.mutate({ action: 'install', plugin: plugin.pluginId, scope })}
                  >
                    {busy ? (
                      <>
                        <span className="spinner" aria-hidden /> {t('plugins.installing')}
                      </>
                    ) : plugin.installed ? (
                      t('plugins.installedButton')
                    ) : (
                      t('plugins.install')
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {plugins.length >= 100 && <p className="small muted">{t('plugins.first100')}</p>}
        </>
      )}
    </Card>
  );
}

function MarketplacesTab({ report }: { report: ReturnType<typeof usePluginAction>['report'] }) {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, isLoading } = useQuery({ queryKey: keys.plugins, queryFn: api.plugins });
  const [source, setSource] = useState('');
  const marketplaces = data?.marketplaces ?? [];
  const refreshAvailable = () => void queryClient.invalidateQueries({ queryKey: ['plugins', 'available'] });

  const add = useMutation({
    mutationFn: () => api.addMarketplace(source.trim()),
    // Like the plugin actions, these titles name the CLI subcommand that ran and stay untranslated
    onSuccess: (result) => {
      report(`add marketplace ${source.trim()}`, result);
      if (result.ok) setSource('');
      refreshAvailable();
    },
    onError: (err) => toast.error(t('plugins.addFailed'), err),
  });
  const update = useMutation({
    mutationFn: (name?: string) => api.updateMarketplaces(name),
    onSuccess: (result, name) => {
      report(name ? `update marketplace ${name}` : 'update all marketplaces', result);
      refreshAvailable();
    },
    onError: (err) => toast.error(t('plugins.updateFailed'), err),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.removeMarketplace(name),
    onSuccess: (result, name) => {
      report(`remove marketplace ${name}`, result);
      refreshAvailable();
    },
    onError: (err) => toast.error(t('plugins.removeFailed'), err),
  });
  const busy = add.isPending || update.isPending || remove.isPending;

  return (
    <Card
      title={t('plugins.tabs.marketplaces')}
      actions={
        <button type="button" className="btn btn-small" disabled={busy || marketplaces.length === 0} onClick={() => update.mutate(undefined)}>
          {update.isPending && update.variables === undefined ? (
            <>
              <span className="spinner" aria-hidden /> {t('plugins.updating')}
            </>
          ) : (
            t('plugins.updateAll')
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
          aria-label={t('plugins.sourceLabel')}
          onChange={(e) => setSource(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!source.trim() || busy}>
          {add.isPending ? (
            <>
              <span className="spinner" aria-hidden /> {t('plugins.adding')}
            </>
          ) : (
            t('plugins.addMarketplace')
          )}
        </button>
      </form>
      <p className="small muted">{t('plugins.marketplaceHint')}</p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={3} />
      ) : marketplaces.length === 0 ? (
        <Empty title={t('plugins.noMarketplaces')}>{t('plugins.noMarketplacesHint')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('mcp.name')}</th>
                <th scope="col">{t('plugins.source')}</th>
                <th scope="col">{t('plugins.location')}</th>
                <th scope="col">
                  <span className="sr-only">{t('mcp.actions')}</span>
                </th>
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
                    <td className="mono small break">
                      {marketplace.location}
                    </td>
                    <td>
                      <div className="row-actions">
                        {rowBusy && <span className="spinner" role="img" aria-label={t('plugins.working')} />}
                        <button type="button" className="btn btn-small" aria-label={t('plugins.updateNamed', { name: marketplace.name })} disabled={busy} onClick={() => update.mutate(marketplace.name)}>
                          {t('plugins.update')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          aria-label={t('plugins.removeNamed', { name: marketplace.name })}
                          disabled={busy}
                          onClick={() =>
                            void confirm({
                              title: t('plugins.removeTitle', { name: marketplace.name }),
                              body: t('plugins.removeBody'),
                              confirmLabel: t('common:actions.remove'),
                              danger: true,
                            }).then((ok) => ok && remove.mutate(marketplace.name))
                          }
                        >
                          {t('common:actions.remove')}
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
  const { t } = useTranslation(['config', 'common']);
  const [params, setParams] = useSearchParams();
  // `tab` belongs to the Settings page around this one, so the sections use their own parameter
  const tab: TabId = TABS.find((id) => id === params.get('section')) ?? 'installed';
  const actions = usePluginAction();
  const group = useTabGroup();

  return (
    <>
      <p className="small muted">{t('plugins.subtitle')}</p>
      <Tabs
        label={t('plugins.sections')}
        group={group}
        value={tab}
        tabs={TABS.map((id) => ({ id, label: t(`plugins.tabs.${id}`) }))}
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
      <TabPanel group={group} tab={tab}>
        {tab === 'installed' && <InstalledTab actions={actions} />}
        {tab === 'browse' && <BrowseTab actions={actions} />}
        {tab === 'marketplaces' && <MarketplacesTab report={actions.report} />}
      </TabPanel>
      <OutputPanel output={actions.lastOutput} />
    </>
  );
}
