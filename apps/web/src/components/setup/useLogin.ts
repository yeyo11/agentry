import type { LoginSession, StartLoginRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, keys } from '../../api';
import { useAgentryEvents, useFeedState } from '../../lib/events';
import { isLive, newerSession, READINESS_KEYS } from '../../lib/setup';

/** How often a live sign-in is read while the event stream is down; with it open, events carry every move. */
const POLL_WITHOUT_FEED_MS = 3_000;

/**
 * One sign-in from the panel: start it, follow it, cancel it. A device sign-in moves through
 * `login.updated` events, with `GET /setup/logins/:id` as the reading when the stream is down; a key
 * sign-in answers once it ended. When one succeeds, every list that shows readiness is read again,
 * since the row turning ok is the answer the person waits for.
 */
export function useLogin({ onSucceeded, onCancelled }: { onSucceeded: () => void; onCancelled: () => void }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<LoginSession | null>(null);
  const feed = useFeedState();
  // The end of a session is handled once, whichever of the event, the read or the answer brings it
  const ended = useRef<string | null>(null);

  const take = (incoming: LoginSession) => setSession((current) => (current && current.id !== incoming.id ? current : newerSession(current, incoming)));

  useAgentryEvents((event) => {
    if (event.type === 'login.updated' && session && event.login.id === session.id) take(event.login);
  });

  const live = isLive(session);
  const reading = useQuery({
    queryKey: keys.setupLogin(session?.id ?? ''),
    queryFn: ({ signal }) => api.login(session?.id ?? '', { signal }),
    enabled: live && session !== null,
    refetchInterval: feed === 'open' ? false : POLL_WITHOUT_FEED_MS,
  });
  useEffect(() => {
    if (reading.data) take(reading.data);
  }, [reading.data]);

  useEffect(() => {
    if (!session || !session.endedAt || ended.current === session.id) return;
    ended.current = session.id;
    if (session.state === 'succeeded') {
      for (const key of READINESS_KEYS) void queryClient.invalidateQueries({ queryKey: key });
      onSucceeded();
    } else if (session.state === 'cancelled') {
      onCancelled();
    }
  }, [session, queryClient, onSucceeded, onCancelled]);

  const start = useMutation({
    mutationFn: (body: StartLoginRequest) => api.startLogin(body),
    onSuccess: (started) => {
      ended.current = null;
      setSession(started);
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelLogin(id),
    onSuccess: take,
  });

  return {
    session,
    live,
    start: (body: StartLoginRequest) => {
      setSession(null);
      start.mutate(body);
    },
    starting: start.isPending,
    startError: start.error,
    /** Stops a live sign-in on the server; one that is not live is only forgotten */
    cancel: () => {
      if (session && live) cancel.mutate(session.id);
      else setSession(null);
    },
    /** Forgets an ended session, so the panel shows its form again */
    reset: () => {
      start.reset();
      setSession(null);
    },
  };
}
