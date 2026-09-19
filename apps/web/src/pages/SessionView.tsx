import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Radio, TerminalSquare, Trash2 } from 'lucide-react';
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

  if (isLoading) return <Loading label="Loading transcript…" />;
  if (!data) return <ErrorBox error={error ?? new Error('Session not found')} />;
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
            <span>{summary.messageCount} messages</span>
            <span>{formatBytes(summary.sizeBytes)}</span>
            {summary.model && <span>{summary.model}</span>}
            {summary.cliVersion && <span>CLI {summary.cliVersion}</span>}
            <span>updated {formatDateTime(summary.updatedAt)}</span>
          </span>
        }
        actions={
          <>
            {live && <StatusBadge status={live.status} title={`live via ${live.source}`} />}
            <FindButton find={find} />
            {live?.runId && (
              <Link to={`/runs/${live.runId}`} className="btn">
                <Radio {...ICON_SM} /> Open live run
              </Link>
            )}
            <Switch checked={sidechains} onChange={setSidechains}>
              Subagent sidechains
            </Switch>
            {/* The wrapper keeps the tooltip reachable while the button is disabled */}
            <Tooltip content={live ? 'Live sessions cannot be deleted' : 'Delete the transcript'}>
              <span className="tooltip-anchor">
                <button className="btn btn-danger" disabled={Boolean(live) || remove.isPending} onClick={() => remove.requestDelete(summary)}>
                  <Trash2 {...ICON_SM} />
                  {remove.isPending ? 'Deleting…' : 'Delete'}
                </button>
              </span>
            </Tooltip>
            {/* A session a run already drives is continued in that run */}
            {!live?.runId && (
              <button className="btn btn-primary" onClick={() => setResumeOpen((v) => !v)}>
                <Play {...ICON_SM} /> Continue in Agentry
              </button>
            )}
          </>
        }
      />
      <div className="mono small muted">session {summary.id}</div>
      <FindBar find={find} />

      {resumeOpen && !live?.runId && (
        <Card title="Continue in Agentry">
          <p className="muted small">
            Starts a run that picks this conversation up with its whole history. From then on you answer its questions and
            permissions, interrupt it and change its mode or model from the panel.
          </p>
          {openElsewhere && (
            <div className="alert alert-warn" role="alert">
              <TerminalSquare {...ICON_SM} className="alert-icon" />
              <div className="alert-body stack-tight">
                <span>
                  This session is still open in a terminal. To hand it over, close it there first (<code>/exit</code>) and
                  continue it as is. Otherwise continue in a copy: a new session with the same history that leaves the
                  terminal&apos;s untouched.
                </span>
                <Switch checked={asCopy} onChange={setAsCopy}>
                  Continue in a copy
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
              placeholder="Next message for Claude… (drop or paste files to attach them)"
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
                {resume.isPending ? 'Starting…' : files.uploading ? 'Uploading…' : fork ? 'Continue in a copy' : 'Continue'}
              </button>
              <span className="muted small">Runs in {summary.projectPath || 'the wrapper workspace'}</span>
            </div>
          </form>
        </Card>
      )}

      {entries.length === 0 ? (
        <Empty title="Empty transcript" />
      ) : (
        <>
          {transcript.more && (
            <div className="transcript-earlier">
              <button type="button" className="btn btn-small" onClick={transcript.loadEarlier} disabled={transcript.loadingMore}>
                {transcript.loadingMore ? 'Loading…' : `Load earlier messages (${transcript.from} above)`}
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
