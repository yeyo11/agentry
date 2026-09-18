import { Plus } from 'lucide-react';
import type { McpHealthStatus, McpScope, McpServerEntry, McpServerHealth } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys, type Scope } from '../../api';
import { CodeEditor } from '../../components/CodeEditor';
import { useConfirm } from '../../components/Dialog';
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
  { value: 'stdio', label: 'stdio', title: 'Local process started by Claude Code' },
  { value: 'http', label: 'HTTP', title: 'Remote server over streamable HTTP' },
  { value: 'sse', label: 'SSE', title: 'Remote server over Server-Sent Events (legacy)' },
] as const;

const SCOPE_INFO: Record<McpScope, { tone: string; hint: string }> = {
  user: { tone: 'info', hint: 'Available in every project of this account' },
  project: { tone: 'idle', hint: 'Stored in .mcp.json, shared with the team' },
  local: { tone: 'warn', hint: 'Private to you within this project' },
};

const HEALTH_TONE: Record<McpHealthStatus, string> = {
  connected: 'dot-ok',
  failed: 'dot-bad',
  'needs-auth': 'dot-warn',
  pending: 'dot-warn',
  unknown: '',
};

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
      if (!config) throw new Error(parsedJson?.error ?? 'Invalid configuration');
      return api.putMcpServer(scope, form.name, config, form.scope);
    },
    onSuccess: (entry) => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp(scope) });
      toast.success(`MCP server “${entry.name}” saved`, `${entry.scope} scope`);
      onClose();
    },
    onError: (err) => toast.error('Could not save the MCP server', err),
  });

  const toggleAdvanced = () => {
    if (!advanced) {
      setJson(JSON.stringify(configFromForm(form), null, 2));
      setAdvanced(true);
      return;
    }
    if (!parsedJson?.value) {
      toast.error('Fix the JSON first', new Error(parsedJson?.error ?? 'Invalid JSON'));
      return;
    }
    setForm((f) => ({ ...formFromEntry({ name: f.name, scope: f.scope, config: parsedJson.value as Record<string, unknown> }) }));
    setAdvanced(false);
  };

  return (
    <Card
      title={isNew ? 'New MCP server' : `Edit “${initial.name}”`}
      actions={
        <label className="check">
          <input type="checkbox" checked={advanced} onChange={toggleAdvanced} /> Advanced JSON
        </label>
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
          <Field label="Name" hint={clash ? undefined : 'Letters, digits, dots, dashes and underscores.'}>
            <input
              className={`mono ${form.name && (!nameValid || clash) ? 'is-invalid' : ''}`}
              value={form.name}
              disabled={!isNew}
              placeholder="my-server"
              onChange={(e) => patch({ name: e.target.value.trim() })}
            />
            {clash && <span className="field-hint text-err">A server with this name already exists in the {form.scope} scope.</span>}
          </Field>
          <Field label="Scope" hint={SCOPE_INFO[form.scope].hint}>
            <select value={form.scope} disabled={!isNew} onChange={(e) => patch({ scope: e.target.value as McpScope })}>
              {!scope.projectId && <option value="user">user</option>}
              {scope.projectId && <option value="project">project (.mcp.json)</option>}
              {scope.projectId && <option value="local">local (only me, this project)</option>}
            </select>
          </Field>
        </div>

        {advanced ? (
          <>
            <CodeEditor
              language="json"
              ariaLabel="MCP server JSON"
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
                Invalid JSON: {parsedJson.error}
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="Transport">
              <Segmented label="Transport" value={form.transport} options={TRANSPORTS} onChange={(transport) => patch({ transport })} />
            </Field>
            {form.transport === 'stdio' ? (
              <>
                <Field label="Command" hint="Executable that speaks MCP over stdin/stdout.">
                  <input className="mono" value={form.command} placeholder="npx" onChange={(e) => patch({ command: e.target.value })} />
                </Field>
                <Field label="Arguments" hint="One argument per entry, in order.">
                  <StringListEditor
                    values={form.args}
                    allowDuplicates
                    placeholder="-y"
                    addLabel="Add argument"
                    emptyText="No arguments"
                    onChange={(args) => patch({ args })}
                  />
                </Field>
                <Field label="Environment variables">
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
                <Field label="Headers" hint="For example Authorization: Bearer …">
                  <KeyValueEditor
                    rows={form.headers}
                    maskValues
                    keyPlaceholder="Header"
                    addLabel="Add header"
                    onChange={(headers) => patch({ headers })}
                  />
                </Field>
              </>
            )}
            {Object.keys(form.extra).length > 0 && (
              <p className="small muted">
                Extra keys kept as-is: <span className="mono">{Object.keys(form.extra).join(', ')}</span> (edit them in Advanced JSON).
              </p>
            )}
          </>
        )}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!nameValid || !complete || clash || save.isPending}>
            {save.isPending ? 'Saving…' : isNew ? 'Add server' : 'Save server'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

export function McpTab({ scope, onSwitchToUser }: { scope: Scope; onSwitchToUser: () => void }) {
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
      if (failing === 0) toast.success(`All ${results.length} servers connected`);
      else toast.info(`${failing} of ${results.length} servers are not connected`);
    },
    onError: (err) => toast.error('Connection check failed', err),
  });

  const remove = useMutation({
    mutationFn: (server: McpServerEntry) => api.deleteMcpServer(scope, server.name, server.scope),
    onSuccess: (_result, server) => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp(scope) });
      toast.success(`MCP server “${server.name}” removed`);
    },
    onError: (err) => toast.error('Could not remove the MCP server', err),
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
      title="MCP servers"
      actions={
        <div className="toolbar">
          <button className="btn btn-small" disabled={check.isPending || servers.length === 0} onClick={() => check.mutate()}>
            {check.isPending ? (
              <>
                <span className="spinner" /> Checking…
              </>
            ) : (
              'Check connections'
            )}
          </button>
          <button
            className="btn btn-small btn-primary"
            onClick={() => setEditing({ form: emptyForm(scope.projectId ? 'project' : 'user'), isNew: true })}
          >
            <Plus size={14} strokeWidth={2} aria-hidden />
            Add server
          </button>
        </div>
      }
    >
      <ErrorBox error={error} />
      {check.isPending && <p className="small muted">Starting every server and testing the connection. This can take a while…</p>}
      {isLoading ? (
        <Skeleton rows={4} />
      ) : servers.length === 0 ? (
        <Empty
          title="No MCP servers"
          action={
            <button className="btn btn-primary" onClick={() => setEditing({ form: emptyForm(scope.projectId ? 'project' : 'user'), isNew: true })}>
              Add the first server
            </button>
          }
        >
          MCP servers give Claude extra tools: databases, issue trackers, browsers…
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Scope</th>
                <th>Transport</th>
                <th>Target</th>
                <th>Connection</th>
                <th />
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
                      <span title={SCOPE_INFO[server.scope].hint}>
                        <Tag tone={SCOPE_INFO[server.scope].tone}>{server.scope}</Tag>
                      </span>
                      {!editable(server) && <span className="small muted"> inherited</span>}
                    </td>
                    <td className="mono small">{transport}</td>
                    <td className="mono small break" title={target(server.config)}>
                      {target(server.config) || '—'}
                    </td>
                    <td className="nowrap">
                      {status ? (
                        <span title={status.detail}>
                          <span className={`dot ${HEALTH_TONE[status.status]}`} /> <span className="small">{status.detail || status.status}</span>
                        </span>
                      ) : (
                        <span className="small muted">not checked</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {editable(server) ? (
                          <>
                            <button className="btn btn-small" onClick={() => setEditing({ form: formFromEntry(server), isNew: false })}>
                              Edit
                            </button>
                            <button
                              className="btn btn-small btn-danger"
                              disabled={remove.isPending}
                              onClick={() =>
                                void confirm({
                                  title: `Remove “${server.name}”?`,
                                  body: `The server is removed from the ${server.scope} scope. Sessions already running keep it until they restart.`,
                                  confirmLabel: 'Remove server',
                                  danger: true,
                                }).then((ok) => ok && remove.mutate(server))
                              }
                            >
                              Remove
                            </button>
                          </>
                        ) : (
                          <button className="btn btn-small" onClick={onSwitchToUser}>
                            Edit in user scope
                          </button>
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
