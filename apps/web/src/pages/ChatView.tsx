import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, GitFork, Hourglass, Lock, MessageSquare, TriangleAlert, Undo2, X } from 'lucide-react';
import type { Chat } from '@agentry/shared';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ActivityTicker } from '../components/ActivityTicker';
import { Tooltip } from '../components/controls/Tooltip';
import { useDeleteChat } from '../components/ChatDelete';
import { PermissionPrompts } from '../components/PermissionPrompts';
import { ICON, ICON_SM } from '../components/icons';
import { AnimatePresence, motion } from '../components/motion';
import { endsWithAssistant, StreamingEntry, Transcript, type SubagentLink, type WorkflowLaunches } from '../components/Transcript';
import { FindBar, useFindFocus, useFindHighlight, useTranscriptFind } from '../components/TranscriptSearch';
import { Empty, ErrorBox, Loading, PageHeader, Skeleton, usePageTitle } from '../components/ui';
import { api, ApiRequestError, keys } from '../api';
import { tickerActivity } from '../lib/chat-live';
import { displayTitle } from '../lib/chat-model';
import { subagentFor, transcriptRows } from '../lib/chat-steps';
import type { ChatStreamStore } from '../lib/chat-stream';
import { useChatStream, useChatTranscript, useStreamSnapshot } from '../lib/chats';
import { useDetailPanel } from '../lib/detail';
import { Composer, type ComposerKind } from './chat/Composer';
import { ChatHeader, type HeaderActions } from './chat/Header';
import { Inspector, useInspector } from './chat/Inspector';
import { useQueuedMessages } from './chat/queued';
import { useStickToBottom } from './chat/stick-to-bottom';

/**
 * The end of the conversation that moves while Claude writes: the block being streamed and the
 * ticker under it. The only part of the page that reads the stream's text, so it is the only part
 * rendered again on every frame of it.
 */
const LiveTail = memo(function LiveTail({ stream, chat, continued }: { stream: ChatStreamStore; chat: Chat; continued: boolean }) {
  const partial = useStreamSnapshot(stream, (snapshot) => snapshot.partial);
  const block = partial?.block;
  const since = partial?.since;
  // The ticker only changes with the block, not with each character of it
  const activity = useMemo(() => tickerActivity(chat, block && since !== undefined ? { block, since } : null), [chat, block, since]);
  return (
    <>
      {partial && partial.text && <StreamingEntry block={partial.block} text={partial.text} continued={continued} />}
      {activity && (
        <div className="chat-now" data-find-ignore>
          <ActivityTicker activity={activity} showElapsed={Boolean(activity.since)} />
        </div>
      )}
    </>
  );
});

