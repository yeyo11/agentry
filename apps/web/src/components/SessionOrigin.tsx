import type { ProjectSummary, SessionSummary } from '@agentry/shared';
import { Cog, Network, Play, Terminal, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from './icons';

export type OriginKind = SessionSummary['origin']['kind'];

/** Labels live in the `components` namespace under `origin.<kind>`. */
export const ORIGIN_META: Record<OriginKind, { icon: LucideIcon; tone: string }> = {
  cli: { icon: Terminal, tone: 'muted' },
  run: { icon: Play, tone: 'active' },
  orchestration: { icon: Network, tone: 'project' },
  internal: { icon: Cog, tone: 'muted' },
};

/** Older API builds do not send `origin`; treat those sessions as plain CLI ones. */
export function originOf(session: SessionSummary): SessionSummary['origin'] {
  return session.origin ?? { kind: 'cli' };
}

export function OriginBadge({ session }: { session: SessionSummary }) {
  const { t } = useTranslation('components');
  const found = originOf(session).kind;
  const kind = found in ORIGIN_META ? found : 'cli';
  const meta = ORIGIN_META[kind];
  const Icon = meta.icon;
  return (
    <span className={`badge badge-${meta.tone}`} title={t(`origin.${kind}.label`)}>
      <Icon size={11} strokeWidth={2} aria-hidden /> {t(`origin.${kind}.short`)}
    </span>
  );
}

/** "part of orchestration X / run Y" links for a session header. */
export function OriginTrail({ session }: { session: SessionSummary }) {
  const { t } = useTranslation('components');
  const origin = originOf(session);
  if (origin.kind === 'cli') return null;
  return (
    <span className="origin-trail">
      {origin.orchestrationId && (
        <>
          <Network {...ICON_SM} />
          <Link to={`/orchestration/${origin.orchestrationId}`}>{origin.orchestrationName ?? t('origin.orchestrationFallback')}</Link>
          {origin.taskName && <span className="muted">/ {origin.taskId === '__synthesis__' ? t('origin.synthesis') : origin.taskName}</span>}
        </>
      )}
      {origin.runId && (
        <>
          <Play {...ICON_SM} />
          <Link to={`/runs/${origin.runId}`}>{origin.runName ?? t('origin.runFallback')}</Link>
        </>
      )}
      {origin.kind === 'internal' && !origin.runId && <span className="muted">{t('origin.internalSession')}</span>}
    </span>
  );
}

/** A session is temporary when its project lives under the OS temp dir. */
export function isTemporarySession(session: SessionSummary, projectsById: ReadonlyMap<string, ProjectSummary>): boolean {
  const project = projectsById.get(session.projectId);
  if (project) return project.temporary === true;
  return session.projectPath.startsWith('/tmp/');
}
