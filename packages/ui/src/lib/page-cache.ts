/**
 * The back/forward cache, for whatever holds a connection open.
 *
 * A page the browser keeps for Back is frozen, not closed: its EventSources stay connected, its
 * timers stop, and `visibilitychange` alone never lets go of them (the timer that would is frozen
 * with the page). Over HTTP/1.1 a browser allows six connections per origin, shared by every
 * document of it, cached ones included: a few chats opened one after another and the page in front
 * has none left, so its next request waits in the browser's queue until a stream somewhere closes.
 *
 * `release` runs on `pagehide`, every time, since the page cannot know whether it will be cached or
 * discarded; `resume` runs only when a cached page is shown again.
 */
export function onBackForwardCache(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, release: () => void, resume: () => void): () => void {
  const onHide = () => release();
  const onShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) resume();
  };
  target.addEventListener('pagehide', onHide);
  target.addEventListener('pageshow', onShow);
  return () => {
    target.removeEventListener('pagehide', onHide);
    target.removeEventListener('pageshow', onShow);
  };
}
