import type { TranscriptSearchHit } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ChevronLeft, CircleSlash, GitFork, Lock, MessageSquare, Radio, Square, Trash2, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
// Direct imports: this page is in the shell bundle, and the barrel would pull the lazy form controls into it
import { Switch } from '../components/controls/Toggle';
import { Tooltip } from '../components/controls/Tooltip';
import { ControlBadge, LastOutcome, OriginBadge, StateBadge } from '../components/ChatBadges';
import { useDeleteChat } from '../components/ChatDelete';
import { PermissionPrompts } from '../components/PermissionPrompts';
import { ICON, ICON_SM } from '../components/icons';
import { AnimatePresence, motion, ThinkingDots } from '../components/motion';
import { StreamingEntry, Transcript } from '../components/Transcript';
import { FindBar, FindButton, useFindFocus, useFindHighlight, useTranscriptFind } from '../components/TranscriptSearch';
import { Card, Empty, ErrorBox, Loading, PageHeader, usePageTitle } from '../components/ui';
import { chatApi, chatKeys, useChatFeed, useChatStream, useChatTranscript } from '../lib/chats';
import { ORIGIN_LABEL } from '../lib/chat-model';
import { formatDateTime } from '../lib/format';
import { Composer, type ComposerKind } from './chat/Composer';
import { BranchesCard, EnvironmentCard, ExecutionsCard, FactsCard, HealthCard, UsageCard } from './chat/Side';