/** One chat: its conversation, what it has cost, what it has run and delegated, and what can be done with it now. */
export function ChatView() {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useDetailPanel();
  const [sidechains, setSidechains] = useState(false);
  const [forking, setForking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inspector = useInspector();

  const transcript = useChatTranscript(id, sidechains);
  const { chat } = transcript;
  const stream = useChatStream(id, Boolean(chat?.execution));
  const connected = useStreamSnapshot(stream, (snapshot) => snapshot.connected);
  const writing = useStreamSnapshot(stream, (snapshot) => snapshot.partial?.block === 'text');
  const { follow, setFollow, jumpToLatest } = useStickToBottom(scroller, Boolean(chat));
  const { queued, add: queueMessage, drop: dropQueued, pending: isPending } = useQueuedMessages(chat, transcript.items);
  // Words handed back to the composer: a message the chat ended without ever reading
  const [restore, setRestore] = useState<{ text: string; at: number } | null>(null);
  // A message still waiting for the turn is a card over the box, so it is not also a row here
  const items = useMemo(() => (queued.length === 0 ? transcript.items : transcript.items.filter((entry) => !isPending(entry))), [transcript.items, queued.length, isPending]);
  usePageTitle(chat ? t('view.pageTitle', { title: displayTitle(chat) }) : t('view.pageTitleFallback'));

  // Another chat starts at its end, with nothing half-typed for a copy of the last one
  useEffect(() => {
    setFollow(true);
    setForking(false);
  }, [id, setFollow]);

  // A block that has been stored leaves the stream once the transcript shows it, in the same
  // frame, so it neither blinks out nor shows twice; one that went quiet goes with it. By the
  // entry's id, not its object: every read of the transcript hands back new objects for the same
  // entries, and a pause in a block's text is not its end
  const last = transcript.items.at(-1);
  const lastKey = last ? last.uuid || `#${transcript.from + transcript.items.length}` : '';
  useLayoutEffect(() => stream.settle(), [lastKey, stream]);

  const find = useTranscriptFind({
    scope: ['chat', id, sidechains],
    search: useCallback((q: string) => api.searchChat(id, sidechains, q), [id, sidechains]),
  });
  const focus = useFindFocus(find.target, transcript.items, transcript.from, transcript.reach);
  useFindHighlight(scroller, find);
  // Jumping to a hit is the reader moving: the bottom must not pull them back
  useEffect(() => {
    if (find.target) setFollow(false);
  }, [find.target, setFollow]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.chatScope(id) });
    void queryClient.invalidateQueries({ queryKey: keys.chats });
  };
  const { mutate: stopChat, isPending: stopping, error: stopError } = useMutation({ mutationFn: () => api.stopChat(id), onSuccess: invalidate });
  const { mutate: interruptChat, isPending: interrupting, error: interruptError } = useMutation({
    mutationFn: () => api.interruptChat(id),
    onSuccess: invalidate,
  });
  const remove = useDeleteChat(() => navigate('/chats'));
  // Read when pressed, not when the header's actions are built: both change on every render
  const toDelete = useRef({ request: remove.requestDelete, chat });
  useLayoutEffect(() => {
    toDelete.current = { request: remove.requestDelete, chat };
  });

  const rows = useMemo(() => transcriptRows(items), [items]);
  const subagentList = chat?.children.subagents;
  const openDetail = detail.open;
  const subagents = useMemo<SubagentLink | undefined>(
    () =>
      subagentList && subagentList.length > 0
        ? { find: (input) => subagentFor(input, subagentList)?.id ?? null, open: (agentId) => openDetail({ kind: 'subagent', chatId: id, agentId }) }
        : undefined,
    [subagentList, openDetail, id],
  );

  // A workflow the chat started is a card in the conversation; its whole card is in the inspector
  const workflowList = chat?.children.workflows;
  const showInspector = inspector.show;
  const workflows = useMemo<WorkflowLaunches | undefined>(
    () => (workflowList && workflowList.length > 0 ? { list: workflowList, open: () => showInspector('environment') } : undefined),
    [workflowList, showInspector],
  );

  const { open: findOpen, show: findShow, close: findClose } = find;
  const actions = useMemo<HeaderActions>(
    () => ({
      find: { open: findOpen, show: findShow, close: findClose },
      sidechains,
      setSidechains,
      forking,
      setForking,
      stop: { run: () => stopChat(), pending: stopping },
      interrupt: { run: () => interruptChat(), pending: interrupting },
      remove: {
        run: () => {
          const { request, chat: current } = toDelete.current;
          if (current) request(current);
        },
        pending: remove.isPending,
      },
      inspector,
    }),
    [findOpen, findShow, findClose, sidechains, forking, stopChat, stopping, interruptChat, interrupting, remove.isPending, inspector],
  );

  if (transcript.query.isLoading) return <Loading label={t('view.loading')} />;
  if (!chat) {
    return (
      <>
        <PageHeader title={t('view.pageTitleFallback')} />
        {/* A chat that is not there is what the illustration says; any other failure is said too */}
        {!(transcript.query.error instanceof ApiRequestError && transcript.query.error.status === 404) && <ErrorBox error={transcript.query.error} />}
        <Empty illustration="not-found" title={t('view.notFound')}>
          <Trans t={t} i18nKey="view.notFoundHint" components={{ anchor: <Link to="/chats" /> }} />
        </Empty>
      </>
    );
  }

  const { control } = chat;
  const working = chat.state === 'working';
  const live = Boolean(chat.execution);
  const composer: ComposerKind | null = forking ? 'fork' : control.mode === 'interactive' ? 'send' : control.mode === 'resumable' ? 'resume' : null;
  // While Claude writes the answer after its calls, the step above is done, not current
  const stepCurrent = working && !writing;

  return (
    <div className={`run-layout ${inspector.rail ? 'has-inspector' : ''}`.trim()}>
      <section className="run-main" aria-label={t('view.conversation')}>
        <ChatHeader chat={chat} connected={connected} actions={actions} />
        <ErrorBox error={stopError ?? interruptError} />
        {control.mode === 'readOnly' && (
          <div className="alert alert-warn chat-banner" role="status">
            <Lock {...ICON} className="alert-icon" />
            <div className="alert-body">
              <strong>{t('badges.control.readOnly')}</strong>
              <div>{control.reason}</div>
            </div>
            {control.action === 'hint' && chat.orchestration ? (
              <Link to={`/orchestration/${chat.orchestration.id}`} className="btn btn-small">
                {t('view.sendHint')}
              </Link>
            ) : (
              !forking && (
                <button className="btn btn-small" onClick={() => setForking(true)}>
                  <GitFork {...ICON_SM} /> {t('work:sessionView.continueCopy')}
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
            aria-label={t('view.transcript')}
            tabIndex={0}
            data-scroll-root
            ref={scroller}
          >
            {transcript.more && (
              <div className="transcript-earlier">
                <ErrorBox error={transcript.loadError} />
                {/* While the page before this one is on its way, lines where it will land: the list
                    reserves the room for it either way, and blank room reads as a page that broke */}
                {transcript.loadingMore ? (
                  <Skeleton rows={3} height={5} />
                ) : (
                  <button type="button" className="btn btn-small" onClick={transcript.loadEarlier}>
                    {t('work:sessionView.loadEarlier', { n: transcript.from })}
                  </button>
                )}
              </div>
            )}
            {items.length === 0 ? (
              !working && <Empty icon={MessageSquare} title={t('view.nothingWritten')} />
            ) : (
              <Transcript
                entries={items}
                rows={rows}
                pinToBottom={follow}
                onReachTop={transcript.loadEarlier}
                focus={focus}
                working={stepCurrent}
                subagents={subagents}
                workflows={workflows}
              />
            )}
            {/* Pinned under the transcript: a chat waiting on a decision is stuck until it gets one */}
            <PermissionPrompts chatId={id} live={live} />
            <LiveTail stream={stream} chat={chat} continued={endsWithAssistant(items)} />
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
                <ArrowDown {...ICON_SM} /> {t('work:runView.jumpToLatest')}
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {composer === 'fork' && (
          <div className="chat-fork" role="group" aria-label={t('work:sessionView.continueCopy')}>
            <div className="chat-fork-head">
              <GitFork {...ICON_SM} aria-hidden />
              <span className="small">{t('view.forkIntro')}</span>
              <button type="button" className="icon-btn" aria-label={t('view.cancelFork')} onClick={() => setForking(false)}>
                <X {...ICON_SM} />
              </button>
            </div>
            <Composer key={chat.id} chat={chat} kind="fork" onSent={() => setFollow(true)} />
          </div>
        )}
        {queued.length > 0 && (
          <div className={`chat-queued ${queued.every((message) => message.undelivered) ? 'is-lost' : ''}`.trimEnd()} role="status" aria-label={t('view.queued.title')}>
            <ul className="chat-queued-list">
              {queued.map((message) => (
                <li key={message.id} className="chat-queued-item">
                  {message.undelivered ? <TriangleAlert {...ICON_SM} aria-hidden /> : <Hourglass {...ICON_SM} aria-hidden />}
                  <span className="chat-queued-text">{message.text || t('view.queued.files', { count: message.files })}</span>
                  {message.undelivered && message.text && (
                    <Tooltip content={t('view.queued.restore')}>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t('view.queued.restore')}
                        onClick={() => {
                          setRestore({ text: message.text, at: Date.now() });
                          dropQueued(message.id);
                        }}
                      >
                        <Undo2 {...ICON_SM} />
                      </button>
                    </Tooltip>
                  )}
                </li>
              ))}
            </ul>
            <div className="chat-queued-foot">
              <span className="small muted">{queued.some((message) => message.undelivered) ? t('view.queued.undelivered') : t('view.queued.hint', { count: queued.length })}</span>
              {!queued.some((message) => message.undelivered) && (
                <Tooltip content={t('view.queued.sendNowHint')}>
                  <button type="button" className="btn btn-small" onClick={() => interruptChat()} disabled={interrupting}>
                    {interrupting ? t('view.queued.sending') : t('view.queued.sendNow')}
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        )}
        {composer && composer !== 'fork' && (
          // Keyed by the chat: a draft and its files belong to the chat they were written in
          <Composer
            key={chat.id}
            chat={chat}
            kind={composer}
            restore={restore}
            onSent={(sent) => {
              setFollow(true);
              // Only a live chat queues: a resume or a fork starts a process that reads it at once
              if (composer === 'send' && working) queueMessage(sent.text, sent.files, transcript.items.at(-1)?.uuid ?? '');
            }}
            interrupt={composer === 'send' ? { run: () => interruptChat(), pending: interrupting } : undefined}
          />
        )}
      </section>

      <Inspector chat={chat} entries={transcript.items} state={inspector} />
    </div>
  );
}
