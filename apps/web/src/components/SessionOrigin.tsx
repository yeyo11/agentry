import type { ProjectSummary, SessionSummary } from '@agentry/shared';
import { Cog, Network, Play, Terminal, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ICON_SM } from './icons';

export type OriginKind = SessionSummary['origin']['kind'];

export const ORIGIN_META: Record<OriginKind, { label: string; short: string; icon: LucideIcon; tone: string }> = {
  cli: { label: 'Claude Code CLI', short: 'CLI', icon: Terminal, tone: 'muted' },
  run: { label: 'Agentry run', short: 'Run', icon: Play, tone: 'active' },
  orchestration: { label: 'Orchestration worker', short: 'Orchestration', icon: Network, tone: 'project' },
  internal: { label: 'Internal wrapper housekeeping', short: 'Internal', icon: Cog, tone: 'muted' },
};

/** Older API builds do not send `origin`; treat those sessions as plain CLI ones. */
export function originOf(session: SessionSummary): SessionSummary['origin'] {
  return session.origin ?? { kind: 'cli' };
}

export function OriginBadge({ session }: { session: SessionSummary }) {
  const meta = ORIGIN_META[originOf(session).kind] ?? ORIGIN_META.cli;
  const Icon = meta.icon;
  return (
    <span className={`badge badge-${meta.tone}`} title={meta.label}>
      <Icon size={11} strokeWidth={2} aria-hidden /> {meta.short}
    </span>
  );
}

/** "part of orchestration X / run Y" links for a session header. */
export function OriginTrail({ session }: { session: SessionSummary }) {
  const origin = originOf(session);
  if (origin.kind === 'cli') return null;
  return (
    <span className="origin-trail">
      {origin.orchestrationId && (
        <>
          <Network {...ICON_SM} />
          <Link to={`/orchestration/${origin.orchestrationId}`}>{origin.orchestrationName ?? 'orchestration'}</Link>
          {origin.taskName && <span className="muted">/ {origin.taskId === '__synthesis__' ? 'Synthesis' : origin.taskName}</span>}
        </>
      )}
      {origin.runId && (
        <>
          <Play {...ICON_SM} />
          <Link to={`/runs/${origin.runId}`}>{origin.runName ?? 'run'}</Link>
        </>
      )}
      {origin.kind === 'internal' && !origin.runId && <span className="muted">internal wrapper session</span>}
    </span>
  );
}

/** A session is temporary when its project lives under the OS temp dir. */
export function isTemporarySession(session: SessionSummary, projectsById: ReadonlyMap<string, ProjectSummary>): boolean {
  const project = projectsById.get(session.projectId);
  if (project) return project.temporary === true;
  return session.projectPath.startsWith('/tmp/');
}
