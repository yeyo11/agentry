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

export function entryText(entry: TranscriptEntry): string {
  return entry.blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
