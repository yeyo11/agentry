import type { AuthConfig } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { useConfirm } from '@agentry/ui/components/Dialog';
import { ICON } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { CopyButton, Field } from '@agentry/ui/components/ui';
import { setChallenge, setToken } from '../../../lib/auth';
import { reveal, useRevealedToken } from '../../../lib/revealed-token';

// The access token's pieces, shared by Settings → Security's Token card and the setup assistant's
// Access step: setting or rotating it, the one time a generated token is shown, and a token of the
// person's own.

export const MIN_OWN_TOKEN = 16;

/**
 * Set (or generate, with no argument) and remove the token. A new token is taken by this browser
 * before anything else asks: the old one stopped working the moment the answer was written, and the
 * next poll would otherwise be a 401 and the sign-in screen.
 */
export function useTokenActions(auth: AuthConfig) {
  const { t } = useTranslation(['config', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const set = useMutation({
    mutationFn: async (token: string | undefined) => {
      const result = await api.setSecurityToken(token ? { token } : {});
      // An OIDC wrapper wants a JWT here, which a static token would only get in the way of
      if (auth.mode !== 'oidc') {
        setToken(result.token);
        setChallenge(null);
      }
      // A token the person typed is one they already have; only a generated one is shown
      if (!token) reveal(result.token);
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.securityAuth });
      void queryClient.invalidateQueries({ queryKey: keys.setup });
      void queryClient.invalidateQueries({ queryKey: ['security', 'audit'] });
      toast.success(t('config:security.token.saved'));
    },
    onError: (err) => toast.error(t('config:security.token.saveFailed'), err),
  });

  const clear = useMutation({
    mutationFn: api.clearSecurityToken,
    onSuccess: (config) => {
      queryClient.setQueryData(keys.securityAuth, config);
      void queryClient.invalidateQueries({ queryKey: keys.setup });
      toast.success(t('config:security.token.removed'));
    },
    onError: (err) => toast.error(t('config:security.token.removeFailed'), err),
  });

  /** A new token. Rotating while the token is the credential cuts off everyone else who holds the old one, so it asks first. */
  async function generate(): Promise<boolean> {
    if (auth.tokenSet && auth.mode === 'token') {
      const ok = await confirm({
        title: t('config:security.token.rotateConfirm.title'),
        body: t('config:security.token.rotateConfirm.body'),
        confirmLabel: t('config:security.token.rotate'),
        danger: true,
      });
      if (!ok) return false;
    }
    reveal(null);
    await set.mutateAsync(undefined).catch(() => undefined);
    return true;
  }

  return { set, clear, generate, busy: set.isPending || clear.isPending };
}

/**
 * The token Agentry just generated, shown once with Copy. `boxed` is the setup assistant's neutral
 * box; Settings keeps the warning it has always had, with "I have copied it".
 */
export function RevealedToken({ boxed = false, body }: { boxed?: boolean; body?: string }) {
  const { t } = useTranslation('config');
  const revealed = useRevealedToken();
  if (!revealed) return null;
  if (boxed) {
    return (
      <div className="token-once" role="status">
        <strong>{t('security.token.shownOnce')}</strong>
        <span className="small muted">{body ?? t('security.token.shownOnceBody')}</span>
        <div className="token-once-row">
          <code className="mono break grow" data-testid="new-token">
            {revealed}
          </code>
          <CopyButton text={revealed} label={t('security.token.copy')} shown />
        </div>
      </div>
    );
  }
  return (
    <div className="alert alert-warn" role="status">
      <KeyRound {...ICON} className="alert-icon" aria-hidden />
      <div className="alert-body">
        <strong>{t('security.token.shownOnce')}</strong>
        <div className="small">{body ?? t('security.token.shownOnceBody')}</div>
        <div className="form-actions">
          <code className="mono break" data-testid="new-token">
            {revealed}
          </code>
          <CopyButton text={revealed} label={t('security.token.copy')} />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-small" onClick={() => reveal(null)}>
            {t('security.token.copied')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A token of the person's own: at least MIN_OWN_TOKEN characters, never shown again. */
export function OwnTokenForm({ busy, onSave, onCancel, primary = true }: { busy: boolean; onSave: (token: string) => void; onCancel: () => void; primary?: boolean }) {
  const { t } = useTranslation(['config', 'common']);
  const [own, setOwn] = useState('');
  const tooShort = own.trim().length < MIN_OWN_TOKEN;
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!tooShort) onSave(own.trim());
      }}
    >
      <Field label={t('config:security.token.ownLabel')} hint={t('config:security.token.ownHint', { min: MIN_OWN_TOKEN })}>
        <input type="password" autoComplete="off" autoFocus value={own} onChange={(e) => setOwn(e.target.value)} />
      </Field>
      <div className="form-actions">
        <button type="submit" className={primary ? 'btn btn-primary' : 'btn'} disabled={tooShort || busy}>
          {t('config:security.token.ownSave')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('common:actions.cancel')}
        </button>
      </div>
    </form>
  );
}
