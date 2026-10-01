import { ChevronDown, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Menu, type MenuEntry } from './controls/Menu';
import { ICON_SM } from './icons';

/**
 * One action you press and the related ones a press away: "New chat ▾", "Stop ▾". The main action
 * is a button of its own, so nothing that was one click away becomes two.
 */
export function SplitButton({
  label,
  onClick,
  entries,
  icon: Icon,
  variant = 'primary',
  disabled = false,
  className = '',
}: {
  label: string;
  onClick: () => void;
  entries: MenuEntry[];
  icon?: LucideIcon;
  variant?: 'primary' | 'plain' | 'danger';
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  const tone = { primary: 'btn-primary', plain: '', danger: 'btn-danger-solid' }[variant];
  return (
    <span className={`split-btn ${className}`.trim()}>
      <button type="button" className={`btn ${tone} split-btn-main`.trim()} onClick={onClick} disabled={disabled}>
        {Icon && <Icon {...ICON_SM} />}
        {label}
      </button>
      <Menu
        entries={entries}
        label={t('splitButton.more', { action: label })}
        trigger={
          <button type="button" className={`btn ${tone} split-btn-more`.trim()} aria-label={t('splitButton.more', { action: label })} disabled={disabled}>
            <ChevronDown {...ICON_SM} />
          </button>
        }
      />
    </span>
  );
}
