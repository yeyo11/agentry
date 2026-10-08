import type { ContentBlock, TranscriptEntry } from './types.ts';

const MAX_TOOL_RESULT = 20_000;

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string') return c.text;
        if (c && typeof c === 'object' && 'type' in c) return `[${String(c.type)}]`;
        return '';
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function toBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const b = c as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text) blocks.push({ type: 'text', text: b.text });
        break;
      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking });
        break;
      case 'tool_use':
        blocks.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input });
        break;
      case 'tool_result': {
        const text = stringifyToolResult(b.content);
        blocks.push({
          type: 'tool_result',
          toolUseId: String(b.tool_use_id ?? ''),
          content: text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}\n… [truncated]` : text,
          isError: b.is_error === true,
        });
        break;
      }
      // Only what the block is: the base64 can run to megabytes and is never needed to display it
      case 'image':
      case 'document': {
        const source = (b.source ?? {}) as Record<string, unknown>;
        blocks.push({
          type: b.type,
          mediaType: String(source.media_type ?? (b.type === 'image' ? 'image' : 'application/pdf')),
          ...(typeof b.title === 'string' ? { name: b.title } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/**
 * Normalizes both a transcript line (~/.claude/projects/*.jsonl) and a CLI stream-json
 * `user`/`assistant` event: both carry `message: { role, content }`.
 */
export function normalizeMessage(raw: unknown): TranscriptEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type === 'system' && o.subtype === 'local_command') return localCommand(o);
  if (o.type === 'attachment') return queuedCommand(o);
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  if (o.isMeta === true) return null;
  const message = o.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const blocks = toBlocks(message.content);
  if (blocks.length === 0) return null;
  return {
    uuid: String(o.uuid ?? ''),
    role: o.type,
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    model: typeof message.model === 'string' ? message.model : null,
    isSidechain: o.isSidechain === true || (o.parent_tool_use_id != null && o.parent_tool_use_id !== ''),
    parentToolUseId:
      typeof o.parent_tool_use_id === 'string'
        ? o.parent_tool_use_id
        : typeof o.parentToolUseID === 'string'
          ? o.parentToolUseID
          : null,
    blocks,
  };
}

/**
 * The output of a slash command the CLI ran itself (`/context`, `/cost`, …). The CLI used to write
 * it as a `user` message wrapped in `<local-command-stdout>`, and now writes a `system` line with
 * the same text: read as the message it was, so the page keeps showing it as the command's output.
 */
function localCommand(o: Record<string, unknown>): TranscriptEntry | null {
  if (o.isMeta === true || typeof o.content !== 'string' || !o.content) return null;
  return {
    uuid: String(o.uuid ?? ''),
    role: 'user',
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    model: null,
    isSidechain: o.isSidechain === true,
    parentToolUseId: null,
    blocks: [{ type: 'text', text: o.content }],
  };
}

/**
 * A message the CLI took into the turn it was running, at a tool boundary: it records it only as an
 * `attachment` of type `queued_command`, never as a `user` line, so without this the message the
 * agent read and answered is missing from every read of the transcript. It is the person's entry,
 * in place, under the id the message was sent with (`source_uuid`, the stream-json `uuid`), which
 * is the id the page and the server know it by; a line written without one keeps its own.
 */
function queuedCommand(o: Record<string, unknown>): TranscriptEntry | null {
  if (o.isMeta === true) return null;
  const attachment = o.attachment as Record<string, unknown> | undefined;
  if (!attachment || attachment.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null;
  const blocks = toBlocks(attachment.prompt);
  if (blocks.length === 0) return null;
  const source = typeof attachment.source_uuid === 'string' && attachment.source_uuid ? attachment.source_uuid : null;
  return {
    uuid: source ?? String(o.uuid ?? ''),
    role: 'user',
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    model: null,
    isSidechain: o.isSidechain === true,
    parentToolUseId: null,
    blocks,
  };
}

export function entryText(entry: TranscriptEntry): string {
  return entry.blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Whether the CLI reported a real model name.
 *
 * It stamps the messages it makes up itself — an error it synthesised when a session hit its
 * limit, say — with a placeholder in angle brackets where a model would go. Read back as the
 * model of the chat those messages landed in, the placeholder returns as `--model <synthetic>`
 * on the next resume, which the CLI refuses: one bad minute becomes a chat that never starts
 * again. Everything that takes a model from a transcript asks this first.
 */
export function isModelName(model: string | null | undefined): model is string {
  return typeof model === 'string' && model !== '' && !model.startsWith('<');
}
