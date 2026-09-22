import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/** What the side panel can show. Each carries the ids the routes need, so a link is self-contained. */
export type DetailRef =
  | { kind: 'chat'; chatId: string }
  | { kind: 'task'; chatId: string; taskId: string }
  | { kind: 'subagent'; chatId: string; agentId: string }
  | { kind: 'workflow-agent'; chatId: string; workflowId: string; agentId: string };

/** The search param that holds the open panel, so it survives a reload and can be linked to. */
export const DETAIL_PARAM = 'detail';

const SEP = ':';

/** `kind:part:part`, each part encoded: ids are plain today, but a colon in one must not shift the rest. */
export function encodeDetail(ref: DetailRef): string {
  const parts =
    ref.kind === 'chat'
      ? [ref.chatId]
      : ref.kind === 'task'
      ? [ref.chatId, ref.taskId]
      : ref.kind === 'subagent'
        ? [ref.chatId, ref.agentId]
        : [ref.chatId, ref.workflowId, ref.agentId];
  return [ref.kind, ...parts.map(encodeURIComponent)].join(SEP);
}

export function decodeDetail(value: string | null): DetailRef | null {
  if (!value) return null;
  const [kind, ...raw] = value.split(SEP);
  const parts = raw.map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return '';
    }
  });
  if (parts.some((p) => !p)) return null;
  const [a, b, c] = parts;
  if (kind === 'chat' && parts.length === 1 && a) return { kind, chatId: a };
  if (kind === 'task' && parts.length === 2 && a && b) return { kind, chatId: a, taskId: b };
  if (kind === 'subagent' && parts.length === 2 && a && b) return { kind, chatId: a, agentId: b };
  if (kind === 'workflow-agent' && parts.length === 3 && a && b && c) return { kind, chatId: a, workflowId: b, agentId: c };
  return null;
}

/** A link to `path` (the current page when omitted) with the panel open. */
export function detailHref(ref: DetailRef, path = ''): string {
  return `${path}?${DETAIL_PARAM}=${encodeURIComponent(encodeDetail(ref))}`;
}

/**
 * The panel is part of the address (`?detail=…`), so opening one is a navigation: Back closes it
 * and a reload brings it back. Other search params of the page are left as they are.
 */
export function useDetailPanel(): { current: DetailRef | null; open: (ref: DetailRef) => void; close: () => void } {
  const [params, setParams] = useSearchParams();
  const value = params.get(DETAIL_PARAM);
  const current = useMemo(() => decodeDetail(value), [value]);
  const open = useCallback(
    (ref: DetailRef) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(DETAIL_PARAM, encodeDetail(ref));
          return next;
        },
        // Opening another panel from inside one replaces it rather than stacking Back steps
        { replace: value !== null },
      ),
    [setParams, value],
  );
  const close = useCallback(
    () =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(DETAIL_PARAM);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  // One object while none of it changes: pages build callbacks on it
  return useMemo(() => ({ current, open, close }), [current, open, close]);
}
