import { useId, type CSSProperties } from 'react';
import { BRAND_ART } from './brand-art';
import { Monogram } from './icons';

/*
 * The official mark of a program Agentry names: the code hosts, the issue trackers and the agents it
 * drives. The art is the brand's own file (brand-art.ts), drawn in its own colour on a light tile
 * that is the same in both themes, so a mark reads as the brand draws it and not as a theme's
 * recolouring (design system, "Brand marks"). A name with no mark here keeps its monogram.
 */

/** Which mark names an id: a tracker that lives on a host wears its host's mark. */
const BRAND_OF: Readonly<Record<string, string>> = {
  github: 'github',
  'github-issues': 'github',
  gitlab: 'gitlab',
  'gitlab-issues': 'gitlab',
  youtrack: 'youtrack',
  'claude-code': 'claude-code',
  codex: 'codex',
  copilot: 'copilot',
  gemini: 'gemini',
  opencode: 'opencode',
};

/** The mark an id wears, or null when it has none. */
export const brandOf = (id: string): string | null => BRAND_OF[id] ?? null;

export function BrandMark({ id, label, size = 36, decorative = false, className = '' }: { id: string; label: string; size?: number; /** The label stands beside the mark */ decorative?: boolean; /** More classes: the ones a screen and its specs already select */ className?: string }) {
  const gradientId = useId();
  const brand = brandOf(id);
  const art = brand ? BRAND_ART[brand] : undefined;
  if (!brand || !art) return null;
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label, title: label };
  const style = { width: size, height: size, ...(art.ink ? { '--brand-ink': `var(${art.ink})` } : {}) } as CSSProperties;
  return (
    <span className={`brand-mark${className ? ` ${className}` : ''}`} data-brand={brand} style={style} {...a11y}>
      <svg viewBox={art.viewBox} focusable="false" aria-hidden>
        {art.gradient && (
          <defs>
            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={art.gradient.x1} y1={art.gradient.y1} x2={art.gradient.x2} y2={art.gradient.y2}>
              {art.gradient.stops.map(([offset, color]) => (
                <stop key={offset} offset={offset} stopColor={color} />
              ))}
            </linearGradient>
          </defs>
        )}
        {art.shapes.map((shape, i) => (
          <path key={i} d={shape.d} fill={shape.fill === 'ink' ? 'var(--brand-ink)' : shape.fill === 'gradient' ? `url(#${gradientId})` : shape.fill} {...(shape.evenodd ? { fillRule: 'evenodd' as const } : {})} />
        ))}
      </svg>
    </span>
  );
}

/** A program's mark: its official one, or the monogram of its name when it has none. */
export function ProgramMark({ id, label, size = 36, project = false }: { id: string; label: string; size?: number; /** The monogram's two letters, for a project-like name */ project?: boolean }) {
  return brandOf(id) ? <BrandMark id={id} label={label} size={size} decorative /> : <Monogram name={label} size={size} project={project} />;
}
