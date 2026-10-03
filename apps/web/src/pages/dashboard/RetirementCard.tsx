import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys } from '../../api';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useToast } from '@agentry/ui/components/Toast';
import { CLAUDE_CODE_ID } from '../../lib/provider-state';
import { PROVIDERS_SETTINGS_PATH } from '../../lib/provider-status';
import { useProviders } from '../../lib/providers';

/**
 * The retirement notice of claude-swap, compact, on Home (`Main.html`, `MobileInicio.html`): what
 * stopped and which account Claude Code keeps, with the way to read the rest in Settings → Providers.
 * It is the same notice as there, so "Understood" dismisses both and neither comes back. Neutral on
 * purpose: nothing here is wrong, so no status colour and nothing that moves.
 */
export function RetirementCard() {
  const { t } = useTranslation('providers');
  const toast = useToast();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: keys.cswapRetirement, queryFn: () => api.cswapRetirement() });
  const statuses = useProviders();
  const dismiss = useMutation({
    mutationFn: () => api.dismissCswapRetirement(),
    onError: (err) => toast.error(t('retire.failed'), err),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.cswapRetirement }),
  });
  if (!state.data?.notice) return null;
  const account = statuses.data?.find((s) => s.id === CLAUDE_CODE_ID)?.account ?? null;
  return (
    <section className="card retire-home" aria-labelledby="retire-home-title">
      <span className="retire-icon" aria-hidden>
        <Info {...ICON_SM} />
      </span>
      <span className="retire-text">
        <h2 id="retire-home-title" className="retire-home-title">
          {t('retire.title')}
        </h2>
        <span className="small muted mono">{account ? t('retire.home.keeps', { account }) : t('retire.home.keepsNone')}</span>
      </span>
      <span className="retire-home-actions">
        <button type="button" className="btn btn-small btn-ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          {t('retire.dismiss')}
        </button>
        <Link to={PROVIDERS_SETTINGS_PATH} className="btn btn-small">
          {t('retire.home.see')}
        </Link>
      </span>
    </section>
  );
}
