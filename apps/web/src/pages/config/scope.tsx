import type { ProjectSummary } from '@agentry/shared';
import * as Popover from '@radix-ui/react-popover';
import { ChevronsUpDown } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjects, type Scope } from '../../api';
import { Checkbox } from '../../components/controls';
import { LAYER_ATTR } from '../../components/controls/layer';
import { shortPath } from '../../lib/format';

export interface ScopeState {
  scope: Scope;
  /** Stable string for React keys and effects */
  scopeKey: string;
  project: ProjectSummary | undefined;
  projects: ProjectSummary[];
  /** The URL names a project the API does not know (yet) */
  unknownProject: boolean;
}

export function useScopeState(projectId: string | undefined): ScopeState {
  const { data, isSuccess } = useProjects();
  return useMemo(() => {
    const projects = data ?? [];
    const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
    return {
      scope: projectId ? { projectId } : {},
      scopeKey: projectId ?? 'user',
      project,
      projects,
      unknownProject: Boolean(projectId) && isSuccess && !project,
    };
  }, [data, isSuccess, projectId]);
}

/** Searchable scope selector: the user scope, or any project known to the wrapper. */
export function ScopePicker({
  state,
  onSelect,
}: {
  state: ScopeState;
  onSelect: (projectId: string | undefined) => void;
}) {
  const { t } = useTranslation('config');
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [showTemporary, setShowTemporary] = useState(false);

  const needle = filter.trim().toLowerCase();
  // Temporary projects (under the OS temp dir) stay out of the way unless one is already selected
  const candidates = state.projects.filter((p) => showTemporary || !p.temporary || p.id === state.scope.projectId);
  const hiddenTemporary = state.projects.length - candidates.length;
  const matches = candidates.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle),
  );
  const showUser = !needle || 'user'.includes(needle);
  // One list for the keyboard: `undefined` is the user scope
  const options: Array<ProjectSummary | undefined> = [...(showUser ? [undefined] : []), ...matches];
  const highlighted = Math.min(active, options.length - 1);

  const openChange = (next: boolean) => {
    setOpen(next);
    setFilter('');
    setActive(0);
  };
  const choose = (projectId: string | undefined) => {
    openChange(false);
    onSelect(projectId);
  };
  const optionProps = (projectId: string | undefined, index: number) => ({
    id: `${listId}-${index}`,
    role: 'option',
    'aria-selected': projectId === state.scope.projectId,
    'data-highlighted': index === highlighted ? '' : undefined,
    className: `popover-item ${projectId === state.scope.projectId ? 'popover-item-on' : ''}`,
    onMouseEnter: () => setActive(index),
    onClick: () => choose(projectId),
  });

  return (
    <Popover.Root open={open} onOpenChange={openChange}>
      <Popover.Trigger className="btn scope-picker-button" aria-haspopup="listbox">
        <span className="muted">{t('scope.label')}</span>
        <strong className="ellipsis">
          {state.project ? state.project.name : state.scope.projectId ? t('config.unknownProject') : t('scope.user')}
        </strong>
        <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden className="muted" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content {...LAYER_ATTR} className="popover" align="end" sideOffset={8} collisionPadding={8}>
          <input
            role="combobox"
            aria-label={t('scope.search')}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options.length ? `${listId}-${highlighted}` : undefined}
            value={filter}
            placeholder={t('scope.searchPlaceholder')}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (options.length) setActive((highlighted + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
              } else if (e.key === 'Enter' && options.length) {
                e.preventDefault();
                choose(options[highlighted]?.id);
              }
            }}
          />
          <div className="popover-list" id={listId} role="listbox" aria-label={t('scope.listLabel')}>
            {showUser && (
              <div {...optionProps(undefined, 0)}>
                <strong>{t('scope.user')}</strong>
                <span className="small muted">{t('scope.userHint')}</span>
              </div>
            )}
            {matches.map((project, i) => (
              <div key={project.id} {...optionProps(project.id, i + (showUser ? 1 : 0))} title={project.path}>
                <strong className="ellipsis">
                  {project.name}
                  {project.temporary && <span className="badge popover-badge">{t('scope.temporary')}</span>}
                </strong>
                <span className="small muted mono ellipsis">{shortPath(project.path, 44)}</span>
              </div>
            ))}
            {options.length === 0 && <div className="small muted popover-empty">{t('scope.noMatch')}</div>}
          </div>
          {(hiddenTemporary > 0 || showTemporary) && (
            <Checkbox className="check small popover-foot" checked={showTemporary} onChange={setShowTemporary}>
              {t('scope.showTemporary')}
              {hiddenTemporary > 0 ? ` (${hiddenTemporary})` : ''}
            </Checkbox>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
