import type { ProjectModule, ProjectTemplateId } from '@agentry/shared';
import { EyeOff } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../../components/controls';
import { ICON, ICON_SM } from '../../components/icons';
import { MODULE_ICON, PROJECT_MODULES, TEMPLATE_ICON } from './model';

/**
 * One module and its switch. `note` says what the module holds, or, switched off, that it is hidden
 * and its data kept: a switch never deletes anything, and the card says so where it is flipped.
 */
export function ModuleCard({
  module,
  on,
  onChange,
  note,
  compact = false,
}: {
  module: ProjectModule;
  on: boolean;
  onChange: (on: boolean) => void;
  note?: ReactNode;
  /** The phone's settings: a cell of a card, with the note in place of the description */
  compact?: boolean;
}) {
  const { t } = useTranslation('projects');
  const Icon = MODULE_ICON[module];
  const name = t(`modules.${module}.name`);
  return (
    <div className={`module-card ${on ? 'is-on' : ''} ${compact ? 'module-card-compact' : ''}`} data-module={module}>
      <span className="module-icon" aria-hidden>
        <Icon {...ICON} />
      </span>
      <span className="module-text">
        <span className="module-name">{name}</span>
        {!compact && <span className="module-desc">{t(`modules.${module}.description`)}</span>}
        {note && <span className="module-note">{note}</span>}
      </span>
      <Switch checked={on} onChange={onChange} aria-label={name} className="module-switch" />
    </div>
  );
}

/** "hidden · data kept", or for a project that never had the module, that there is nothing to keep. */
export function HiddenNote({ empty }: { empty: boolean }) {
  const { t } = useTranslation('projects');
  return (
    <>
      <EyeOff {...ICON_SM} size={12} />
      {empty ? t('modules.hiddenEmpty') : t('modules.hiddenKept')}
    </>
  );
}

/** What switching a module off means, once per screen, beside the switches. */
export function ModulesOffNote({ children }: { children: ReactNode }) {
  return (
    <div className="modules-note">
      <EyeOff {...ICON} />
      <span>{children}</span>
    </div>
  );
}

/** The four modules as small marks, filled when on: a template card, a project card. */
export function ModuleMarks({ modules, className = '' }: { modules: readonly ProjectModule[]; className?: string }) {
  const { t } = useTranslation('projects');
  const on = PROJECT_MODULES.filter((m) => modules.includes(m));
  const label = on.length ? t('modules.marksLabel', { list: on.map((m) => t(`modules.${m}.name`)).join(', ') }) : t('modules.marksNone');
  return (
    <span className={`module-marks ${className}`} role="img" aria-label={label}>
      {PROJECT_MODULES.map((module) => {
        const Icon = MODULE_ICON[module];
        return (
          <span key={module} className={`module-mark ${modules.includes(module) ? 'is-on' : ''}`} title={t(`modules.${module}.name`)}>
            <Icon {...ICON_SM} size={13} />
          </span>
        );
      })}
    </span>
  );
}

/** Arrow keys move the choice through the template cards, as a radio group does. */
function moveChoice(event: KeyboardEvent<HTMLButtonElement>) {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  if (!forward && !backward) return;
  const cards = [...(event.currentTarget.closest('[role=radiogroup]')?.querySelectorAll<HTMLButtonElement>('[role=radio]') ?? [])];
  const at = cards.indexOf(event.currentTarget);
  const next = cards[(at + (forward ? 1 : -1) + cards.length) % cards.length];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
}

/** A template as a radio card: the chosen one takes the accent ring, never the gradient. */
export function TemplateCard({ id, modules, checked, onSelect }: { id: ProjectTemplateId; modules: readonly ProjectModule[]; checked: boolean; onSelect: () => void }) {
  const { t } = useTranslation('projects');
  const Icon = TEMPLATE_ICON[id];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      className={`template-card ${checked ? 'is-on' : ''}`}
      data-template={id}
      onClick={onSelect}
      onKeyDown={moveChoice}
    >
      <span className="template-radio" aria-hidden />
      <span className="template-icon" aria-hidden>
        <Icon {...ICON} />
      </span>
      <span className="template-text">
        <span className="template-name">{t(`templates.${id}.name`)}</span>
        <span className="template-desc">{t(`templates.${id}.description`)}</span>
        <ModuleMarks modules={modules} className="template-mods" />
      </span>
    </button>
  );
}
