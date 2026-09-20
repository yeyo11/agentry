import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthMode } from '@agentry/shared';
import { signIn } from '../lib/auth';
import { BrandMark, ICON } from './icons';

/**
 * What a 401 looks like: the whole app is replaced by this, so a guarded wrapper reached without a
 * credential is a screen that says what to do, and not the blank page a failed first request
 * leaves behind.
 */
export function SignIn({ mode }: { mode: AuthMode }) {
  const { t } = useTranslation('common');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await signIn(token))) setError(t('signIn.rejected'));
    } catch {
      setError(t('signIn.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="card signin-card" onSubmit={submit}>
        <div className="signin-head">
          <BrandMark />
          <h1>{t('signIn.title')}</h1>
        </div>
        <p className="muted">{mode === 'oidc' ? t('signIn.oidcBody') : t('signIn.tokenBody')}</p>
        <label className="field">
          <span className="field-label">{t('signIn.label')}</span>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={token}
            placeholder={t('signIn.placeholder')}
            onChange={(event) => setToken(event.target.value)}
          />
          <span className="field-hint">{t('signIn.hint')}</span>
        </label>
        {error && (
          <div className="alert alert-bad" role="alert">
            <div className="alert-body">{error}</div>
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>
          <KeyRound {...ICON} aria-hidden />
          {t('signIn.submit')}
        </button>
      </form>
    </div>
  );
}
