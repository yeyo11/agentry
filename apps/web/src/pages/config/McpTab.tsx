import { CircleCheck, CircleHelp, CircleX, Plus, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { McpHealthStatus, McpScope, McpServerEntry, McpServerHealth } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, type Scope } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { Select, Switch } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON_SM } from '../../components/icons';
import { KeyValueEditor, recordToRows, rowsToRecord, StringListEditor, type KeyValueRow } from '../../components/editors';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, Field, Segmented, Skeleton, Tag } from '../../components/ui';
import { useDirty } from '../../lib/dirty';
import { isObject, parseObject, stringList } from './settingsModel';

type Transport = 'stdio' | 'http' | 'sse';

interface ServerForm {
  name: string;
  scope: McpScope;
  transport: Transport;
  command: string;
  args: string[];
  env: KeyValueRow[];
  url: string;
  headers: KeyValueRow[];
  /** Keys the form has no control for; merged back untouched */
  extra: Record<string, unknown>;
}

const TRANSPORTS = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
] as const;

// Each scope's hint lives in the `config` locale under mcp.scopeHints
const SCOPE_TONE: Record<McpScope, string> = {
  user: 'info',
  project: 'idle',
  local: 'warn',
};

// The state is an icon and its words, never a coloured dot alone
const HEALTH_ICON: Record<McpHealthStatus, { icon: LucideIcon; tone: string }> = {
  connected: { icon: CircleCheck, tone: 'text-ok' },
  failed: { icon: CircleX, tone: 'text-bad' },
  'needs-auth': { icon: TriangleAlert, tone: 'text-warn' },
  pending: { icon: TriangleAlert, tone: 'text-warn' },
  unknown: { icon: CircleHelp, tone: '' },
};

function HealthIcon({ status }: { status: McpHealthStatus }) {
  const { icon: Icon, tone } = HEALTH_ICON[status];
  return <Icon className={tone} {...ICON_SM} />;
}

function emptyForm(scope: McpScope): ServerForm {
  return { name: '', scope, transport: 'stdio', command: '', args: [], env: [], url: '', headers: [], extra: {} };
}

function formFromEntry(entry: McpServerEntry): ServerForm {
  const { type, command, args, env, url, headers, ...extra } = entry.config;
  const transport: Transport = type === 'http' || type === 'sse' ? type : typeof url === 'string' && !command ? 'http' : 'stdio';
  return {
    name: entry.name,
    scope: entry.scope,
    transport,
    command: typeof command === 'string' ? command : '',
    args: stringList(args),
    env: recordToRows(env),
    url: typeof url === 'string' ? url : '',
    headers: recordToRows(headers),
    extra,
  };
}

function configFromForm(form: ServerForm): Record<string, unknown> {
  if (form.transport === 'stdio') {
    const config: Record<string, unknown> = { ...form.extra, type: 'stdio', command: form.command.trim() };
    if (form.args.length > 0) config.args = form.args;
    if (form.env.some((r) => r.key.trim())) config.env = rowsToRecord(form.env);
    return config;
  }
  const config: Record<string, unknown> = { ...form.extra, type: form.transport, url: form.url.trim() };
  if (form.headers.some((r) => r.key.trim())) config.headers = rowsToRecord(form.headers);
  return config;
}

function target(config: Record<string, unknown>): string {
  if (typeof config.url === 'string') return config.url;
  return [config.command, ...stringList(config.args)].filter((p) => typeof p === 'string').join(' ');
}

