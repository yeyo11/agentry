import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Play, Radio, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, useSession } from '../api';
import { AttachButton, AttachmentTray, useAttachments } from '../components/Attachments';
import { Switch, Tooltip } from '../components/controls';
import { ICON_SM } from '../components/icons';
import { ScrollJump } from '../components/ScrollJump';
import { useDeleteSession } from '../components/SessionDelete';
import { OriginBadge, OriginTrail } from '../components/SessionOrigin';
import { Transcript } from '../components/Transcript';
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
  const { data, error, isLoading } = useSession(id, sidechains, wasLive);
  const live = data?.summary.live;
  if (Boolean(live) !== wasLive) setWasLive(Boolean(live));

  const files = useAttachments();
  const ready = (prompt.trim() || files.ids.length > 0) && !files.uploading;
  const resume = useMutation({
    mutationFn: () =>
      api.startRun({
        prompt: prompt.trim(),
        resumeSessionId: id,
        cwd: data?.summary.projectPath || undefined,
        ...(files.ids.length ? { attachments: files.ids } : {}),
      }),
    onSuccess: (run) => navigate(`/runs/${run.id}`),
  });

  // Opening a conversation lands on its latest message, the way any chat client does: a few
  // hundred messages otherwise leave you at the oldest one, a long drag away from what you came for.
  const entryCount = data?.entries.length ?? 0;
  const landedOn = useRef<string | null>(null);
  useEffect(() => {
    if (!entryCount || landedOn.current === id) return;
    landedOn.current = id;
    const main = document.querySelector<HTMLElement>('.main');
    requestAnimationFrame(() => main?.scrollTo({ top: main.scrollHeight }));
  }, [id, entryCount]);

  if (isLoading) return <Loading label="Loading transcript…" />;
  if (!data) return <ErrorBox error={error ?? new Error('Session not found')} />;
  const { summary, entries } = data;

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
            <button className="btn btn-primary" onClick={() => setResumeOpen((v) => !v)}>
              <Play {...ICON_SM} /> Resume in a run
            </button>
          </>
        }
      />
      <div className="mono small muted">session {summary.id}</div>

      {resumeOpen && (
        <Card title="Resume this session">
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
                {resume.isPending ? 'Starting…' : files.uploading ? 'Uploading…' : 'Resume'}
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
          <Transcript entries={entries} />
          <ScrollJump label="transcript" />
        </>
      )}
    </>
  );
}
