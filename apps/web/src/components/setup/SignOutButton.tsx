import type { SetupTool } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '@agentry/ui/components/Dialog';
import { Spinner } from '@agentry/ui/components/Spinner';
import { useToast } from '@agentry/ui/components/Toast';
import { READINESS_KEYS } from '../../lib/setup';

/**
 * Sign out of a tool, after asking: it is destructive (the tool stops working for Agentry until
 * someone signs in again), so the confirmation is the danger one. A code host signs out of one host.
 * The vendor's own command does it where there is one (`DELETE /setup/credentials/:tool`).
 */
export function SignOutButton({ tool, label, host, small = false }: { tool: SetupTool; label: string; host?: string; small?: boolean }) {
  const { t } = useTranslation('setup');
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => api.signOut(tool, host),
    onSuccess: (result) => {
      for (const key of READINESS_KEYS) void queryClient.invalidateQueries({ queryKey: key });
      if (result.signedOut) toast.success(t('signOut.done', { label }));
      else if (result.reason === 'unsupported') toast.error(t('signOut.failed', { label }), new Error(t('signOut.unsupported', { label })));
      else toast.error(t('signOut.failed', { label }), new Error(result.reason ?? ''));
    },
    onError: (err) => toast.error(t('signOut.failed', { label }), err),
  });

  const ask = async () => {
    const ok = await confirm({
      title: t('signOut.title', { label: host ?? label }),
      body: host ? t('signOut.bodyHost', { cli: tool, host }) : t('signOut.body', { label }),
      confirmLabel: t('signOut.action'),
      danger: true,
    });
    if (ok) signOut.mutate();
  };

  return (
    <button
      type="button"
      className={`btn prov-quiet${small ? ' btn-small' : ''}`}
      data-action="sign-out"
      aria-label={t('signOut.aria', { label: host ?? label })}
      disabled={signOut.isPending}
      onClick={() => void ask()}
    >
      {signOut.isPending && <Spinner />}
      {t('signOut.action')}
    </button>
  );
}
