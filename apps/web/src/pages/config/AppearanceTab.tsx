import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityTicker } from '../../components/ActivityTicker';
import { ICON_SM } from '../../components/icons';
import { LanguageMenu } from '../../components/LanguageMenu';
import { ProgressBar } from '../../components/ProgressBar';
import { Card, Segmented } from '../../components/ui';
import { setMotionPreference, useMotionPreference, useReducedMotionForced, type MotionLevel } from '../../lib/motion';
import { setThemePreference, useThemePreference, type ThemePreference } from '../../lib/theme';

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];
const MOTION: MotionLevel[] = ['full', 'subtle', 'off'];

// A fixed moment in the past, so the preview's clock reads like a real one without depending on a chat
const PREVIEW_SINCE = new Date(Date.now() - 42_000).toISOString();

function Row({ id, title, hint, children }: { id: string; title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="appearance-row" role="group" aria-labelledby={`${id}-title`}>
      <div className="appearance-row-text">
        <span id={`${id}-title`} className="appearance-row-title">
          {title}
        </span>
        <span className="small muted">{hint}</span>
      </div>
      <div className="appearance-row-control">{children}</div>
    </div>
  );
}

/**
 * How the UI looks and moves, per browser: theme, language and motion level. All three are
 * localStorage preferences stamped on `<html>` before the first paint, so nothing here reaches the
 * server, and changing one takes effect at once.
 */
export function AppearanceTab() {
  const { t } = useTranslation(['shell', 'common']);
  const theme = useThemePreference();
  const motion = useMotionPreference();
  const forced = useReducedMotionForced();

  return (
    <Card title={t('appearance.tab')}>
      <p className="small muted">{t('appearance.intro')}</p>
      <div className="appearance">
        <Row id="appearance-theme" title={t('appearance.theme')} hint={t('appearance.themeHint')}>
          <Segmented
            label={t('appearance.theme')}
            value={theme}
            onChange={setThemePreference}
            options={THEMES.map((value) => ({ value, label: t(`appearance.themeOptions.${value}`) }))}
          />
        </Row>

        <Row id="appearance-language" title={t('appearance.language')} hint={t('appearance.languageHint')}>
          <LanguageMenu />
        </Row>

        <Row id="appearance-motion" title={t('appearance.motion')} hint={t('appearance.motionHint')}>
          <Segmented
            label={t('appearance.motion')}
            value={motion}
            onChange={setMotionPreference}
            options={MOTION.map((value) => ({ value, label: t(`appearance.motionOptions.${value}`) }))}
          />
          <span className="small muted appearance-motion-says">{t(`appearance.motionDescriptions.${motion}`)}</span>
          {forced && (
            <p className="appearance-forced small" role="note">
              <Info {...ICON_SM} />
              <span>{t('appearance.reducedForced')}</span>
            </p>
          )}
          <div className="appearance-preview live-rail">
            <span className="appearance-preview-label">{t('appearance.preview')}</span>
            <ActivityTicker activity={{ kind: 'tool', tool: 'Edit', target: 'src/App.tsx', since: PREVIEW_SINCE }} />
            <ProgressBar counts={{ done: 3, running: 1, pending: 1 }} variant="blocks" />
          </div>
        </Row>
      </div>
    </Card>
  );
}