/** One chat: its conversation, what it has cost, what it has run and delegated, and what can be done with it now. */
export function ChatView() {
  useChatFeed();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sidechains, setSidechains] = useState(false);
  const [forking, setForking] = useState(false);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const transcript = useChatTranscript(id, sidechains);
  const { chat } = transcript;
  const stream = useChatStream(id, Boolean(chat?.execution));
  usePageTitle(chat ? `${chat.title} · chat` : 'Chat');

  // Another chat starts at its end, with nothing half-typed for a copy of the last one
  useEffect(() => {
    setFollow(true);
    setForking(false);
  }, [id]);

  const find = useTranscriptFind({
    scope: ['chat', id, sidechains],
    search: useCallback((q: string) => chatApi.search(id, q, sidechains), [id, sidechains]),
  });
  const focus = useFindFocus(find.target, transcript.items, transcript.from, transcript.reach);
  useFindHighlight(scroller, find);
  // Jumping to a hit is the reader moving: the bottom must not pull them back
  useEffect(() => {
    if (find.target) setFollow(false);
  }, [find.target]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: chatKeys.chat(id) });
    void queryClient.invalidateQueries({ queryKey: chatKeys.lists });
  };
  const stop = useMutation({ mutationFn: () => chatApi.stop(id), onSuccess: invalidate });
  const interrupt = useMutation({ mutationFn: () => chatApi.interrupt(id), onSuccess: invalidate });
  const remove = useDeleteChat(() => navigate('/chats'));

  // Stay pinned to the bottom while content grows (stored messages and the streaming block alike)
  const entryCount = transcript.items.length;
  useEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [entryCount, stream.partial, follow, chat?.state]);

  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setFollow(true);
  };

  if (transcript.query.isLoading) return <Loading label="Loading chat…" />;
  if (!chat) {
    return (
      <>
        <PageHeader title="Chat" />
        <ErrorBox error={transcript.query.error} />
        <Empty icon={MessageSquare} title="Chat not found">
          It may have been deleted. <Link to="/chats">Browse chats</Link> to find the conversation.
        </Empty>
      </>
    );
  }

  const { control } = chat;
  const working = chat.state === 'working';
  const live = Boolean(chat.execution);
  const composer: ComposerKind | null = forking ? 'fork' : control.mode === 'interactive' ? 'send' : control.mode === 'resumable' ? 'resume' : null;
  const held = control.mode === 'readOnly';
  const origin = chat.orchestration ? `${chat.orchestration.name} · ${chat.orchestration.taskName ?? 'synthesis'}` : ORIGIN_LABEL[chat.origin];

  return (
    <div className="run-layout">
      <section className="run-main" aria-label="Conversation">
        <header className="run-head">
          <div className="run-title">
            <Tooltip content="Back to chats">
              <Link to="/chats" className="icon-btn" aria-label="Back to chats">
                <ChevronLeft {...ICON} />
              </Link>
            </Tooltip>
            <h1 className="ellipsis">{chat.title}</h1>
            <StateBadge state={chat.state} />
            <ControlBadge control={control} />
            <LastOutcome chat={chat} />
            {live && (
              <span className={`badge ${stream.connected ? 'badge-ok' : 'badge-warn'}`} title={stream.connected ? 'Stream connected' : 'Stream reconnecting…'}>
                {stream.connected ? <Radio size={12} strokeWidth={2} aria-hidden /> : <WifiOff size={12} strokeWidth={2} aria-hidden />}
                {stream.connected ? 'Live' : 'Reconnecting…'}
              </span>
            )}
          </div>
          <div className="page-actions">
            <FindButton find={find} />
            <Switch checked={sidechains} onChange={setSidechains}>
              Subagent messages
            </Switch>
            {control.mode === 'interactive' && working && (
              <Tooltip content="End this turn and keep the chat open for your next message">
                <button className="btn" disabled={interrupt.isPending} onClick={() => interrupt.mutate()}>
                  <CircleSlash {...ICON_SM} />
                  Interrupt
                </button>
              </Tooltip>
            )}
            {control.mode === 'interactive' && (
              <button className="btn btn-danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
                <Square {...ICON_SM} />
                Stop
              </button>
            )}
            <Tooltip content="Continue in a copy of this chat, which leaves this one as it is">
              <button className="btn" aria-pressed={forking} onClick={() => setForking((open) => !open)}>
                <GitFork {...ICON_SM} />
                Fork
              </button>
            </Tooltip>
            {/* The wrapper keeps the tooltip reachable while the button is disabled */}
            <Tooltip content={live ? 'A chat with a process working on it cannot be deleted' : held ? 'Something else holds this chat' : 'Delete the transcript'}>
              <span className="tooltip-anchor">
                <button className="btn" disabled={live || held || remove.isPending} onClick={() => remove.requestDelete(chat)}>
                  <Trash2 {...ICON_SM} />
                  {remove.isPending ? 'Deleting…' : 'Delete'}
                </button>
              </span>
            </Tooltip>
          </div>
        </header>
        <div className="meta">
          <OriginBadge origin={chat.origin} label={origin} />
          <span>{chat.project?.name ?? 'no project'}</span>
          <span>{chat.messageCount} messages</span>
          <span>updated {formatDateTime(chat.updatedAt)}</span>
          <span className="mono">{chat.id}</span>
        </div>
        <ErrorBox error={stop.error ?? interrupt.error} />
        {control.mode === 'readOnly' && (
          <div className="alert alert-warn chat-banner" role="status">
            <Lock {...ICON} className="alert-icon" />
            <div className="alert-body">
              <strong>Read-only</strong>
              <div>{control.reason}</div>
            </div>
            {control.action === 'hint' && chat.orchestration ? (
              <Link to={`/orchestration/${chat.orchestration.id}`} className="btn btn-small">
                Send a hint on the board
              </Link>
            ) : (
              !forking && (
                <button className="btn btn-small" onClick={() => setForking(true)}>
                  <GitFork {...ICON_SM} /> Continue in a copy
                </button>
              )
            )}
          </div>
        )}
        <FindBar find={find} />

        <div className="run-stage">
          {/* Focusable so the keyboard can scroll a transcript that holds nothing else to focus */}
          <div
            className="run-scroll"
            role="region"
            aria-label="Transcript"
            tabIndex={0}
            data-scroll-root
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
            }}
          >
            {transcript.more && (
              <div className="transcript-earlier">
                <button type="button" className="btn btn-small" onClick={transcript.loadEarlier} disabled={transcript.loadingMore}>
                  {transcript.loadingMore ? 'Loading…' : `Load earlier messages (${transcript.from} above)`}
                </button>
              </div>
            )}
            {transcript.items.length === 0 ? (
              !working && <Empty icon={MessageSquare} title="Nothing written yet" />
            ) : (
              <Transcript entries={transcript.items} pinToBottom={follow} onReachTop={transcript.loadEarlier} focus={focus} />
            )}
            {/* Pinned under the transcript: a chat waiting on a decision is stuck until it gets one */}
            <PermissionPrompts chatId={id} live={live} />
            {stream.partial && stream.partial.text ? (
              <StreamingEntry block={stream.partial.block} text={stream.partial.text} />
            ) : (
              working && (
                <div className="evt evt-working">
                  <ThinkingDots /> Claude is working…
                </div>
              )
            )}
          </div>
          <AnimatePresence>
            {!follow && (
              <motion.button
                type="button"
                className="jump-latest"
                onClick={jumpToLatest}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.16 }}
              >
                <ArrowDown {...ICON_SM} /> Jump to latest
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {composer === 'fork' && (
          <Card
            title="Continue in a copy"
            actions={
              <button className="btn btn-small" onClick={() => setForking(false)}>
                Cancel
              </button>
            }
          >
            <p className="muted small">A new chat with this one&apos;s whole history. This chat stays as it is, and the copy records where it came from.</p>
            <Composer chat={chat} kind="fork" onSent={() => setFollow(true)} />
          </Card>
        )}
        {composer && composer !== 'fork' && <Composer chat={chat} kind={composer} onSent={() => setFollow(true)} />}
      </section>

      <aside className="run-side" aria-label="Chat details">
        <UsageCard chat={chat} />
        <FactsCard chat={chat} />
        <ExecutionsCard chat={chat} />
        <BranchesCard chat={chat} />
        <HealthCard chat={chat} />
        <EnvironmentCard chat={chat} />
      </aside>
    </div>
  );
}
