import type { NewChatRequest, PermissionMode } from '@agentry/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { SendHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useOverview } from '../../../api';
import { ChatToolsPicker, type ToolChoices } from '../../../components/ChatToolsPicker';
import { Collapsible, Select } from '../../../components/controls';
import { ICON_SM } from '../../../components/icons';
import { ErrorBox, Field, ModelCombobox, PERMISSION_MODES } from '../../../components/ui';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

/**
 * A prompt box that starts a chat in the project. The options sit behind one mono status line,
 * closed, so the box is a prompt first; everything else a new chat can take is on the New chat page.
 */
export default function QuickStartWidget({ project, title, id }: WidgetProps) {
  const { t } = useTranslation(['home', 'chats']);
  const navigate = useNavigate();
  const overview = useOverview();
  const presets = useQuery({ queryKey: keys.toolPresets, queryFn: api.toolPresets });
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [tools, setTools] = useState<ToolChoices>({});

  const start = useMutation({
    mutationFn: () => {
      // Asked here, answered here: a chat started from the dashboard sends its prompts to the panel, as New chat does by default
      const opts: NewChatRequest = { prompt: prompt.trim(), permissionPrompts: 'host' };
      if (project) opts.cwd = project.path;
      if (model.trim()) opts.model = model.trim();
      if (permissionMode) opts.permissionMode = permissionMode;
      if (tools.toolPreset !== undefined) opts.toolPreset = tools.toolPreset;
      if (tools.mcp) opts.mcp = tools.mcp;
      return api.createChat(opts);
    },
    onSuccess: (chat) => navigate(`/chats/${encodeURIComponent(chat.id)}`),
  });

  if (!project) return null;
  const ready = prompt.trim().length > 0 && project.exists && !start.isPending;

  const presetName = (() => {
    if (tools.toolPreset === null) return t('widgets.quickStart.noPreset');
    const presetId = tools.toolPreset ?? presets.data?.defaultPresetId ?? null;
    const found = presets.data?.presets.find((p) => p.id === presetId);
    return found ? found.name : t('widgets.quickStart.noPreset');
  })();
  const status = [
    model.trim() || t('widgets.quickStart.defaultModel'),
    permissionMode || overview.data?.system.defaultPermissionMode || t('widgets.quickStart.defaultMode'),
    presetName,
    tools.mcp ? t('widgets.quickStart.mcpChosen', { count: tools.mcp.servers.length }) : t('widgets.quickStart.mcpDefault'),
  ].join(' · ');

  return (
    <WidgetCard
      id={id}
      title={title}
      actions={
        <Link to={`/chats/new?cwd=${encodeURIComponent(project.path)}`} className="link-more">
          {t('widgets.quickStart.allOptions')}
        </Link>
      }
    >
      <form
        className="quick-start"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) start.mutate();
        }}
      >
        <div className="quick-start-box">
          <textarea
            rows={2}
            aria-label={t('widgets.quickStart.prompt', { name: project.name })}
            placeholder={t('widgets.quickStart.placeholder', { name: project.name })}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) start.mutate();
            }}
            disabled={!project.exists}
          />
          <button type="submit" className="btn btn-primary quick-start-send" disabled={!ready} aria-label={start.isPending ? t('chats:new.starting') : t('chats:new.start')}>
            <SendHorizontal {...ICON_SM} />
          </button>
        </div>
        <Collapsible className="quick-start-options" triggerClassName="status-line" title={<span className="mono small ellipsis">{status}</span>}>
          <div className="form-grid">
            <Field label={t('chats:new.model')}>
              <ModelCombobox aria-label={t('chats:new.model')} placeholder={t('chats:new.modelPlaceholder')} value={model} onChange={setModel} />
            </Field>
            <Field label={t('chats:new.permissionMode')}>
              <Select<PermissionMode | ''>
                aria-label={t('chats:new.permissionMode')}
                value={permissionMode}
                onChange={setPermissionMode}
                options={[
                  { value: '', label: t('chats:new.permissionModeDefault', { mode: overview.data?.system.defaultPermissionMode ?? '…' }) },
                  ...PERMISSION_MODES.map((m) => ({ value: m, label: m })),
                ]}
              />
            </Field>
          </div>
          <ChatToolsPicker value={tools} onChange={setTools} scope={{ projectId: project.id }} />
        </Collapsible>
        <ErrorBox error={start.error} title={t('chats:new.startError')} />
      </form>
    </WidgetCard>
  );
}
