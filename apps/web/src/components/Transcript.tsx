import type { ContentBlock, TranscriptEntry } from '@agentry/shared';
import { Brain, CircleAlert, CornerDownRight, Sparkles, User } from 'lucide-react';
import { lazy, memo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { formatClock, truncate } from '../lib/format';
import { AttachedFiles, MediaBlock, splitAttached } from './Attachments';
import { CodeBlock } from './CodeBlock';
import { Collapsible } from './controls/Collapsible';
import { BrandMark, ICON_SM, toolIcon } from './icons';
import { VirtualList } from './VirtualList';

const RESULT_PREVIEW_CHARS = 6000;

const Markdown = lazy(() => import('./Markdown'));

/**
 * Markdown the way chat apps show it: GFM tables and task lists, highlighted code, safe links. The
 * renderer loads on first use; until then the text shows as typed, so nothing waits on it.
 * `streaming` marks text that is still growing, so only its last block is parsed on every update.
 */
export const RichText = memo(function RichText({ text, className = '', streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={`rich md ${className}`}>
      <Suspense fallback={<div className="prose">{text}</div>}>
        <Markdown text={text} streaming={streaming} />
      </Suspense>
    </div>
  );
});

function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill']) {
    const value = o[key];
    if (typeof value === 'string' && value) return truncate(value.replace(/\s+/g, ' '), 110);
  }
  return '';
}

function Block({ block, role }: { block: ContentBlock; role: 'user' | 'assistant' }) {
  const { t } = useTranslation('components');
  switch (block.type) {
    case 'text': {
      const { text, files } = splitAttached(block.text);
      return (
        <>
          {/* What a person typed is shown as typed, the way chat apps do; Claude's answers are markdown */}
          {text.trim() && (role === 'user' ? <div className="prose">{text.trim()}</div> : <RichText text={text} />)}
          <AttachedFiles files={files} />
        </>
      );
    }
    case 'image':
    case 'document':
      return <MediaBlock kind={block.type} mediaType={block.mediaType} name={block.name} uploadId={block.uploadId} />;
    case 'thinking':
      return (
        <Collapsible
          className="fold fold-thinking"
          title={
            <>
              <Brain {...ICON_SM} className="fold-icon" />
              <span className="tool-name">{t('transcript.thinking')}</span>
            </>
          }
        >
          <div className="prose muted fold-body">{block.text}</div>
        </Collapsible>
      );
    case 'tool_use': {
      const ToolIcon = toolIcon(block.name);
      return (
        <Collapsible
          className="fold fold-tool"
          title={
            <>
              <ToolIcon {...ICON_SM} className="fold-icon" />
              <span className="tool-name">{block.name}</span>
              <span className="tool-hint">{toolHint(block.input)}</span>
            </>
          }
        >
          <CodeBlock code={JSON.stringify(block.input, null, 2)} lang="json" />
        </Collapsible>
      );
    }
    case 'tool_result': {
      const long = block.content.length > RESULT_PREVIEW_CHARS;
      return (
        <Collapsible
          className={`fold fold-result ${block.isError ? 'is-error' : ''}`}
          title={
            <>
              {block.isError ? <CircleAlert {...ICON_SM} className="fold-icon" /> : <CornerDownRight {...ICON_SM} className="fold-icon" />}
              <span className="tool-name">{block.isError ? t('transcript.toolError') : t('transcript.toolResult')}</span>
              <span className="tool-hint">{truncate(block.content.replace(/\s+/g, ' '), 110) || t('transcript.empty')}</span>
            </>
          }
        >
          <CodeBlock
            tone={block.isError ? 'error' : undefined}
            code={long ? `${block.content.slice(0, RESULT_PREVIEW_CHARS)}\n${t('transcript.moreChars', { count: block.content.length - RESULT_PREVIEW_CHARS })}` : block.content}
          />
        </Collapsible>
      );
    }
  }
}

/**
 * A message sent through the wrapper names its files in a list, which shows each one; the image and
 * PDF blocks it also carries would show them twice.
 */
function withoutListedMedia(blocks: ContentBlock[]): ContentBlock[] {
  const listed = blocks.some((b) => b.type === 'text' && b.text.includes('<attached-files>'));
  return listed ? blocks.filter((b) => b.type !== 'image' && b.type !== 'document') : blocks;
}

export const EntryView = memo(function EntryView({ entry }: { entry: TranscriptEntry }) {
  const { t } = useTranslation('components');
  const onlyToolResults = entry.role === 'user' && entry.blocks.every((b) => b.type === 'tool_result');
  const role = onlyToolResults ? 'tool' : entry.role;
  return (
    <article className={`msg msg-${role} ${entry.isSidechain ? 'msg-sidechain' : ''}`}>
      {!onlyToolResults && <Avatar role={entry.role} />}
      <div className="msg-body">
        {!onlyToolResults && (
          <header className="msg-head">
            <span className="msg-role">{entry.role === 'user' ? t('transcript.user') : 'Claude'}</span>
            {entry.isSidechain && <span className="badge badge-info">{t('transcript.subagent')}</span>}
            {entry.model && <span className="muted small msg-model">{entry.model}</span>}
            <span className="muted small msg-time">{formatClock(entry.timestamp)}</span>
          </header>
        )}
        {withoutListedMedia(entry.blocks).map((block, i) => (
          <Block key={i} block={block} role={entry.role} />
        ))}
      </div>
    </article>
  );
});

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  return (
    <span className={`avatar avatar-${role}`} aria-hidden>
      {role === 'user' ? <User {...ICON_SM} /> : <BrandMark size={26} />}
    </span>
  );
}

/** The block Claude is generating right now, fed by ephemeral `partial` stream events. */
export function StreamingEntry({ block, text }: { block: 'text' | 'thinking'; text: string }) {
  const { t } = useTranslation('components');
  return (
    <article className="msg msg-assistant msg-streaming" aria-live="off">
      <Avatar role="assistant" />
      <div className="msg-body">
        <header className="msg-head">
          <span className="msg-role">Claude</span>
          <span className="badge badge-active">
            <Sparkles {...ICON_SM} /> {block === 'thinking' ? t('transcript.streamingThinking') : t('transcript.streamingWriting')}
          </span>
        </header>
        {block === 'thinking' ? (
          <div className="streaming-thinking">
            <div className="streaming-thinking-label">
              <Brain {...ICON_SM} /> {t('transcript.thinkingNow')}
            </div>
            <div className="prose muted">{text.length > 1200 ? `…${text.slice(-1200)}` : text}</div>
          </div>
        ) : (
          <RichText text={text} className="streaming-text" streaming />
        )}
      </div>
    </article>
  );
}

export function Transcript({
  entries,
  pinToBottom = false,
  onReachTop,
  focus,
}: {
  entries: TranscriptEntry[];
  pinToBottom?: boolean;
  onReachTop?: () => void;
  focus?: { item: TranscriptEntry } | null;
}) {
  return (
    <VirtualList
      className="transcript"
      items={entries}
      itemKey={(entry, i) => entry.uuid || String(i)}
      pinToBottom={pinToBottom}
      onReachTop={onReachTop}
      focus={focus}
    >
      {(entry) => <EntryView entry={entry} />}
    </VirtualList>
  );
}
