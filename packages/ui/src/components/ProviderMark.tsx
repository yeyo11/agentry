import type { CSSProperties } from 'react';
import { BrandMark, brandOf } from './BrandMark';
import { monogramLetters } from './icons';

/*
 * The two letters and the hue of each agent Agentry drives, as the design system draws them
 * (§ ProviderBadge). The hue is never red, green or cyan: those are status and live. A provider
 * that is not here gets its label's letters and one of the hues below, picked from its id.
 */
const MARKS: Record<string, { letters: string; hue: number }> = {
  'claude-code': { letters: 'CC', hue: 24 },
  copilot: { letters: 'GH', hue: 262 },
  codex: { letters: 'CX', hue: 215 },
  gemini: { letters: 'GM', hue: 288 },
  opencode: { letters: 'OC', hue: 45 },
};

const SPARE_HUES = [24, 45, 215, 262, 288, 320];

function markOf(provider: string, label: string): { letters: string; hue: number } {
  const known = MARKS[provider];
  if (known) return known;
  let hash = 0;
  for (const ch of provider) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { letters: monogramLetters(label, true) || '?', hue: SPARE_HUES[hash % SPARE_HUES.length] ?? 215 };
}

/**
 * The provider's mark. Alone (a list row) it is the only thing that names the agent, so it is an
 * image with the label as its name; inside a badge the label is beside it and the mark is
 * decoration.
 */
export function ProviderMark({ provider, label, decorative = false }: { provider: string; label: string; decorative?: boolean }) {
  // An agent with an official mark wears it, at the size of the badge it sits in; the letters are for the rest
  if (brandOf(provider)) return <BrandMark id={provider} label={label} size={20} decorative={decorative} className="prov-mark" />;
  const { letters, hue } = markOf(provider, label);
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label, title: label };
  return (
    <span className="prov-mark" style={{ '--hue': hue } as CSSProperties} {...a11y}>
      {letters}
    </span>
  );
}
