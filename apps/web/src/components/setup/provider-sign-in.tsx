import type { ProviderStatus } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys } from '../../api';
import { isPanelTool, methodsOf, offersSignIn, offersSignOut } from '../../lib/setup';
import { SignInPanel, SignInSheet } from './SignInPanel';
import { SignOutButton } from './SignOutButton';

/**
 * Sign in and sign out on a list of provider rows, the same in Settings → Providers and in the
 * assistant's Agents step: which row has its panel open (one at a time), what each row offers, and
 * the panel itself, under the row on a desktop or in a Sheet on a phone.
 */
export function useProviderSignIn() {
  const setup = useQuery({ queryKey: keys.setup, queryFn: ({ signal }) => api.setup({ signal }) });
  const [openId, setOpenId] = useState<string | null>(null);

  const rowProps = (status: ProviderStatus) => {
    const tool = isPanelTool(status.id) ? status.id : null;
    const methods = tool ? methodsOf(setup.data, tool) : null;
    const keyStored = setup.data?.providers.find((p) => p.id === status.id)?.keyStored ?? false;
    const canSignIn = Boolean(tool && methods);
    return {
      onSignIn: canSignIn ? () => setOpenId((now) => (now === status.id ? null : status.id)) : undefined,
      // `no-probe` has no sign-in action of its own: a row with no key kept offers one here
      offerSignIn: canSignIn && status.state === 'unknown' && offersSignIn(status.state, status.reason, keyStored),
      open: openId === status.id,
      signOut: tool && offersSignOut(methods, status.state, status.reason, keyStored) ? <SignOutButton tool={tool} label={status.label} keyOnly={methods?.signOutKeyOnly ?? false} /> : undefined,
    };
  };

  /** The open panel under its row (desktop); null for every other row */
  const inline = (status: ProviderStatus) =>
    openId === status.id && isPanelTool(status.id) ? <SignInPanel key={status.id} tool={status.id} label={status.label} onClose={() => setOpenId(null)} /> : null;

  /** The open panel as a Sheet (phone), wherever the page puts it */
  const sheet = (statuses: ProviderStatus[]) => {
    const status = statuses.find((s) => s.id === openId);
    return status && isPanelTool(status.id) ? <SignInSheet key={status.id} tool={status.id} label={status.label} onClose={() => setOpenId(null)} /> : null;
  };

  return { openId, close: () => setOpenId(null), rowProps, inline, sheet };
}
