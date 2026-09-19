import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Radio, TerminalSquare, Trash2 } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, useSessionTranscript } from '../api';
import { AttachButton, AttachmentTray, useAttachments } from '../components/Attachments';
import { Switch, Tooltip } from '../components/controls';
import { ICON_SM } from '../components/icons';
import { ScrollJump } from '../components/ScrollJump';
import { useDeleteSession } from '../components/SessionDelete';
import { OriginBadge, OriginTrail } from '../components/SessionOrigin';
import { Transcript } from '../components/Transcript';
import { FindBar, FindButton, useFindFocus, useFindHighlight, useTranscriptFind } from '../components/TranscriptSearch';
import { Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge } from '../components/ui';
import { formatBytes, formatDateTime } from '../lib/format';

export function SessionView() {
  const { t } = useTranslation(['work', 'common']);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [sidechains, setSidechains] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [searchParams] = useSearchParams();
  // Sessions list links here with ?resume=1 to land directly on the resume form
  const [resumeOpen, setResumeOpen] = useState(searchParams.get('resume') === '1');
  const remove = useDeleteSession(() => navigate('/sessions'));
  const [wasLive, setWasLive] = useState(false);
  const transcript = useSessionTranscript(id, sidechains, wasLive);
  const { data, error, isLoading } = transcript.query;
  const live = data?.summary.live;
  if (Boolean(live) !== wasLive) setWasLive(Boolean(live));
  // Still open in a terminal: taking it over would leave two processes writing one conversation
  const openElsewhere = live?.source === 'cli';
  const [asCopy, setAsCopy] = useState(true);
  const fork = openElsewhere && asCopy;

  const find = useTranscriptFind({
    scope: ['session', id, sidechains],
    search: useCallback((q: string) => api.searchSession(id, sidechains, q), [id, sidechains]),
  });
  const focus = useFindFocus(find.target, transcript.items, transcript.from, transcript.reach);
  const transcriptBox = useRef<HTMLDivElement>(null);
  useFindHighlight(transcriptBox, find);

  const files = useAttachments();
  const ready = (prompt.trim() || files.ids.length > 0) && !files.uploading;
  const resume = useMutation({
    mutationFn: () =>
      api.startRun({
        prompt: prompt.trim(),
        resumeSessionId: id,
        ...(fork ? { forkSession: true } : {}),
        permissionPrompts: 'host',
        cwd: data?.summary.projectPath || undefined,
        ...(files.ids.length ? { attachments: files.ids } : {}),
      }),
    onSuccess: (run) => navigate(`/runs/${run.id}`),
  });

  // Opening a conversation lands on its latest message, the way any chat client does: a few
  // hundred messages otherwise leave you at the oldest one, a long drag away from what you came for.
  // The transcript is windowed, so the page keeps growing as rows are measured: hold the bottom
  // until it settles, and let go the moment the reader moves.
  const entryCount = transcript.items.length;
  const [landing, setLanding] = useState(true);
  useEffect(() => {
    setLanding(true);
  }, [id]);
  // Jumping to a hit is the reader moving: the bottom must not pull them back
  useEffect(() => {
    if (find.target) setLanding(false);
  }, [find.target]);
  useEffect(() => {
    if (!landing || !entryCount) return;
    const main = document.querySelector<HTMLElement>('.main');
    if (!main) return;
    const release = () => setLanding(false);
    const settled = setTimeout(release, 1500);
    main.addEventListener('wheel', release, { passive: true, once: true });
    main.addEventListener('touchmove', release, { passive: true, once: true });
    window.addEventListener('keydown', release, { once: true });
    return () => {
      clearTimeout(settled);
      main.removeEventListener('wheel', release);
      main.removeEventListener('touchmove', release);
      window.removeEventListener('keydown', release);
    };
  }, [landing, entryCount, id]);

  if (isLoading) return <Loading label={t('sessionView.loading')} />;
  if (!data) return <ErrorBox error={error ?? new Error(t('sessionView.notFound'))} />;
  const { summary } = data;
  const entries = transcript.items;

  return (
    <>
      <PageHeader
        title={summary.title}
        docTitle={summary.title}
        subtitle={
          <span className="meta">
            <OriginBadge session={summary} />
            <OriginTrail session={summary} />
            <Link to={`/sessions?show=all&project=${encodeURIComponent(summary.projectId)}`}>{summary.projectPath}</Link>
            <span>{t('sessionView.messages', { count: summary.messageCount })}</span>
            <span>{formatBytes(summary.sizeBytes)}</span>
            {summary.model && <span>{summary.model}</span>}
            {summary.cliVersion && <span>{t('shared.cliVersion', { version: summary.cliVersion })}</span>}
            <span>{t('sessionView.updated', { date: formatDateTime(summary.updatedAt) })}</span>
          </span>
        }
        actions={
          <>
            {live && <StatusBadge status={live.status} title={t('shared.liveVia', { source: live.source })} />}
            <FindButton find={find} />
            {live?.runId && (
              <Link to={`/runs/${live.runId}`} className="btn">
                <Radio {...ICON_SM} /> {t('sessionView.openLiveRun')}
              </Link>
            )}
            <Switch checked={sidechains} onChange={setSidechains}>
              {t('sessionView.sidechains')}
            </Switch>
            {/* The wrapper keeps the tooltip reachable while the button is disabled */}
            <Tooltip content={live ? t('shared.liveCannotDelete') : t('sessionView.deleteTranscript')}>
              <span className="tooltip-anchor">
                <button className="btn btn-danger" disabled={Boolean(live) || remove.isPending} onClick={() => remove.requestDelete(summary)}>
                  <Trash2 {...ICON_SM} />
                  {remove.isPending ? t('sessionView.deleting') : t('common:actions.delete')}
                </button>
              </span>
            </Tooltip>
            {/* A session a run already drives is continued in that run */}
            {!live?.runId && (
              <button className="btn btn-primary" onClick={() => setResumeOpen((v) => !v)}>
                <Play {...ICON_SM} /> {t('shared.continueInAgentry')}
              </button>
            )}
          </>
        }
      />
      <div className="mono small muted">{t('sessionView.sessionId', { id: summary.id })}</div>
      <FindBar find={find} />

      {resumeOpen && !live?.runId && (
        <Card title={t('shared.continueInAgentry')}>
          <p className="muted small">{t('sessionView.resumeIntro')}</p>
          {openElsewhere && (
            <div className="alert alert-warn" role="alert">
              <TerminalSquare {...ICON_SM} className="alert-icon" />
              <div className="alert-body stack-tight">
                <span>
                  <Trans t={t} i18nKey="sessionView.openElsewhere" components={{ code: <code /> }} />
                </span>
                <Switch checked={asCopy} onChange={setAsCopy}>
                  {t('sessionView.continueCopy')}
                </Switch>
              </div>
            </div>
          )}
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) resume.mutate();
            }}
            {...files.dropProps}
          >
            <textarea
              autoFocus
              rows={3}
              placeholder={t('sessionView.placeholder')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={files.onPaste}
            />
            <div className="attach-row">
              <AttachButton state={files} disabled={resume.isPending} />
              <AttachmentTray state={files} />
            </div>
            <ErrorBox error={resume.error} />
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={!ready || resume.isPending}>
                {resume.isPending
                  ? t('shared.starting')
                  : files.uploading
                    ? t('shared.uploading')
                    : fork
                      ? t('sessionView.continueCopy')
                      : t('sessionView.continue')}
              </button>
              <span className="muted small">
                {t('sessionView.runsIn', { path: summary.projectPath || t('sessionView.wrapperWorkspace') })}
              </span>
            </div>
          </form>
        </Card>
      )}

      {entries.length === 0 ? (
        <Empty title={t('sessionView.empty')} />
      ) : (
        <>
          {transcript.more && (
            <div className="transcript-earlier">
              <button type="button" className="btn btn-small" onClick={transcript.loadEarlier} disabled={transcript.loadingMore}>
                {transcript.loadingMore ? t('common:loading') : t('sessionView.loadEarlier', { n: transcript.from })}
              </button>
            </div>
          )}
          <div ref={transcriptBox}>
            <Transcript entries={entries} pinToBottom={landing} onReachTop={transcript.loadEarlier} focus={focus} />
          </div>
          <ScrollJump label="transcript" />
        </>
      )}
    </>
  );
}