function ServerEditor({
  scope,
  initial,
  isNew,
  existingNames,
  onClose,
}: {
  scope: Scope;
  initial: ServerForm;
  isNew: boolean;
  existingNames: Set<string>;
  onClose: () => void;
}) {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState('');
  const [touched, setTouched] = useState(false);
  useDirty('mcp', touched);

  const patch = (next: Partial<ServerForm>) => {
    setForm((f) => ({ ...f, ...next }));
    setTouched(true);
  };
  const parsedJson = advanced ? parseObject(json) : null;
  const config = advanced ? parsedJson?.value ?? null : configFromForm(form);
  const nameValid = /^[\w.-]{1,64}$/.test(form.name);
  const clash = isNew && existingNames.has(`${form.scope}:${form.name}`);
  const complete = advanced
    ? Boolean(config)
    : form.transport === 'stdio'
      ? Boolean(form.command.trim())
      : /^https?:\/\//.test(form.url.trim());

  const save = useMutation({
    mutationFn: () => {
      if (!config) throw new Error(parsedJson?.error ?? t('mcp.invalidConfig'));
      return api.putMcpServer(scope, form.name, config, form.scope);
    },
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp(scope) });
      toast.success(t('mcp.saved', { name: entry.name }), t('mcp.scopeName', { scope: entry.scope }));
      onClose();
    },
    onError: (err) => toast.error(t('mcp.saveFailed'), err),
  });

  const toggleAdvanced = () => {
    if (!advanced) {
      setJson(JSON.stringify(configFromForm(form), null, 2));
      setAdvanced(true);
      return;
    }
    if (!parsedJson?.value) {
      toast.error(t('settings.fixFirst'), new Error(parsedJson?.error ?? t('settings.invalidJson')));
      return;
    }
    setForm((f) => ({ ...formFromEntry({ name: f.name, scope: f.scope, config: parsedJson.value as Record<string, unknown> }) }));
    setAdvanced(false);
  };

  return (
    <Card
      title={isNew ? t('mcp.newServer') : t('mcp.editServer', { name: initial.name })}
      actions={
        <Switch checked={advanced} onChange={toggleAdvanced}>
          {t('mcp.advanced')}
        </Switch>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameValid && complete && !clash) save.mutate();
        }}
      >
        <div className="form-grid">
          <Field label={t('mcp.name')} hint={clash ? undefined : t('mcp.nameHint')}>
            <input
              className={`mono ${form.name && (!nameValid || clash) ? 'is-invalid' : ''}`}
              value={form.name}
              disabled={!isNew}
              placeholder="my-server"
              onChange={(e) => patch({ name: e.target.value.trim() })}
            />
            {clash && <span className="field-hint text-err">{t('mcp.clash', { scope: form.scope })}</span>}
          </Field>
          <Field label={t('scope.label')} hint={t(`mcp.scopeHints.${form.scope}`)}>
            <Select<McpScope>
              value={form.scope}
              disabled={!isNew}
              onChange={(value) => patch({ scope: value })}
              options={
                scope.projectId
                  ? [
                      { value: 'project', label: t('mcp.projectOption') },
                      { value: 'local', label: t('mcp.localOption') },
                    ]
                  : [{ value: 'user', label: 'user' }]
              }
            />
          </Field>
        </div>

        {advanced ? (
          <>
            <CodeEditor
              language="json"
              ariaLabel={t('mcp.json')}
              minHeight="220px"
              invalid={Boolean(parsedJson?.error)}
              value={json}
              onChange={(next) => {
                setJson(next);
                setTouched(true);
              }}
            />
            {parsedJson?.error && (
              <div className="alert alert-warn" role="alert">
                {t('settings.invalidJsonDetail', { error: parsedJson.error })}
              </div>
            )}
          </>
        ) : (
          <>
            <Field label={t('mcp.transport')}>
              <Segmented
                label={t('mcp.transport')}
                value={form.transport}
                options={TRANSPORTS.map((option) => ({ ...option, title: t(`mcp.transports.${option.value}`) }))}
                onChange={(transport) => patch({ transport })}
              />
            </Field>
            {form.transport === 'stdio' ? (
              <>
                <Field label={t('settingsGuided.command')} hint={t('mcp.commandHint')}>
                  <input className="mono" value={form.command} placeholder="npx" onChange={(e) => patch({ command: e.target.value })} />
                </Field>
                <Field label={t('mcp.args')} hint={t('mcp.argsHint')}>
                  <StringListEditor
                    values={form.args}
                    allowDuplicates
                    placeholder="-y"
                    addLabel={t('mcp.addArg')}
                    label={t('mcp.arguments')}
                    emptyText={t('mcp.noArgs')}
                    onChange={(args) => patch({ args })}
                  />
                </Field>
                <Field label={t('settingsGuided.env')}>
                  <KeyValueEditor rows={form.env} maskValues onChange={(env) => patch({ env })} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <input
                    className="mono"
                    type="url"
                    value={form.url}
                    placeholder="https://mcp.example.com/mcp"
                    onChange={(e) => patch({ url: e.target.value })}
                  />
                </Field>
                <Field label={t('mcp.headers')} hint={t('mcp.headersHint')}>
                  <KeyValueEditor
                    rows={form.headers}
                    maskValues
                    keyPlaceholder={t('mcp.header')}
                    addLabel={t('mcp.addHeader')}
                    onChange={(headers) => patch({ headers })}
                  />
                </Field>
              </>
            )}
            {Object.keys(form.extra).length > 0 && (
              <p className="small muted">
                <Trans
                  t={t}
                  i18nKey="mcp.extraKeys"
                  values={{ keys: Object.keys(form.extra).join(', ') }}
                  components={{ mono: <span className="mono" /> }}
                />
              </p>
            )}
          </>
        )}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!nameValid || !complete || clash || save.isPending}>
            {save.isPending ? t('shared.saving') : isNew ? t('mcp.add') : t('mcp.save')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function McpTab({ scope }: { scope: Scope }) {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, isLoading } = useQuery({ queryKey: keys.mcp(scope), queryFn: () => api.mcpServers(scope) });
  const [editing, setEditing] = useState<{ form: ServerForm; isNew: boolean } | null>(null);
  const [health, setHealth] = useState<Map<string, McpServerHealth>>(new Map());
  const servers = data ?? [];

  const check = useMutation({
    mutationFn: () => api.mcpHealth(scope),
    onSuccess: (results) => {
      setHealth(new Map(results.map((r) => [r.name, r])));
      const failing = results.filter((r) => r.status !== 'connected').length;
      if (failing === 0) toast.success(t('mcp.allConnected', { count: results.length }));
      else toast.info(t('mcp.someFailing', { failing, count: results.length }));
    },
    onError: (err) => toast.error(t('mcp.checkFailed'), err),
  });

  const remove = useMutation({
    mutationFn: (server: McpServerEntry) => api.deleteMcpServer(scope, server.name, server.scope),
    onSuccess: (_result, server) => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp(scope) });
      toast.success(t('mcp.removed', { name: server.name }));
    },
    onError: (err) => toast.error(t('mcp.removeFailed'), err),
  });

  const editable = (server: McpServerEntry) => !scope.projectId || server.scope !== 'user';

  if (editing) {
    return (
      <ServerEditor
        key={`${editing.form.scope}:${editing.form.name}:${editing.isNew}`}
        scope={scope}
        initial={editing.form}
        isNew={editing.isNew}
        existingNames={new Set(servers.map((s) => `${s.scope}:${s.name}`))}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <Card
      title={t('config.tabs.mcp')}
      actions={
        <div className="toolbar">
          <button type="button" className="btn btn-small" disabled={check.isPending || servers.length === 0} onClick={() => check.mutate()}>
            {check.isPending ? (
              <>
                <span className="spinner" aria-hidden /> {t('mcp.checking')}
              </>
            ) : (
              t('mcp.check')
            )}
          </button>
          <button
            type="button"
            // One primary per zone: while the list is empty, its empty state holds it
            className={`btn btn-small ${servers.length > 0 ? 'btn-primary' : ''}`}
            onClick={() => setEditing({ form: emptyForm(scope.projectId ? 'project' : 'user'), isNew: true })}
          >
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t('mcp.add')}
          </button>
        </div>
      }
    >
      <ErrorBox error={error} />
      {check.isPending && <p className="small muted" role="status">{t('mcp.checkingHint')}</p>}
      {isLoading ? (
        <Skeleton rows={4} />
      ) : servers.length === 0 ? (
        <Empty
          title={t('mcp.empty')}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ form: emptyForm(scope.projectId ? 'project' : 'user'), isNew: true })}>
              {t('mcp.addFirst')}
            </button>
          }
        >
          {t('mcp.emptyHint')}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('mcp.server')}</th>
                <th scope="col">{t('mcp.scope')}</th>
                <th scope="col">{t('mcp.transport')}</th>
                <th scope="col">{t('mcp.target')}</th>
                <th scope="col">{t('mcp.connection')}</th>
                <th scope="col">
                  <span className="sr-only">{t('mcp.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const status = health.get(server.name);
                const transport = isObject(server.config) && typeof server.config.type === 'string' ? server.config.type : server.config.url ? 'http' : 'stdio';
                return (
                  <tr key={`${server.scope}:${server.name}`} className={remove.isPending && remove.variables === server ? 'row-busy' : ''}>
                    <td className="strong">{server.name}</td>
                    <td>
                      <span title={t(`mcp.scopeHints.${server.scope}`)}>
                        <Tag tone={SCOPE_TONE[server.scope]}>{server.scope}</Tag>
                      </span>
                      {!editable(server) && <span className="small muted"> {t('mcp.inherited')}</span>}
                    </td>
                    <td className="mono small">{transport}</td>
                    <td className="mono small break">
                      {target(server.config) || '—'}
                    </td>
                    <td className="nowrap">
                      {status ? (
                        <span className="meta-icon">
                          <HealthIcon status={status.status} />
                          <span className="sr-only">{status.status}: </span>
                          <span className="small">{status.detail || status.status}</span>
                        </span>
                      ) : (
                        <span className="small muted">{t('mcp.notChecked')}</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {editable(server) ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-small"
                              aria-label={t('mcp.editNamed', { name: server.name })}
                              onClick={() => setEditing({ form: formFromEntry(server), isNew: false })}
                            >
                              {t('shared.edit')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-small btn-danger"
                              aria-label={t('mcp.removeNamed', { name: server.name })}
                              disabled={remove.isPending}
                              onClick={() =>
                                void confirm({
                                  title: t('mcp.removeTitle', { name: server.name }),
                                  body: t('mcp.removeBody', { scope: server.scope }),
                                  confirmLabel: t('mcp.remove'),
                                  danger: true,
                                }).then((ok) => ok && remove.mutate(server))
                              }
                            >
                              {t('common:actions.remove')}
                            </button>
                          </>
                        ) : (
                          <Link className="btn btn-small" to="/settings?tab=mcp" aria-label={t('mcp.editInUserNamed', { name: server.name })}>
                            {t('mcp.editInUser')}
                          </Link>
                        )}
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
