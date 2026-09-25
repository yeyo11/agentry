import type { Project } from '@agentry/shared';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '../../components/icons';
import { usePageTitle } from '../../components/ui';
import { intlLocale } from '../../i18n/language';
import { formatNumber } from '../../lib/format';
import { homeHeadline } from './model';
import { NEW_ORCHESTRATION_PATH, useHomePulse, type HomePulse } from './pulse';

/** "Friday · 25 Sep": the day the page is about, in the mono label voice. */
function dayLabel(date: Date): string {
  const locale = intlLocale();
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date).replace(/\.$/, '');
  return `${weekday} · ${day}`;
}

/** One sentence under the headline: who is at work where, and whether anything waits. */
function useSummary(pulse: HomePulse): string {
  const { t } = useTranslation('home');
  const where = [
    pulse.orchestrationsRunning > 0 ? t('kpis.orchestrations', { count: pulse.orchestrationsRunning, n: formatNumber(pulse.orchestrationsRunning) }) : null,
    pulse.chatsWorking > 0 ? t('kpis.chats', { count: pulse.chatsWorking, n: formatNumber(pulse.chatsWorking) }) : null,
  ].filter((part): part is string => part !== null);
  const list = new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(where);
  const working = pulse.agents > 0 ? t('hero.working', { count: pulse.agents, n: formatNumber(pulse.agents), where: list }) : t('hero.nothingWorking');
  const waiting = pulse.waiting > 0 ? t('hero.waitingSome') : t('hero.waitingNone');
  return `${working} ${waiting}`;
}

/**
 * The top of Home: the day, a headline built from the live state with one phrase in the brand's
 * gradient, a line that says it in figures, and the two ways to start something. Scoped to a
 * project, the project's name is the headline and the live state moves to the line under it.
 */
export function HomeHero({ project, aside, actions }: { project: Project | null; aside?: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation('home');
  const pulse = useHomePulse(project);
  const summary = useSummary(pulse);
  const headline = homeHeadline({ running: pulse.agents, waiting: pulse.waiting });
  usePageTitle(project ? project.name : t('page.title'));
  const newChat = project ? `/chats/new?cwd=${encodeURIComponent(project.path)}` : '/chats/new';
  const grad = <span className="grad-text" />;

  return (
    <header className="page-header home-hero">
      <div className="page-header-text home-hero-text">
        <span className="section-label home-hero-date">{dayLabel(new Date())}</span>
        <h1 className="text-display">
          {project ? (
            project.name
          ) : pulse.loading || pulse.unreachable ? (
            t('page.title')
          ) : headline.kind === 'waiting' ? (
            <Trans t={t} i18nKey="hero.waiting" count={headline.n} values={{ n: formatNumber(headline.n) }} components={{ grad }} />
          ) : (
            <Trans t={t} i18nKey={headline.kind === 'running' ? 'hero.running' : 'hero.idle'} components={{ grad }} />
          )}
        </h1>
        {!pulse.loading && !pulse.unreachable && <p className="home-hero-summary">{summary}</p>}
        {aside}
      </div>
      <div className="page-actions home-hero-actions">
        {actions}
        <Link to={NEW_ORCHESTRATION_PATH} className="btn">
          {t('hero.newOrchestration')}
        </Link>
        <Link to={newChat} className="btn btn-primary">
          <Plus {...ICON_SM} />
          {t('hero.newChat')}
        </Link>
      </div>
    </header>
  );
}
