import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * A team role as memory proposals, the journal and documents name it: a neutral squircle with its
 * initials in mono, the role's own hue only on its corner diamond (design system §2, `.role-av`).
 *
 * A stand-in with the same props as the Team tab's `RoleAvatar` (pages/team/RoleAvatar.tsx), built
 * in parallel by another task: the two land together, and the cross-screen review swaps this one
 * for it. Its class is its own (`.doc-role`) so the two stylesheets never fight over one selector.
 */

/** The hue each built-in role keeps on every screen; a role nobody named takes one from its id. */
const ROLE_HUE: Record<string, number> = {
  'product-owner': 300,
  architect: 215,
  developer: 90,
  qa: 330,
  writer: 45,
  researcher: 170,
  reviewer: 260,
};

const ROLE_INITIALS: Record<string, string> = {
  'product-owner': 'PO',
  architect: 'AR',
  developer: 'DEV',
  qa: 'QA',
  writer: 'DOC',
  researcher: 'RS',
  reviewer: 'RV',
};

function hashHue(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export const roleHue = (role: string): number => ROLE_HUE[role] ?? hashHue(role);

export function roleInitials(role: string): string {
  const known = ROLE_INITIALS[role];
  if (known) return known;
  const parts = role.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts.slice(0, 2).map((p) => p[0] ?? '') : [role.slice(0, 2)];
  return letters.join('').toUpperCase() || '?';
}

const KNOWN_ROLES = ['product-owner', 'architect', 'developer', 'qa', 'writer', 'researcher', 'reviewer'] as const;
type KnownRole = (typeof KNOWN_ROLES)[number];
const isKnown = (role: string): role is KnownRole => (KNOWN_ROLES as readonly string[]).includes(role);

/** The display name of a role: the built-in ones translated, a free-text one title-cased. */
export function useRoleName(): (role: string) => string {
  const { t } = useTranslation('documents');
  return (role) =>
    isKnown(role)
      ? t(`roles.${role}`)
      : role
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
}

export function RoleAvatar({ role, size = 'md', label }: { role: string; size?: 'sm' | 'md' | 'lg'; label?: string }) {
  const name = useRoleName()(role);
  return (
    <span className={`doc-role doc-role-${size} role-avatar`} style={{ '--hue': roleHue(role) } as CSSProperties} role="img" aria-label={label ?? name} title={label ?? name}>
      {roleInitials(role)}
    </span>
  );
}
