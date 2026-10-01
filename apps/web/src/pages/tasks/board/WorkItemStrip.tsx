import type { CodeHostId, FlowRunCause, WorkItem } from '@agentry/shared';
import { Check, CircleAlert, Clock, ExternalLink, GitPullRequest, Workflow, X } from 'lucide-react';
import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@agentry/ui/components/controls/Tooltip';
import { Monogram } from '@agentry/ui/components/icons';
import { ProgressBar } from '@agentry/ui/components/ProgressBar';
import { Spinner } from '@agentry/ui/components/Spinner';
import { activityTarget, activityVerb, elapsedSince, formatElapsed } from '@agentry/ui/lib/live';
import { useClockTick } from '@agentry/ui/lib/motion';
import { chatActivity, orchestrationProgress } from '../../../lib/shell-live';
import { approvalOpensPullRequest, notReadyReason, pullRequestErrorKey, stripOffersApproval, stripTone, type StripActor, type WorkItemStripState } from '../../../lib/work-items';
import { useRoleName } from '../../team/RoleAvatar';
import { roleHue, roleInitials } from '../../team/model';
import type { LiveSources } from './LiveLine';
import { CiBadge, NotReadyNote, reasonValues, useBoardReadiness, useChangeRequestWords, useOpenPullRequest } from './PullRequest';
import { useBoardTeam } from './team';
import { useMoveWorkItem } from './useMoveWorkItem';

const MARK = { size: 13, strokeWidth: 1.75, 'aria-hidden': true } as const;

/** A running clock in `m:ss` that keeps its width; still in a hidden tab, like every loop. */
function RunClock({ since }: { since: string }) {
  const tick = useClockTick(1000);
  // The tick is a dependency, not a value: it is what makes the clock read the time again
  const text = useMemo(() => formatElapsed(elapsedSince(since)), [since, tick]);
  return <time dateTime={since}>{text}</time>;
}

/**
 * The strip's first mark: a role's squircle, the person's round monogram or an orchestration's glyph.
 * Smaller than the card's own marks (18 px), so the words after it lead.
 */
export function StripActorMark({ actor }: { actor: StripActor }) {
  const { t } = useTranslation('tasks');
  const roleName = useRoleName();
  if (actor.kind === 'role') {
    const name = roleName(actor.role);
    return (
      <span className="role-avatar workitem-strip-role" style={{ '--hue': roleHue(actor.role) } as CSSProperties} role="img" aria-label={name} title={name}>
        {roleInitials(actor.role)}
      </span>
    );
  }
  if (actor.kind === 'person') {
    const said = t('strip.yourChat');
    return (
      <span className="workitem-assignee workitem-strip-person" role="img" aria-label={said} title={said}>
        <Monogram name={t('toolbar.person')} size={18} />
      </span>
    );
  }
  const said = t('strip.orchestration');
  return (
    <span className="workitem-strip-orch" role="img" aria-label={said} title={said}>
      <Workflow {...MARK} />
    </span>
  );
}

/** `PR #123` or `MR !7` in mono with tabular figures, or the bare noun while the host has not numbered it yet. */
function PrNumber({ number, refText, host }: { number: number | null; refText: string | null; host: CodeHostId | null }) {
  const { t } = useTranslation('tasks');
  const words = useChangeRequestWords(host);
  return <span className="workitem-strip-num">{number === null ? t('pr.unnumbered', { noun: words.noun }) : t('pr.number', { noun: words.noun, ref: words.ref(number, refText) })}</span>;
}

/** The card's way to its PR or MR on its host: a plain external link that opens it and never the card under it. */
function PrLink({ url, number, refText, host }: { url: string | null; number: number | null; refText: string | null; host: CodeHostId | null }) {
  const { t } = useTranslation('tasks');
  const words = useChangeRequestWords(host);
  if (!url) return null;
  const said = number === null ? t('pr.linkUnnumbered', { noun: words.noun, host: words.host }) : t('pr.link', { noun: words.noun, host: words.host, ref: words.ref(number, refText) });
  return (
    <Tooltip content={said}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="workitem-strip-link"
        aria-label={said}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
      </a>
    </Tooltip>
  );
}

/**
 * What happens to an item now, at the foot of its card or phone row (`.wi-strip`): one state, led by
 * who acts, and nothing when nothing is going on. Live strips move and take the live tint; a card
 * that waits for the person takes the idle one; a failure the bad one with its word and its reason;
 * a conflict the warn one; QA's words on a card it sent back, a place in the queue and Agentry
 * preparing a pull request stay neutral, and still: no agent works on a PR.
 */
