import { type CSSProperties, type FunctionComponent, useId } from 'react';
import { Chats } from './chats';
import { CliMissing } from './cli-missing';
import { Connector } from './connector';
import { Install } from './install';
import { NoResults } from './no-results';
import { NotFound } from './not-found';
import { Offline } from './offline';
import { Orchestrations } from './orchestrations';
import { Projects } from './projects';
import { Quota } from './quota';
import { Schedules } from './schedules';
import { SignedOut } from './signed-out';
import { Welcome } from './welcome';

export type IllustrationTone = 'accent' | 'warn' | 'bad' | 'live';
export type IllustrationSize = 'sm' | 'md' | 'lg';

/** Each drawing with the tone it has in the catalogue (design system §4), used when none is asked for. */
const ILLUSTRATIONS = {
  welcome: [Welcome, 'accent'],
  chats: [Chats, 'accent'],
  orchestrations: [Orchestrations, 'accent'],
  schedules: [Schedules, 'accent'],
  projects: [Projects, 'accent'],
  'no-results': [NoResults, 'accent'],
  'not-found': [NotFound, 'accent'],
  install: [Install, 'accent'],
  'cli-missing': [CliMissing, 'warn'],
  'signed-out': [SignedOut, 'warn'],
  connector: [Connector, 'warn'],
  offline: [Offline, 'bad'],
  quota: [Quota, 'bad'],
} as const satisfies Record<string, readonly [FunctionComponent, IllustrationTone]>;

export type IllustrationName = keyof typeof ILLUSTRATIONS;

export const ILLUSTRATION_NAMES = Object.keys(ILLUSTRATIONS) as IllustrationName[];

const SIZES: readonly string[] = ['sm', 'md', 'lg'] satisfies IllustrationSize[];
const TONES: readonly string[] = ['accent', 'warn', 'bad', 'live'] satisfies IllustrationTone[];

/**
 * One of Agentry's own illustrations, for empty, error and system states. Always decorative: the
 * title and text next to it carry the meaning. Sizes and tones outside the unions (a stray string
 * from a caller that isn't typed) fall back to `md` and the drawing's own tone.
 */
export function Illustration({
  name,
  size = 'md',
  tone,
  className,
}: {
  name: IllustrationName;
  size?: IllustrationSize;
  tone?: IllustrationTone;
  className?: string;
}) {
  // useId() gives ':r1:'-style ids, which are not valid inside url(#…)
  const id = `il${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const [Drawing, ownTone] = ILLUSTRATIONS[name];
  const finalTone = tone && TONES.includes(tone) ? tone : ownTone;
  const classes = ['il'];
  if (SIZES.includes(size) && size !== 'md') classes.push(`il-${size}`);
  if (finalTone !== 'accent') classes.push(`il-${finalTone}`);
  if (className) classes.push(className);
  // The stylesheet can't know this instance's ids, so the classes that paint with the gradient or
  // the dot pattern read them from these properties.
  const style = { '--il-grad': `url(#${id}-grad)`, '--il-dots': `url(#${id}-dots)` } as CSSProperties;
  return (
    <svg className={classes.join(' ')} viewBox="0 0 240 160" aria-hidden="true" focusable="false" style={style} data-illustration={name}>
      <defs>
        <linearGradient id={`${id}-grad`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="stop-a" />
          <stop offset="1" className="stop-b" />
        </linearGradient>
        <pattern id={`${id}-dots`} width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1" className="dot-fill" />
        </pattern>
        <radialGradient id={`${id}-fade-g`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" className="stop-in" />
          <stop offset="1" className="stop-out" />
        </radialGradient>
        <mask id={`${id}-fade`}>
          <rect x="0" y="0" width="240" height="160" fill={`url(#${id}-fade-g)`} />
        </mask>
      </defs>
      <rect x="0" y="0" width="240" height="160" className="f-dots" mask={`url(#${id}-fade)`} />
      <Drawing />
    </svg>
  );
}
