import type { PermissionMode, RunOptions } from '@agentry/shared';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useAccounts, useOverview, useProjects } from '../api';
import { AttachButton, AttachmentTray, useAttachments } from '../components/Attachments';
import { Combobox, Select, Switch } from '../components/controls';
import { Card, ErrorBox, Field, MODEL_OPTIONS, PageHeader, PERMISSION_MODES } from '../components/ui';

export function NewRun() {
  const { t } = useTranslation('work');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects(false);
  const overview = useOverview();
  const [prompt, setPrompt] = useState('');
  const files = useAttachments();
  const ready = (prompt.trim() || files.ids.length > 0) && !files.uploading;
  const [cwd, setCwd] = useState(params.get('cwd') ?? '');
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [keepAlive, setKeepAlive] = useState(true);
  const [askHere, setAskHere] = useState(true);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [account, setAccount] = useState('');
  const accounts = useAccounts();

  const start = useMutation({
    mutationFn: () => {
      const opts: RunOptions = { prompt: prompt.trim(), keepAlive, permissionPrompts: askHere ? 'host' : 'none' };
      if (files.ids.length) opts.attachments = files.ids;
      if (cwd.trim()) opts.cwd = cwd.trim();
      if (model.trim()) opts.model = model.trim();
      if (name.trim()) opts.name = name.trim();
      if (permissionMode) opts.permissionMode = permissionMode;
      if (appendSystemPrompt.trim()) opts.appendSystemPrompt = appendSystemPrompt.trim();
      if (account) opts.account = account;
      return api.startRun(opts);
    },
    onSuccess: (run) => navigate(`/runs/${run.id}`),
  });

  const system = overview.data?.system;

  return (
    <>
      <PageHeader title={t('newRun.title')} subtitle={t('newRun.subtitle')} />
      <Card>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) start.mutate();
          }}
        >
          <Field label={t('newRun.prompt')} hint={t('newRun.promptHint')}>
            <div {...files.dropProps}>
              <textarea
                autoFocus
                rows={7}
                placeholder={t('newRun.promptPlaceholder')}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={files.onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) start.mutate();
                }}
              />
            </div>
          </Field>
          <div className="attach-row">
            <AttachButton state={files} disabled={start.isPending} />
            <AttachmentTray state={files} />
          </div>
          <div className="form-grid">
            <Field label={t('newRun.cwd')} hint={t('newRun.cwdHint', { dir: system?.workspaceDir ?? t('newRun.wrapperWorkspace') })}>
              <Combobox
                aria-label={t('newRun.cwd')}
                placeholder={t('newRun.cwdPlaceholder')}
                value={cwd}
                onChange={setCwd}
                options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
              />
            </Field>
            <Field label={t('shared.model')} hint={t('newRun.modelHint')}>
              <Combobox aria-label={t('shared.model')} placeholder={t('shared.default')} value={model} onChange={setModel} options={MODEL_OPTIONS} />
            </Field>
            <Field label={t('newRun.permissionMode')} hint={t('newRun.permissionModeHint')}>
              <Select<PermissionMode | ''>
                value={permissionMode}
                onChange={setPermissionMode}
                options={[
                  { value: '', label: t('newRun.defaultMode', { mode: system?.defaultPermissionMode ?? '…' }) },
                  ...PERMISSION_MODES.map((m) => ({ value: m, label: m })),
                ]}
              />
            </Field>
            <Field label={t('newRun.name')} hint={t('newRun.nameHint')}>
              <input placeholder={t('newRun.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {(accounts.data?.accounts.length ?? 0) > 1 && (
              <Field label={t('newRun.account')} hint={t('newRun.accountHint')}>
                <Select
                  value={account}
                  onChange={setAccount}
                  options={[
                    { value: '', label: t('newRun.activeAccount') },
                    ...(accounts.data?.accounts ?? []).map((a) => ({
                      value: String(a.number),
                      label: `${a.alias ?? a.email}${a.headroomPct !== null ? ` · ${t('newRun.percentLeft', { pct: a.headroomPct })}` : ''}`,
                    })),
                  ]}
                />
              </Field>
            )}
          </div>
          <Field label={t('newRun.appendSystemPrompt')} hint={t('newRun.optional')}>
            <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
          </Field>
          <Switch checked={askHere} onChange={setAskHere}>
            {t('newRun.askHere')}
          </Switch>
          <Switch checked={keepAlive} onChange={setKeepAlive}>
            {t('newRun.keepAlive')}
          </Switch>
          <ErrorBox error={start.error} title={t('newRun.startFailed')} />
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!ready || start.isPending}>
              {start.isPending ? t('shared.starting') : files.uploading ? t('shared.uploading') : t('newRun.start')}
            </button>
            <span className="muted small">Ctrl/⌘ + Enter</span>
          </div>
        </form>
      </Card>
    </>
  );
}