export function WorkItemStrip({
  item,
  strip,
  sources,
  inline = false,
}: {
  item: Pick<WorkItem, 'id' | 'key' | 'status'>;
  strip: WorkItemStripState | null;
  sources: LiveSources;
  /** In a list row: the actor and the words on one line, no tint, no button */
  inline?: boolean;
}) {
  const { t } = useTranslation(['tasks', 'primitives']);
  const team = useBoardTeam();
  const roleName = useRoleName();
  const move = useMoveWorkItem();
  const openPr = useOpenPullRequest();
  const readiness = useBoardReadiness();
  // A PR's own host speaks in its strip; the approval before any PR exists speaks in the project's
  const words = useChangeRequestWords(strip && 'host' in strip && strip.host ? strip.host : readiness?.host);
  if (!strip) return null;
  const tone = stripTone(strip);
  const className = ['workitem-strip', tone && `is-${tone}`, inline && 'is-inline'].filter(Boolean).join(' ');
  const verifier = team?.verifier ? roleName(team.verifier) : null;

  // In a ready project the approval opens the item's PR; anywhere else it moves the card to Done, and
  // the strip says why no PR is offered rather than letting it fail silently
  const opensPr = approvalOpensPullRequest(readiness);
  const approval =
    !inline && stripOffersApproval(strip) ? (
      <>
        {!opensPr && notReadyReason(readiness) && <NotReadyNote readiness={readiness} className="workitem-strip-note" />}
        <button
          type="button"
          className={`btn btn-small workitem-approve ${opensPr ? 'is-pr' : ''}`.trim()}
          disabled={move.isPending || openPr.isPending}
          onClick={(event) => {
            // The card around it opens the item; this button only approves
            event.stopPropagation();
            event.preventDefault();
            if (opensPr) openPr.mutate({ ...item, pullRequestReadiness: readiness });
            else move.mutate({ item, drop: { status: 'done', index: 0 }, column: [] });
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {opensPr ? <GitPullRequest size={14} strokeWidth={1.75} aria-hidden /> : <Check size={14} strokeWidth={1.75} aria-hidden />}
          {opensPr ? t('pr.approve', { noun: words.noun }) : t('strip.approve')}
        </button>
      </>
    ) : null;

  let body;
  switch (strip.kind) {
    case 'run': {
      const detail = strip.activity ? activityTarget(strip.activity) : '';
      const since = strip.startedAt ?? strip.activity?.since ?? null;
      body = (
        <>
          <StripActorMark actor={{ kind: 'role', role: strip.role }} />
          <Spinner className="workitem-strip-spin" />
          <span className="workitem-strip-verb">{t(`strip.doing.${strip.step}`)}</span>
          {since && <RunClock since={since} />}
          {detail && <span className="workitem-strip-detail">{detail}</span>}
        </>
      );
      break;
    }
    case 'chat': {
      const activity = chatActivity(sources.chats.find((chat) => chat.id === strip.chatId) ?? {});
      const detail = activity ? activityTarget(activity) : '';
      body = (
        <>
          <StripActorMark actor={{ kind: 'person' }} />
          <Spinner className="workitem-strip-spin" />
          <span className="workitem-strip-verb">{activity ? t(`primitives:activity.${activityVerb(activity)}`) : t('card.working')}</span>
          {activity && <RunClock since={activity.since} />}
          {detail && <span className="workitem-strip-detail">{detail}</span>}
        </>
      );
      break;
    }
    case 'node': {
      const orchestration = sources.orchestrations.find((o) => o.id === strip.orchestrationId);
      const index = orchestration ? orchestration.tasks.findIndex((task) => task.id === strip.taskId) + 1 : 0;
      body = (
        <>
          <StripActorMark actor={{ kind: 'orchestration' }} />
          <Spinner className="workitem-strip-spin" />
          <span className="workitem-strip-verb is-node">
            {orchestration && index > 0 ? t('card.node', { index, total: orchestration.tasks.length }) : t('card.working')}
          </span>
          {orchestration && <ProgressBar variant="segments" size="sm" decorative counts={orchestrationProgress(orchestration.tasks)} className="workitem-strip-bar" />}
        </>
      );
      break;
    }
    case 'chat-waiting':
      body = (
        <>
          <span className="badge badge-idle">{t('strip.waitsForYou')}</span>
          <span className="workitem-strip-verb">{t('strip.chatWaiting')}</span>
        </>
      );
      break;
    case 'bounces':
      body = (
        <>
          <span className="badge badge-idle">{t('strip.waitsForYou')}</span>
          <span className="workitem-strip-verb">
            {verifier ? t('strip.sentBack', { role: verifier, count: strip.count }) : t('strip.sentBackAnon', { count: strip.count })}
          </span>
        </>
      );
      break;
    case 'approval':
      body = (
        <>
          <span className="badge badge-idle">{t('strip.waitsForYou')}</span>
          <span className="workitem-strip-verb">{verifier ? t('strip.passed', { role: verifier }) : t('strip.passedAnon')}</span>
          {approval}
        </>
      );
      break;
    case 'pr-preparing':
      body = (
        <>
          <GitPullRequest {...MARK} />
          <span className="workitem-strip-verb is-quiet">{t('pr.preparing', { noun: words.noun })}</span>
        </>
      );
      break;
    case 'pr-conflict':
      body = (
        <>
          <CircleAlert {...MARK} className="workitem-strip-warn-mark" />
          <span className="workitem-strip-verb">{t('pr.conflict', { base: strip.base, count: strip.count })}</span>
        </>
      );
      break;
    case 'pr-awaiting':
      body = (
        <>
          <GitPullRequest {...MARK} />
          <span className="workitem-strip-verb is-quiet">{t('pr.awaiting', { base: strip.base, noun: words.noun })}</span>
        </>
      );
      break;
    case 'pr-fix': {
      // Comments being addressed read as such: the same fix state, but not the checks
      const review = strip.fix === 'review';
      const verb = review ? t(`address.run.stage.${strip.stage}`, { ns: 'workItem' }) : t(`pr.fix.${strip.stage}`);
      const note = review ? t(`address.run.hint.${strip.stage === 'push' ? 'push' : strip.origin === 'decision' ? 'decision' : 'person'}`, { ns: 'workItem', noun: words.noun }) : t(`pr.fix.note.${strip.stage}.${strip.origin ?? 'person'}`);
      const detail = [strip.attempt > 0 && t('pr.fix.attempt', { count: strip.attempt }), strip.origin && t(`pr.fix.origin.${strip.origin}`), note].filter(Boolean).join(' · ');
      body = (
        <>
          {strip.stage === 'push' && <span className="badge badge-idle">{t('strip.waitsForYou')}</span>}
          <GitPullRequest {...MARK} />
          <PrNumber number={strip.number} refText={strip.ref} host={strip.host} />
          <span className={`workitem-strip-verb ${strip.stage === 'push' ? '' : 'is-quiet'}`.trim()}>{verb}</span>
          {!inline && <span className="workitem-strip-detail">{detail}</span>}
        </>
      );
      break;
    }
    case 'pr-open':
      body = (
        <>
          <GitPullRequest {...MARK} />
          <PrNumber number={strip.number} refText={strip.ref} host={strip.host} />
          <span className="workitem-strip-verb">{t('pr.waitingMerge')}</span>
          <CiBadge ci={strip.ci} />
          {!inline && <PrLink url={strip.url} number={strip.number} refText={strip.ref} host={strip.host} />}
        </>
      );
      break;
    case 'pr-closed':
      body = (
        <>
          <GitPullRequest {...MARK} />
          <PrNumber number={strip.number} refText={strip.ref} host={strip.host} />
          <span className="workitem-strip-verb">{t('pr.closed')}</span>
          {approval}
        </>
      );
      break;
    case 'pr-failed':
      body = (
        <>
          <X {...MARK} className="workitem-strip-fail-mark" />
          <span className="workitem-strip-verb" title={strip.detail ?? undefined}>
            <b>{t('pr.failed', { noun: words.noun })}</b> · {t(pullRequestErrorKey(strip.code), { ...reasonValues(t, { host: strip.host ?? readiness?.host ?? null, hostname: readiness?.hostname ?? null }), host: words.host })}
          </span>
          {approval}
        </>
      );
      break;
    case 'failed':
      body = (
        <>
          <StripActorMark actor={{ kind: 'role', role: strip.role }} />
          <X {...MARK} className="workitem-strip-fail-mark" />
          <span className="workitem-strip-verb" title={strip.error ?? undefined}>
            <b>{t('strip.failed')}</b> {t(`strip.failedStep.${strip.step}`)}
            {strip.cause && isFailureCause(strip.cause) && ` · ${t(`strip.cause.${strip.cause}`)}`}
          </span>
        </>
      );
      break;
    case 'rejected':
      body = (
        <>
          <StripActorMark actor={{ kind: 'role', role: strip.role }} />
          <span className="workitem-strip-verb is-quiet">{strip.quote ? t('strip.quote', { text: strip.quote }) : t('strip.sentBackBy', { role: roleName(strip.role) })}</span>
        </>
      );
      break;
    case 'queued':
      body = (
        <>
          <StripActorMark actor={{ kind: 'role', role: strip.role }} />
          <Clock {...MARK} />
          <span className="workitem-strip-verb is-quiet" title={t('strip.queuedTitle')}>
            {t(`strip.queued.${strip.step}`)}
          </span>
        </>
      );
      break;
  }
  // No live region on a failure: a board with several would announce them all on load. The word and
  // the icon say it where the card is read.
  return <div className={className}>{body}</div>;
}

/** The causes of a failed run, which the strip words; a cancellation's cause is never a failure's reason. */
const FAILURE_CAUSES = [
  'budget',
  'no-account',
  'rate-limit',
  'stopped',
  'restarts',
  'unreadable',
  'no-verdict',
  'max-tokens',
  'not-started',
  'not-continued',
  'chat-ended',
  'chat-failed',
  'conflict-unresolved',
] as const;
type FailureCause = (typeof FAILURE_CAUSES)[number];

function isFailureCause(cause: FlowRunCause): cause is FailureCause & FlowRunCause {
  return (FAILURE_CAUSES as readonly string[]).includes(cause);
}
