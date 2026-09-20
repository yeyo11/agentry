import { ArrowDown, ArrowUp, CircleCheck, CircleOff, X, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('config');
  return (
    <Select
      aria-label={label}
      value={value === true ? 'true' : value === false ? 'false' : ''}
      onChange={(v) => onChange(v === '' ? undefined : v === 'true')}
      options={[
        { value: '', label: t('settingsGuided.notSet') },
        { value: 'true', label: t('settingsGuided.yes') },
        { value: 'false', label: t('settingsGuided.no') },
      ]}
    />
  );
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function HooksEditor({ settings, set, filesHref }: { settings: Json; set: SetFn; filesHref: string }) {
  const { t } = useTranslation('config');
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
        <Trans
          t={t}
          i18nKey="settingsGuided.hooksIntro"
          components={{ mono: <span className="mono" />, anchor: <Link to={filesHref} /> }}
        />
      </p>
      {HOOK_EVENTS.map((event) => {
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
                {groups.length > 0 && (
                  <Tag tone="active">{t('settingsGuided.commands', { count: groups.reduce((n, g) => n + g.hooks.length, 0) })}</Tag>
                )}
                <span className="small muted hook-hint">{t(`settingsGuided.hookEvents.${event}`)}</span>
              </>
            }
          >
            <div className="stack-tight hook-body">
              {groups.map((group, gi) => (
                <div key={gi} className="hook-group">
                  <div className="hook-group-head">
                    <Field label={t('settingsGuided.matcher')} hint={t('settingsGuided.matcherHint')}>
                      <input
                        className="mono"
                        value={group.matcher ?? ''}
                        placeholder={t('settingsGuided.matcherPlaceholder')}
                        onChange={(e) => patchGroup(gi, { matcher: e.target.value || undefined })}
                      />
                    </Field>
                    <div className="row-actions">
                      <Tooltip content={t('settingsGuided.moveUp')}>
                        <button type="button" className="icon-btn" aria-label={t('settingsGuided.moveGroupUp')} disabled={gi === 0} onClick={() => move(gi, -1)}>
                          <ArrowUp {...ICON_SM} />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('settingsGuided.moveDown')}>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t('settingsGuided.moveGroupDown')}
                          disabled={gi === groups.length - 1}
                          onClick={() => move(gi, 1)}
                        >
                          <ArrowDown {...ICON_SM} />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('settingsGuided.removeGroup')}>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t('settingsGuided.removeMatcherGroup')}
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
                        aria-label={t('settingsGuided.command')}
                        value={text(command.command)}
                        placeholder={t('settingsGuided.commandPlaceholder')}
                        onChange={(e) => patchCommand(gi, ci, { command: e.target.value })}
                      />
                      <NumberInput
                        compact
                        min={1}
                        aria-label={t('settingsGuided.timeout')}
                        placeholder={t('settingsGuided.timeoutPlaceholder')}
                        value={typeof command.timeout === 'number' ? command.timeout : undefined}
                        onChange={(timeout) => patchCommand(gi, ci, { timeout })}
                      />
                      <Tooltip content={t('settingsGuided.removeCommand')}>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t('settingsGuided.removeCommand')}
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
                      {t('settingsGuided.command')}
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
                  {t('settingsGuided.matcherGroup')}
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
  const { t } = useTranslation('config');
  // Env rows keep their own state so half-typed rows (empty key) are not dropped while editing.
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(() => recordToRows(settings.env));
  const permissions = (path: string) => stringList(getIn(settings, ['permissions', path]));
  const statusLine = isObject(settings.statusLine) ? settings.statusLine : {};
  const preserved = Object.keys(settings).filter((key) => !GUIDED_KEYS.has(key));
  const hookCount = HOOK_EVENTS.reduce((n, event) => n + hookGroups(settings, event).reduce((m, g) => m + g.hooks.length, 0), 0);
  const ruleCount = permissions('allow').length + permissions('ask').length + permissions('deny').length;
  const defaultMode = text(getIn(settings, ['permissions', 'defaultMode']));
  const enabledPlugins = isObject(settings.enabledPlugins) ? Object.entries(settings.enabledPlugins) : [];
  const marketplaces = isObject(settings.extraKnownMarketplaces) ? Object.keys(settings.extraKnownMarketplaces) : [];

  return (
    <div className="sections">
      <Section title={t('settingsGuided.general')} defaultOpen summary={text(settings.model) || undefined}>
        <div className="form-grid">
          <Field label={t('settingsGuided.model')} hint={t('settingsGuided.modelHint')}>
            <Combobox value={text(settings.model)} placeholder={t('settingsGuided.defaultPlaceholder')} options={MODEL_OPTIONS} onChange={(v) => set(['model'], v)} />
          </Field>
          <Field label={t('settingsGuided.outputStyle')} hint={t('settingsGuided.outputStyleHint')}>
            <input value={text(settings.outputStyle)} placeholder={t('settingsGuided.defaultPlaceholder')} onChange={(e) => set(['outputStyle'], e.target.value)} />
          </Field>
          <Field label={t('settingsGuided.retention')} hint={t('settingsGuided.retentionHint')}>
            <NumberInput
              min={0}
              value={typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : undefined}
              placeholder="30"
              onChange={(v) => set(['cleanupPeriodDays'], v)}
            />
          </Field>
          <Field label={t('settingsGuided.coAuthored')} hint="includeCoAuthoredBy">
            <TriState label={t('settingsGuided.coAuthoredLabel')} value={settings.includeCoAuthoredBy} onChange={(v) => set(['includeCoAuthoredBy'], v)} />
          </Field>
          <Field label={t('settingsGuided.apiKeyHelper')} hint={t('settingsGuided.apiKeyHelperHint')}>
            <input
              className="mono"
              value={text(settings.apiKeyHelper)}
              placeholder="/path/to/generate-key.sh"
              onChange={(e) => set(['apiKeyHelper'], e.target.value)}
            />
          </Field>
          <Field label={t('settingsGuided.statusLine')} hint={t('settingsGuided.statusLineHint')}>
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

      <Section title={t('settingsGuided.permissions')} summary={ruleCount > 0 ? t('settingsGuided.rules', { count: ruleCount }) : undefined}>
        <div className="form">
          <Field label={t('settingsGuided.defaultMode')} hint={t('settingsGuided.defaultModeHint')}>
            <Select
              value={defaultMode}
              onChange={(v) => set(['permissions', 'defaultMode'], v)}
              options={[
                { value: '', label: t('settingsGuided.notSet') },
                ...DEFAULT_MODES.map((mode) => ({ value: mode, label: mode })),
                // Keep a value this form does not know about selectable instead of showing it blank
                ...(defaultMode && !(DEFAULT_MODES as readonly string[]).includes(defaultMode) ? [{ value: defaultMode, label: defaultMode }] : []),
              ]}
            />
          </Field>
          <p className="small muted">
            <Trans t={t} i18nKey="settingsGuided.ruleSyntax" components={{ mono: <span className="mono" /> }} />
          </p>
          {(['allow', 'ask', 'deny'] as const).map((key) => (
            <Field key={key} label={t(`settingsGuided.ruleLists.${key}`)}>
              <StringListEditor
                values={permissions(key)}
                placeholder="Bash(git status)"
                addLabel={t('settingsGuided.addTo', { key })}
                label={t(`settingsGuided.ruleListNames.${key}`)}
                onChange={(values) => set(['permissions', key], values)}
              />
            </Field>
          ))}
          <Field label={t('settingsGuided.additionalDirs')} hint={t('settingsGuided.additionalDirsHint')}>
            <StringListEditor
              values={permissions('additionalDirectories')}
              label={t('settingsGuided.additionalDirs')}
              placeholder="../shared-lib"
              onChange={(values) => set(['permissions', 'additionalDirectories'], values)}
            />
          </Field>
        </div>
      </Section>

      <Section title={t('settingsGuided.env')} summary={envRows.length > 0 ? t('settingsGuided.variables', { count: envRows.length }) : undefined}>
        <p className="small muted">{t('settingsGuided.envHint')}</p>
        <KeyValueEditor
          rows={envRows}
          maskValues
          onChange={(rows) => {
            setEnvRows(rows);
            set(['env'], rowsToRecord(rows));
          }}
        />
      </Section>

      <Section title={t('settingsGuided.hooks')} summary={hookCount > 0 ? t('settingsGuided.commands', { count: hookCount }) : undefined}>
        <HooksEditor settings={settings} set={set} filesHref={filesHref} />
      </Section>

      <Section title={t('settingsGuided.mcpApprovals')}>
        <div className="form">
          <Field label={t('settingsGuided.approveAll')} hint="enableAllProjectMcpServers">
            <TriState
              label={t('settingsGuided.approveAllLabel')}
              value={settings.enableAllProjectMcpServers}
              onChange={(v) => set(['enableAllProjectMcpServers'], v)}
            />
          </Field>
          <Field label={t('settingsGuided.approved')} hint="enabledMcpjsonServers">
            <StringListEditor
              values={stringList(settings.enabledMcpjsonServers)}
              label={t('settingsGuided.approvedServers')}
              placeholder={t('settingsGuided.serverName')}
              onChange={(values) => set(['enabledMcpjsonServers'], values)}
            />
          </Field>
          <Field label={t('settingsGuided.rejected')} hint="disabledMcpjsonServers">
            <StringListEditor
              values={stringList(settings.disabledMcpjsonServers)}
              label={t('settingsGuided.rejectedServers')}
              placeholder={t('settingsGuided.serverName')}
              onChange={(values) => set(['disabledMcpjsonServers'], values)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title={t('settingsGuided.plugins')}
        summary={enabledPlugins.length > 0 ? t('settingsGuided.pluginCount', { count: enabledPlugins.length }) : undefined}
      >
        <p className="small muted">
          <Trans t={t} i18nKey="settingsGuided.pluginsHint" components={{ anchor: <Link to="/settings?tab=plugins" /> }} />
        </p>
        <div className="chips">
          {enabledPlugins.length === 0 && marketplaces.length === 0 && <span className="small muted">{t('settingsGuided.nothingConfigured')}</span>}
          {enabledPlugins.map(([id, enabled]) => (
            <span key={id} className="chip chip-static mono">
              {enabled ? <CircleCheck className="text-ok" {...ICON_SM} /> : <CircleOff {...ICON_SM} />}
              {id}
              <span className="muted">{enabled ? t('settingsGuided.enabled') : t('settingsGuided.disabled')}</span>
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
        <Section title={t('settingsGuided.otherKeys')} summary={t('settingsGuided.preserved', { count: preserved.length })}>
          <p className="small muted">{t('settingsGuided.otherKeysHint')}</p>
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
