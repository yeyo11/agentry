import type { ChatToolConfig, McpSelection } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../api';
import { Checkbox, Select } from './controls';
import { Tag } from './ui';

/** What a start or a resume chooses about tools; a key left out keeps what the chat had. */
export interface ToolChoices {
  toolPreset?: string;
  /** `null` goes back to the servers the CLI loads on its own, an object picks exactly those */
  mcp?: McpSelection | null;
}

type ServerMode = 'keep' | 'default' | 'choose';

/**
 * Tool preset and MCP servers for a chat that starts or resumes. A new chat has nothing to keep, so
 * "keep" there means the CLI's own choice; a resumed one names what it had.
 */
export function ChatToolsPicker({
  value,
  onChange,
  scope,
  current,
}: {
  value: ToolChoices;
  onChange: (next: ToolChoices) => void;
  /** Whose servers are offered: the project the chat works in, or the user's own */
  scope: Scope;
  /** What the chat runs with now; absent for a new chat */
  current?: ChatToolConfig | null;
}) {
  const { t } = useTranslation('chat');
  const presets = useQuery({ queryKey: keys.toolPresets, queryFn: api.toolPresets });
  const servers = useQuery({ queryKey: keys.mcp(scope), queryFn: () => api.mcpServers(scope) });
  const resuming = current !== undefined;
  // A new chat has nothing to keep: leaving the servers alone is the CLI's own choice
  const mode: ServerMode = value.mcp ? 'choose' : resuming && value.mcp === undefined ? 'keep' : 'default';
  const chosen = value.mcp?.servers ?? [];

  // A name that is configured in several scopes is one server to the CLI: the first wins
  const offered = [...new Map((servers.data ?? []).map((s) => [s.name, s])).values()];

  const keepPreset = current?.preset ? t('tools.asBeforePreset', { name: current.preset.name }) : current ? t('tools.asBeforeNone') : t('tools.noPreset');
  const setMode = (next: ServerMode) => {
    if (next === 'keep') onChange({ ...value, mcp: undefined });
    else if (next === 'default') onChange({ ...value, mcp: resuming ? null : undefined });
    else onChange({ ...value, mcp: { servers: current?.mcp?.servers.filter((n) => offered.some((s) => s.name === n)) ?? [] } });
  };
  const toggle = (name: string, on: boolean) =>
    onChange({ ...value, mcp: { servers: on ? [...chosen, name] : chosen.filter((n) => n !== name) } });

  const modes: { value: ServerMode; label: string }[] = [
    ...(resuming
      ? [{ value: 'keep' as const, label: current?.mcp ? t('tools.serversAsBeforeChosen', { count: current.mcp.servers.length }) : t('tools.serversAsBeforeDefault') }]
      : []),
    { value: 'default', label: t('tools.serversDefault') },
    { value: 'choose', label: t('tools.serversChoose') },
  ];

  return (
    <div className="chat-tools-picker stack-tight">
      <label className="field">
        <span className="field-label">{t('tools.preset')}</span>
        <Select
          aria-label={t('tools.preset')}
          value={value.toolPreset ?? ''}
          onChange={(toolPreset) => onChange({ ...value, toolPreset: toolPreset || undefined })}
          options={[
            { value: '', label: keepPreset },
            ...(presets.data ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.description })),
          ]}
        />
        <span className="field-hint">{t('tools.presetHint')}</span>
      </label>
      <label className="field">
        <span className="field-label">{t('tools.servers')}</span>
        <Select<ServerMode>
          aria-label={t('tools.servers')}
          value={mode}
          onChange={setMode}
          options={modes}
        />
        <span className="field-hint">{t('tools.serversHint')}</span>
      </label>
      {mode === 'choose' && (
        <fieldset className="chat-tools-servers">
          <legend className="small muted">{t('tools.onlyThese')}</legend>
          {offered.length === 0 ? (
            <p className="small muted">{t('tools.noServers')}</p>
          ) : (
            offered.map((server) => (
              <Checkbox key={server.name} checked={chosen.includes(server.name)} onChange={(on) => toggle(server.name, on)}>
                <span className="strong">{server.name}</span> <Tag tone="idle">{server.scope}</Tag>
              </Checkbox>
            ))
          )}
          {offered.length > 0 && chosen.length === 0 && <p className="small muted">{t('tools.noneChosen')}</p>}
        </fieldset>
      )}
    </div>
  );
}
