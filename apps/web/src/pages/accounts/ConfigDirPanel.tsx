import type { AccountConfig, AccountSummary } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderCog, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Collapsible, Switch } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { ErrorBox, Field } from '../../components/ui';

/**
 * Where this account's Claude Code keeps its own files. Off by default: every account shares the
 * wrapper's directory, as before. Nothing is moved or copied out of it, and going back removes only
 * the links Agentry made.
 */
export function ConfigDirPanel({ account, config }: { account: AccountSummary; config: AccountConfig | undefined }) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const current = config?.configDir ?? null;
  const [dir, setDir] = useState(current ?? '');
  const [share, setShare] = useState(false);
  const absolute = dir.trim().startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir.trim());
  const name = account.alias ?? account.email;

  const save = useMutation({
    mutationFn: (next: string | null) => api.setAccountConfig(account.number, { configDir: next, ...(next && share ? { shareSettings: true } : {}) }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
      setDir(saved.configDir ?? '');
      toast.success(saved.configDir ? t('configDir.saved', { name }) : t('configDir.cleared', { name }));
    },
  });

  return (
    <Collapsible
      className="account-config"
      triggerClassName="account-config-trigger"
      title={
        <span className="account-config-title">
          <FolderCog {...ICON_SM} aria-hidden />
          <span>{t('configDir.title')}</span>
          {/* Lower-case mono, as the reference writes it: a badge would shout a plain fact */}
          <span className={`account-config-state ${current ? 'is-own' : ''}`.trim()}>· {current ? t('configDir.own') : t('configDir.shared')}</span>
        </span>
      }
    >
      <form
        className="form account-config-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (absolute) save.mutate(dir.trim());
        }}
      >
        <p className="muted small">{current ? t('configDir.usingOwn', { dir: current }) : t('configDir.usingShared')}</p>
        <Field label={t('configDir.path')} hint={t('configDir.pathHint')}>
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="/home/me/.claude-work"
            aria-label={t('configDir.pathOf', { name })}
            aria-invalid={dir.trim() !== '' && !absolute}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {dir.trim() !== '' && !absolute && <p className="small text-warn">{t('configDir.notAbsolute')}</p>}
        <Switch checked={share} onChange={setShare}>
          {t('configDir.share')}
        </Switch>
        <p className="muted small">{t('configDir.shareHint')}</p>
        <p className="muted small">
          <Trans
            t={t}
            i18nKey="configDir.login"
            values={{ dir: dir.trim() || '/path/to/config' }}
            components={{ code: <code className="mono" /> }}
          />
        </p>
        {config && config.links.length > 0 && (
          <p className="muted small">
            {t('configDir.links', { count: config.links.length })} <span className="mono">{config.links.join(', ')}</span>
          </p>
        )}
        <ErrorBox error={save.error} title={t('configDir.failed')} />
        <div className="form-actions">
          <button type="submit" className="btn btn-small btn-primary" disabled={!absolute || save.isPending || (dir.trim() === current && !share)}>
            {save.isPending ? t('configDir.saving') : current ? t('configDir.apply') : t('configDir.create')}
          </button>
          {current && (
            <button
              type="button"
              className="btn btn-small"
              disabled={save.isPending}
              onClick={() =>
                void confirm({
                  title: t('configDir.resetTitle', { name }),
                  body: t('configDir.resetBody'),
                  confirmLabel: t('configDir.reset'),
                }).then((ok) => {
                  if (ok) save.mutate(null);
                })
              }
            >
              <Undo2 {...ICON_SM} /> {t('configDir.reset')}
            </button>
          )}
        </div>
      </form>
    </Collapsible>
  );
}
