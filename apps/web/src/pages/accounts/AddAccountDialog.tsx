import { useMutation } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { Dialog } from '../../components/Dialog';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Field } from '../../components/ui';

/** Registers a claude-swap account from a setup-token; the token never comes back from the API. */
export function AddAccountDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t } = useTranslation(['accountsConfig', 'config', 'common']);
  const toast = useToast();
  const formId = useId();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.addAccount({ token, email: email.trim() || undefined }),
    onSuccess: () => {
      toast.success(t('config:accounts.registered'));
      onAdded();
      onClose();
    },
    onError: (err) => toast.error(t('config:accounts.registerFailed'), err),
  });

  return (
    <Dialog
      title={t('page.addTitle')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={!token.trim() || mutation.isPending}>
            <KeyRound {...ICON_SM} /> {mutation.isPending ? t('config:accounts.registering') : t('config:accounts.register')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) mutation.mutate();
        }}
      >
        <Field label={t('config:accounts.token')} hint={t('config:accounts.tokenHint')}>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat…" autoComplete="off" data-autofocus />
        </Field>
        <Field label={t('config:accounts.label')} hint={t('config:accounts.labelHint')}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="work@example.com" autoComplete="off" />
        </Field>
      </form>
    </Dialog>
  );
}
