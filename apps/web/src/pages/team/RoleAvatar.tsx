import type { CSSProperties } from 'react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useOverview } from '../../api';
import { nameHue } from '../../components/icons';
import type { TeamMember } from '@agentry/shared';
import { isKnownRole, roleFallbackName, roleInitials, templateResponsibilityRole } from './model';

/** A role's name in the interface language: the template's roles are translated, any other is shown as written. */
export function useRoleName(): (role: string) => string {
  const { t } = useTranslation('team');
  return useCallback((role: string) => (isKnownRole(role) ? t(`roles.${role}`) : roleFallbackName(role)), [t]);
}

/**
 * A member's responsibility as the interface shows it: the template's own in the person's language,
 * by role, since core keeps it in English for Claude; one someone edited, as it was written.
 */
export function useResponsibility(): (member: Pick<TeamMember, 'role' | 'responsibility'>) => string {
  const { t } = useTranslation('team');
  return useCallback(
    (member: Pick<TeamMember, 'role' | 'responsibility'>) => {
      const role = templateResponsibilityRole(member);
      return role ? t(`responsibilities.${role}`) : member.responsibility;
    },
    [t],
  );
}

/**
 * A team role: a neutral squircle with its initials in mono, and the role's own hue only on the
 * diamond in its corner. A person stays a round monogram, so a board never mixes the two up.
 */
export function RoleAvatar({ role, size = 'md', label }: { role: string; size?: 'xs' | 'sm' | 'md' | 'lg'; label?: string }) {
  const name = useRoleName()(role);
  const said = label ?? name;
  return (
    <span
      className={`role-avatar ${size === 'md' ? '' : `role-avatar-${size}`}`.trim()}
      style={{ '--hue': nameHue(role) } as CSSProperties}
      role="img"
      aria-label={said}
      title={said}
    >
      {roleInitials(role)}
    </span>
  );
}

/** The model a role runs on, in mono and neutral: a model is a choice, not a state. */
export function ModelTag({ model }: { model: string }) {
  return <span className={`model-tag ${/opus/i.test(model) ? 'is-opus' : ''}`.trim()}>{model}</span>;
}

/**
 * The CLI's own name for a model alias ("Sonnet 5" for `sonnet`), which the member page writes after
 * the alias as the reference does; nothing for a model the CLI does not list, or names as typed.
 */
export function ModelName({ model }: { model: string }) {
  const models = useOverview().data?.system.models;
  const label = models?.find((option) => option.value === model.trim())?.label;
  if (!label || label.toLowerCase() === model.trim().toLowerCase()) return null;
  return (
    <span className="member-model-name">
      <span aria-hidden>·</span> {label}
    </span>
  );
}
