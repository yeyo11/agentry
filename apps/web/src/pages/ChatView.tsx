import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, GitFork, Lock, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ActivityTicker } from '../components/ActivityTicker';
import { useDeleteChat } from '../components/ChatDelete';
import { PermissionPrompts } from '../components/PermissionPrompts';
import { ICON, ICON_SM } from '../components/icons';
import { AnimatePresence, motion } from '../components/motion';
import { endsWithAssistant, StreamingEntry, Transcript, type SubagentLink } from '../components/Transcript';
import { FindBar, useFindFocus, useFindHighlight, useTranscriptFind } from '../components/TranscriptSearch';
import { Empty, ErrorBox, Loading, PageHeader, usePageTitle } from '../components/ui';
import { api, keys } from '../api';
import { tickerActivity } from '../lib/chat-live';
import { subagentFor, transcriptRows } from '../lib/chat-steps';
import { useChatStream, useChatTranscript } from '../lib/chats';
import { useDetailPanel } from '../lib/detail';
import { Composer, type ComposerKind } from './chat/Composer';
import { ChatHeader } from './chat/Header';
import { Inspector, useInspector } from './chat/Inspector';

/**
 * How much of the layout the on-screen keyboard covers. A phone's browser shrinks the visual
 * viewport and not the layout one when the keyboard opens, so without this the composer, pinned to
 * the bottom of the page, would sit under the keyboard it opened.
 */
function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    // On the root rather than on the page: the page is not mounted yet while the chat loads
    const root = document.documentElement;
    if (!viewport) return;
    const update = () => {
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty('--keyboard-inset', `${Math.round(covered)}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
}

/** One chat: its conversation, what it has cost, what it has run and delegated, and what can be done with it now. */
export function ChatView() {
  const { t } = useTranslation(['chat', 'work', 'common']);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useDetailPanel();
  const [sidechains, setSidechains] = useState(false);
  const [forking, setForking] = useState(false);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const inspector = useInspector();
  useKeyboardInset();

  const transcript = useChatTranscript(id, sidechains);
  const { chat } = transcript;
  const stream = useChatStream(id, Boolean(chat?.execution));
  usePageTitle(chat ? t('view.pageTitle', { title: chat.title }) : t('view.pageTitleFallback'));

  // Another chat starts at its end, with nothing half-typed for a copy of the last one
  useEffect(() => {
    setFollow(true);
    setForking(false);
  }, [id]);

  const find = useTranscriptFind({
    scope: ['chat', id, sidechains],
    search: useCallback((q: string) => api.searchChat(id, sidechains, q), [id, sidechains]),
  });
  const focus = useFindFocus(find.target, transcript.items, transcript.from, transcript.reach);
  useFindHighlight(scroller, find);
  // Jumping to a hit is the reader moving: the bottom must not pull them back
  useEffect(() => {
    if (find.target) setFollow(false);
  }, [find.target]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.chatScope(id) });
    void queryClient.invalidateQueries({ queryKey: keys.chats });
  };
  const stop = useMutation({ mutationFn: () => api.stopChat(id), onSuccess: invalidate });
  const interrupt = useMutation({ mutationFn: () => api.interruptChat(id), onSuccess: invalidate });
  const remove = useDeleteChat(() => navigate('/chats'));

  const rows = useMemo(() => transcriptRows(transcript.items), [transcript.items]);
  const subagentList = chat?.children.subagents;
  const subagents = useMemo<SubagentLink | undefined>(
    () =>
      subagentList && subagentList.length > 0
        ? { find: (input) => subagentFor(input, subagentList)?.id ?? null, open: (agentId) => detail.open({ kind: 'subagent', chatId: id, agentId }) }
        : undefined,
    [subagentList, detail, id],
  );

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

  if (transcript.query.isLoading) return <Loading label={t('view.loading')} />;
  if (!chat) {
    return (
      <>
        <PageHeader title={t('view.pageTitleFallback')} />
        <ErrorBox error={transcript.query.error} />
        <Empty icon={MessageSquare} title={t('view.notFound')}>
          <Trans t={t} i18nKey="view.notFoundHint" components={{ anchor: <Link to="/chats" /> }} />
        </Empty>
      </>
    );
  }

  const { control } = chat;
  const working = chat.state === 'working';
  const live = Boolean(chat.execution);
  const composer: ComposerKind | null = forking ? 'fork' : control.mode === 'interactive' ? 'send' : control.mode === 'resumable' ? 'resume' : null;
  const activity = tickerActivity(chat, stream.partial);
  // While Claude writes the answer after its calls, the step above is done, not current
  const stepCurrent = working && stream.partial?.block !== 'text';

  return (
    <div className={`run-layout ${inspector.wide && inspector.open ? 'has-inspector' : ''}`.trim()}>
      <section className="run-main" aria-label={t('view.conversation')}>
        <ChatHeader
          chat={chat}
          connected={stream.connected}
          actions={{
            find,
            sidechains,
            setSidechains,
            forking,
            setForking,
            stop: { run: () => stop.mutate(), pending: stop.isPending },
            interrupt: { run: () => interrupt.mutate(), pending: interrupt.isPending },
            remove: { run: () => remove.requestDelete(chat), pending: remove.isPending },
            inspector: { open: inspector.open, toggle: inspector.toggle, show: inspector.show },
          }}
        />
        <ErrorBox error={stop.error ?? interrupt.error} />
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
            onScroll={(e) => {
              const el = e.currentTarget;
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
            }}
          >
            {transcript.more && (
              <div className="transcript-earlier">
                <button type="button" className="btn btn-small" onClick={transcript.loadEarlier} disabled={transcript.loadingMore}>
                  {transcript.loadingMore ? t('common:loading') : t('work:sessionView.loadEarlier', { n: transcript.from })}
                </button>
              </div>
            )}
            {transcript.items.length === 0 ? (
              !working && <Empty icon={MessageSquare} title={t('view.nothingWritten')} />
            ) : (
              <Transcript
                entries={transcript.items}
                rows={rows}
                pinToBottom={follow}
                onReachTop={transcript.loadEarlier}
                focus={focus}
                working={stepCurrent}
                subagents={subagents}
              />
            )}
            {/* Pinned under the transcript: a chat waiting on a decision is stuck until it gets one */}
            <PermissionPrompts chatId={id} live={live} />
            {stream.partial && stream.partial.text && <StreamingEntry block={stream.partial.block} text={stream.partial.text} continued={endsWithAssistant(transcript.items)} />}
            {activity && (
              <div className="chat-now">
                <ActivityTicker activity={activity} showElapsed={Boolean(activity.since)} />
              </div>
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
            <Composer chat={chat} kind="fork" onSent={() => setFollow(true)} />
          </div>
        )}
        {composer && composer !== 'fork' && (
          <Composer
            chat={chat}
            kind={composer}
            onSent={() => setFollow(true)}
            interrupt={composer === 'send' ? { run: () => interrupt.mutate(), pending: interrupt.isPending } : undefined}
          />
        )}
      </section>

      <Inspector chat={chat} entries={transcript.items} state={inspector} />
    </div>
  );
}
