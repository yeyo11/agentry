import { Info } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityTicker } from '../../components/ActivityTicker';
import { ICON_SM } from '../../components/icons';
import { LanguageMenu } from '../../components/LanguageMenu';
import { Spinner } from '../../components/Spinner';
import { Segmented } from '../../components/ui';
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
 * The three themes as miniatures of themselves. A miniature paints its theme whichever one is on,
 * which is why its colours are fixed swatches and not the surface tokens; System is both halves.
 */
function ThemeCards() {
  const { t } = useTranslation('shell');
  const theme = useThemePreference();

  // The ARIA radio pattern: one Tab stop, and the arrows move and choose
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    const at = THEMES.indexOf(theme);
    const next = THEMES[(at + (forward ? 1 : -1) + THEMES.length) % THEMES.length];
    if (!next) return;
    setThemePreference(next);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-theme-option='${next}']`)?.focus();
  };

  return (
    <div className="appearance-themes" role="radiogroup" aria-label={t('appearance.theme')}>
      {THEMES.map((value) => {
        const on = value === theme;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-theme-option={value}
            className={`appearance-theme ${on ? 'grad-border is-on' : ''}`}
            onClick={() => !on && setThemePreference(value)}
            onKeyDown={onKeyDown}
          >
            <span className={`appearance-thumb appearance-thumb-${value}`} aria-hidden>
              {value === 'system' ? (
                <>
                  <span className="appearance-thumb-half appearance-thumb-light" />
                  <span className="appearance-thumb-half appearance-thumb-dark" />
                </>
              ) : (
                <>
                  <span className="appearance-thumb-line" />
                  <span className="appearance-thumb-grad" />
                </>
              )}
            </span>
            {t(`appearance.themeOptions.${value}`)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Every live signal the motion level governs, running side by side, so the choice is made looking
 * at what it changes: the energy border, the braille ticker, a live bar, the ring, the dots and the
 * shimmer. It is a picture, not a status: nothing in it is announced.
 */
function MotionPreview() {
  const { t } = useTranslation(['shell', 'config']);
  return (
    <div className="appearance-preview card live-energy">
      <span className="appearance-preview-label">{t('appearance.preview')}</span>
      <div aria-hidden>
        <ActivityTicker activity={{ kind: 'tool', tool: 'Edit', target: 'src/App.tsx', since: PREVIEW_SINCE }} />
      </div>
      <div className="appearance-preview-bar" aria-hidden>
        <i />
      </div>
      <div className="appearance-preview-signals" aria-hidden>
        <span className="appearance-preview-signal">
          <Spinner variant="ring" />
          {t('config:appearance.ring')}
        </span>
        <span className="appearance-preview-signal">
          <Spinner variant="dots" />
          {t('config:appearance.dots')}
        </span>
        <span className="shimmer">{t('config:appearance.thinking')}</span>
      </div>
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
  const motion = useMotionPreference();
  const forced = useReducedMotionForced();

  return (
    <section className="card appearance" aria-label={t('appearance.tab')}>
      <Row id="appearance-theme" title={t('appearance.theme')} hint={t('appearance.themeHint')}>
        <ThemeCards />
      </Row>

      <Row id="appearance-language" title={t('appearance.language')} hint={t('appearance.languageHint')}>
        <div className="appearance-language">
          <LanguageMenu />
        </div>
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
        <MotionPreview />
      </Row>
    </section>
  );
}
