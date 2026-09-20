import { ArrowDown, ArrowUp, CircleCheck, CircleOff, X, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { KeyValueEditor, recordToRows, rowsToRecord, StringListEditor, type KeyValueRow } from '../../components/editors';
import { Collapsible, Combobox, NumberInput, Select, Tooltip } from '../../components/controls';
import { ICON_SM } from '../../components/icons';
import { Field, MODEL_OPTIONS, Tag } from '../../components/ui';
import {
  getIn,
  GUIDED_KEYS,
  HOOK_EVENTS,
  hookGroups,
  isObject,
  stringList,
  type HookCommand,
  type HookGroup,
  type Json,
} from './settingsModel';

const DEFAULT_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;

type SetFn = (path: string[], value: unknown) => void;

function Section({
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible
      className="section"
      defaultOpen={defaultOpen}
      title={
        <>
          <span className="section-title">{title}</span>
          {summary && <span className="section-summary">{summary}</span>}
        </>
      }
    >
      <div className="section-body">{children}</div>
    </Collapsible>
  );
}

/** true / false / "not set" — an unset key is different from false because lower scopes can still set it. */
function TriState({ value, onChange, label }: { value: unknown; onChange: (v: boolean | undefined) => void; label: string }) {
  return (
    <Select
      aria-label={label}
      value={value === true ? 'true' : value === false ? 'false' : ''}
      onChange={(v) => onChange(v === '' ? undefined : v === 'true')}
      options={[
        { value: '', label: 'Not set (inherit)' },
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ]}
    />
  );
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function HooksEditor({ settings, set, filesHref }: { settings: Json; set: SetFn; filesHref: string }) {
  const update = (event: string, groups: HookGroup[]) =>
    set(
      ['hooks', event],
      groups.map((g) => {
        const { matcher, ...rest } = g;
        return matcher ? { matcher, ...rest } : rest;
      }),
    );

  return (
    <div className="stack">
      <p className="small muted">
        Hooks run shell commands at lifecycle events; the event payload arrives as JSON on stdin. Keep scripts in{' '}
        <span className="mono">hooks/</span> and edit them in the <Link to={filesHref}>Files tab</Link>.
      </p>
      {HOOK_EVENTS.map(({ id: event, hint }) => {
        const groups = hookGroups(settings, event);
        const patchGroup = (index: number, patch: Partial<HookGroup>) =>
          update(event, groups.map((g, i) => (i === index ? { ...g, ...patch } : g)));
        const patchCommand = (gi: number, ci: number, patch: Partial<HookCommand>) =>
          patchGroup(gi, {
            hooks: (groups[gi]?.hooks ?? []).map((c, i) => {
              if (i !== ci) return c;
              const next = { ...c, ...patch };
              if (next.timeout === undefined) delete next.timeout;
              return next;
            }),
          });
        const move = (index: number, delta: number) => {
          const next = [...groups];
          const [item] = next.splice(index, 1);
          if (item) next.splice(index + delta, 0, item);
          update(event, next);
        };
        return (
          <Collapsible
            key={event}
            className="hook-event"
            defaultOpen={groups.length > 0}
            title={
              <>
                <span className="mono strong">{event}</span>
                {groups.length > 0 && <Tag tone="active">{groups.reduce((n, g) => n + g.hooks.length, 0)} commands</Tag>}
                <span className="small muted hook-hint">{hint}</span>
              </>
            }
          >
            <div className="stack-tight hook-body">
              {groups.map((group, gi) => (
                <div key={gi} className="hook-group">
                  <div className="hook-group-head">
                    <Field label="Matcher" hint="Empty matches everything">
                      <input
                        className="mono"
                        value={group.matcher ?? ''}
                        placeholder="e.g. Bash or Edit|Write"
                        onChange={(e) => patchGroup(gi, { matcher: e.target.value || undefined })}
                      />
                    </Field>
                    <div className="row-actions">
                      <Tooltip content="Move up">
                        <button type="button" className="icon-btn" aria-label="Move group up" disabled={gi === 0} onClick={() => move(gi, -1)}>
                          <ArrowUp {...ICON_SM} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Move down">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Move group down"
                          disabled={gi === groups.length - 1}
                          onClick={() => move(gi, 1)}
                        >
                          <ArrowDown {...ICON_SM} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Remove group">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Remove matcher group"
                          onClick={() => update(event, groups.filter((_, i) => i !== gi))}
                        >
                          <X {...ICON_SM} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                  {group.hooks.map((command, ci) => (
                    <div key={ci} className="hook-command">
                      <input
                        className="mono"
                        aria-label="Command"
                        value={text(command.command)}
                        placeholder='e.g. "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh'
                        onChange={(e) => patchCommand(gi, ci, { command: e.target.value })}
                      />
                      <NumberInput
                        compact
                        min={1}
                        aria-label="Timeout in seconds (optional)"
                        placeholder="timeout s"
                        value={typeof command.timeout === 'number' ? command.timeout : undefined}
                        onChange={(timeout) => patchCommand(gi, ci, { timeout })}
                      />
                      <Tooltip content="Remove command">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Remove command"
                          onClick={() => patchGroup(gi, { hooks: group.hooks.filter((_, i) => i !== ci) })}
                        >
                          <X {...ICON_SM} />
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                  <div>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => patchGroup(gi, { hooks: [...group.hooks, { type: 'command', command: '' }] })}
                    >
                      <Plus size={14} strokeWidth={2} aria-hidden />
                      Command
                    </button>
                  </div>
                </div>
              ))}
              <div>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => update(event, [...groups, { hooks: [{ type: 'command', command: '' }] }])}
                >
                  <Plus size={14} strokeWidth={2} aria-hidden />
                  Matcher group
                </button>
              </div>
            </div>
          </Collapsible>
        );
      })}
    </div>
  );
}

export function SettingsGuided({
  settings,
  set,
  filesHref,
}: {
  settings: Json;
  set: SetFn;
  /** Link to the Files tab in the current scope */
  filesHref: string;
}) {
  // Env rows keep their own state so half-typed rows (empty key) are not dropped while editing.
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(() => recordToRows(settings.env));
  const permissions = (path: string) => stringList(getIn(settings, ['permissions', path]));
  const statusLine = isObject(settings.statusLine) ? settings.statusLine : {};
  const preserved = Object.keys(settings).filter((key) => !GUIDED_KEYS.has(key));
  const hookCount = HOOK_EVENTS.reduce((n, e) => n + hookGroups(settings, e.id).reduce((m, g) => m + g.hooks.length, 0), 0);
  const ruleCount = permissions('allow').length + permissions('ask').length + permissions('deny').length;
  const defaultMode = text(getIn(settings, ['permissions', 'defaultMode']));
  const enabledPlugins = isObject(settings.enabledPlugins) ? Object.entries(settings.enabledPlugins) : [];
  const marketplaces = isObject(settings.extraKnownMarketplaces) ? Object.keys(settings.extraKnownMarketplaces) : [];

  return (
    <div className="sections">
      <Section title="General" defaultOpen summary={text(settings.model) || undefined}>
        <div className="form-grid">
          <Field label="Model" hint="Alias (fable, opus, sonnet, haiku) or a full model id. Empty uses the default.">
            <Combobox value={text(settings.model)} placeholder="default" options={MODEL_OPTIONS} onChange={(v) => set(['model'], v)} />
          </Field>
          <Field label="Output style" hint="Name of a built-in or custom output style.">
            <input value={text(settings.outputStyle)} placeholder="default" onChange={(e) => set(['outputStyle'], e.target.value)} />
          </Field>
          <Field label="Transcript retention (days)" hint="cleanupPeriodDays: local transcripts older than this are deleted.">
            <NumberInput
              min={0}
              value={typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : undefined}
              placeholder="30"
              onChange={(v) => set(['cleanupPeriodDays'], v)}
            />
          </Field>
          <Field label="Co-authored-by in commits" hint="includeCoAuthoredBy">
            <TriState label="Include co-authored-by" value={settings.includeCoAuthoredBy} onChange={(v) => set(['includeCoAuthoredBy'], v)} />
          </Field>
          <Field label="API key helper" hint="apiKeyHelper: script that prints an API key on stdout.">
            <input
              className="mono"
              value={text(settings.apiKeyHelper)}
              placeholder="/path/to/generate-key.sh"
              onChange={(e) => set(['apiKeyHelper'], e.target.value)}
            />
          </Field>
          <Field label="Status line command" hint="statusLine: command whose output is shown as the status line.">
            <input
              className="mono"
              value={text(statusLine.command)}
              placeholder="~/.claude/statusline.sh"
              onChange={(e) =>
                set(['statusLine'], e.target.value ? { ...statusLine, type: 'command', command: e.target.value } : undefined)
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="Permissions" summary={ruleCount > 0 ? `${ruleCount} rules` : undefined}>
        <div className="form">
          <Field label="Default mode" hint="permissions.defaultMode: how tool calls are handled when no rule matches.">
            <Select
              value={defaultMode}
              onChange={(v) => set(['permissions', 'defaultMode'], v)}
              options={[
                { value: '', label: 'Not set (inherit)' },
                ...DEFAULT_MODES.map((mode) => ({ value: mode, label: mode })),
                // Keep a value this form does not know about selectable instead of showing it blank
                ...(defaultMode && !(DEFAULT_MODES as readonly string[]).includes(defaultMode) ? [{ value: defaultMode, label: defaultMode }] : []),
              ]}
            />
          </Field>
          <p className="small muted">
            Rule syntax: <span className="mono">Tool</span> or <span className="mono">Tool(specifier)</span>, e.g.{' '}
            <span className="mono">Bash(git status)</span>, <span className="mono">Bash(npm run test:*)</span>,{' '}
            <span className="mono">Read(./secrets/**)</span>, <span className="mono">WebFetch(domain:example.com)</span>,{' '}
            <span className="mono">mcp__server__tool</span>. Deny wins over ask, ask wins over allow.
          </p>
          {(
            [
              ['allow', 'Allow', 'Runs without asking'],
              ['ask', 'Ask', 'Always asks for confirmation'],
              ['deny', 'Deny', 'Never allowed'],
            ] as const
          ).map(([key, label, hint]) => (
            <Field key={key} label={`${label} · ${hint}`}>
              <StringListEditor
                values={permissions(key)}
                placeholder="Bash(git status)"
                addLabel={`Add to ${key}`}
                label={`${label} rules`}
                onChange={(values) => set(['permissions', key], values)}
              />
            </Field>
          ))}
          <Field label="Additional directories" hint="permissions.additionalDirectories: extra directories Claude may work in.">
            <StringListEditor
              values={permissions('additionalDirectories')}
              label="Additional directories"
              placeholder="../shared-lib"
              onChange={(values) => set(['permissions', 'additionalDirectories'], values)}
            />
          </Field>
        </div>
      </Section>

      <Section title="Environment variables" summary={envRows.length > 0 ? `${envRows.length} variables` : undefined}>
        <p className="small muted">Applied to every session. Values are masked here but stored in plain text in the file.</p>
        <KeyValueEditor
          rows={envRows}
          maskValues
          onChange={(rows) => {
            setEnvRows(rows);
            set(['env'], rowsToRecord(rows));
          }}
        />
      </Section>

      <Section title="Hooks" summary={hookCount > 0 ? `${hookCount} commands` : undefined}>
        <HooksEditor settings={settings} set={set} filesHref={filesHref} />
      </Section>

      <Section title="MCP approvals">
        <div className="form">
          <Field label="Approve every server in .mcp.json" hint="enableAllProjectMcpServers">
            <TriState
              label="Approve all project MCP servers"
              value={settings.enableAllProjectMcpServers}
              onChange={(v) => set(['enableAllProjectMcpServers'], v)}
            />
          </Field>
          <Field label="Approved .mcp.json servers" hint="enabledMcpjsonServers">
            <StringListEditor
              values={stringList(settings.enabledMcpjsonServers)}
              label="Approved .mcp.json servers"
              placeholder="server-name"
              onChange={(values) => set(['enabledMcpjsonServers'], values)}
            />
          </Field>
          <Field label="Rejected .mcp.json servers" hint="disabledMcpjsonServers">
            <StringListEditor
              values={stringList(settings.disabledMcpjsonServers)}
              label="Rejected .mcp.json servers"
              placeholder="server-name"
              onChange={(values) => set(['disabledMcpjsonServers'], values)}
            />
          </Field>
        </div>
      </Section>

      <Section title="Plugins & marketplaces" summary={enabledPlugins.length > 0 ? `${enabledPlugins.length} plugins` : undefined}>
        <p className="small muted">
          Managed by the CLI. Use the <Link to="/settings?tab=plugins">Plugins tab</Link> to install, enable or remove them.
        </p>
        <div className="chips">
          {enabledPlugins.length === 0 && marketplaces.length === 0 && <span className="small muted">Nothing configured in this file</span>}
          {enabledPlugins.map(([id, enabled]) => (
            <span key={id} className="chip chip-static mono">
              {enabled ? <CircleCheck className="text-ok" {...ICON_SM} /> : <CircleOff {...ICON_SM} />}
              {id}
              <span className="muted">{enabled ? 'enabled' : 'disabled'}</span>
            </span>
          ))}
          {marketplaces.map((name) => (
            <span key={name} className="chip chip-static mono">
              <span aria-hidden>⌂</span>
              <span className="sr-only">marketplace</span> {name}
            </span>
          ))}
        </div>
      </Section>

      {preserved.length > 0 && (
        <Section title="Other keys" summary={`${preserved.length} preserved`}>
          <p className="small muted">These keys have no guided control. They are kept untouched; edit them in Raw JSON.</p>
          <div className="chips">
            {preserved.map((key) => (
              <span key={key} className="chip chip-static mono">
                {key}
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
