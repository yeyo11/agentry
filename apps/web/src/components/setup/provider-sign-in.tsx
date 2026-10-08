import type { ProviderStatus } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys } from '../../api';
import { isPanelTool, methodsOf, offersSignOut } from '../../lib/setup';
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
    return {
      onSignIn: tool && methods ? () => setOpenId((now) => (now === status.id ? null : status.id)) : undefined,
      open: openId === status.id,
      signOut: tool && offersSignOut(methods, status.state, status.reason) ? <SignOutButton tool={tool} label={status.label} /> : undefined,
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
