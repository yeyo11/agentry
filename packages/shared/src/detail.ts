/*
 * The address of the side panel a link opens: `?detail=kind:part:part`. Pure string work, moved
 * here from the web so that the notification mapping — which builds such links — runs in Node too.
 */

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
