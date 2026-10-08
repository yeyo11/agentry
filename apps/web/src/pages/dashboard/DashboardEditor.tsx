import type { Project } from '@agentry/shared';
import {
  ArrowDown,
  ArrowUp,
  BookText,
  CalendarClock,
  FileText,
  FolderGit2,
  GitFork,
  Gauge,
  GripVertical,
  LayoutList,
  MessageSquarePlus,
  Package,
  Plus,
  Radio,
  Download,
  Rocket,
  Timer,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@agentry/ui/components/Dialog';
import { Sheet } from '@agentry/ui/components/controls';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Segmented } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { Dashboard, type WidgetFrame } from './Dashboard';
import { addableWidgets, addWidget, moveWidgetTo, positionOf, presentWidgets, removeWidget, resizeWidget, sameLayout, shiftWidget, widgetsInArea } from './edit';
import type { DashboardLayout, DashboardScope, LayoutWidget, WidgetSize } from './layout';
import { widgetDefinition, WIDGET_AREAS, type WidgetArea, type WidgetDefinition } from './registry';

/** The symbol of each widget type, in the picker and on the phone's list. */
const ICONS: Record<string, LucideIcon> = {
  kpis: Gauge,
  now: Radio,
  orchestrations: Workflow,
  limits: Timer,
  pickUp: MessageSquarePlus,
  today: Gauge,
  schedules: CalendarClock,
  projects: FolderGit2,
  quickStart: Rocket,
  memory: BookText,
  worktrees: GitFork,
  resources: Package,
  export: Download,
  documents: FileText,
  flows: Workflow,
};

/** Types added after the redesign: the picker says so, the way the reference does. */
const NEW_TYPES: ReadonlySet<string> = new Set(['documents', 'flows']);

const SIZE_ORDER: readonly WidgetSize[] = ['s', 'm', 'l', 'full'];

/** Only the areas that draw sizes offer a size control; the narrow column and the strip have a fixed width. */
const SIZED_AREAS: ReadonlySet<WidgetArea> = new Set(['main']);

const WidgetIcon = ({ type, size = ICON }: { type: string; size?: typeof ICON }) => {
  const Icon = ICONS[type] ?? LayoutList;
  return <Icon {...size} />;
};

/**
 * The state of an edit session over a layout. Every change saves at once; only a widget being
 * carried (by the pointer or the keyboard) is held back in `draft` until it is dropped, so a move
 * that is cancelled leaves the stored layout untouched.
 */
function useLayoutEditor(saved: DashboardLayout, save: (layout: DashboardLayout) => Promise<void>, announce: (text: string) => void) {
  const { t } = useTranslation('home');
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const [carried, setCarried] = useState<string | null>(null);
  const layout = draft ?? saved;
  const name = (id: string) => {
    const type = layout.widgets.find((widget) => widget.id === id)?.type;
    const definition = type ? widgetDefinition(type) : undefined;
    return definition ? t(definition.titleKey) : id;
  };
  const place = (next: DashboardLayout, id: string) => {
    const position = positionOf(next, id);
    return { title: name(id), n: (position?.index ?? 0) + 1, count: position?.count ?? 0 };
  };
  const commit = (next: DashboardLayout) => {
    if (!sameLayout(next, saved)) void save(next);
  };
  const finish = () => {
    setDraft(null);
    setCarried(null);
  };

  return {
    layout,
    carried,
    add: (type: string) => {
      const next = addWidget(layout, type);
      commit(next);
      const definition = widgetDefinition(type);
      if (definition) announce(t('edit.announce.added', { title: t(definition.titleKey) }));
    },
    remove: (id: string) => {
      announce(t('edit.announce.removed', { title: name(id) }));
      commit(removeWidget(layout, id));
    },
    resize: (id: string, size: WidgetSize) => {
      commit(resizeWidget(layout, id, size));
      announce(t('edit.announce.resized', { title: name(id), size: t(`edit.sizeName.${size}`) }));
    },
    /** One place up or down with the phone's buttons: a move of its own, saved at once */
    shift: (id: string, delta: -1 | 1) => {
      const next = shiftWidget(layout, id, delta);
      commit(next);
      announce(t('edit.announce.moved', place(next, id)));
    },
    lift: (id: string) => {
      setDraft(saved);
      setCarried(id);
      announce(t('edit.announce.lifted', place(saved, id)));
    },
    carry: (id: string, delta: -1 | 1) => {
      const next = shiftWidget(layout, id, delta);
      setDraft(next);
      announce(t('edit.announce.moved', place(next, id)));
    },
    /** The pointer is over another widget of the area: the carried one takes its place */
    over: (target: string) => {
      if (!carried || carried === target) return;
      const position = positionOf(layout, target);
      if (position) setDraft(moveWidgetTo(layout, carried, position.index));
    },
    drop: () => {
      if (carried && draft) {
        commit(draft);
        announce(t('edit.announce.dropped', place(draft, carried)));
      }
      finish();
    },
    cancel: () => {
      if (carried) announce(t('edit.announce.cancelled', { title: name(carried) }));
      finish();
    },
  };
}

type LayoutEditor = ReturnType<typeof useLayoutEditor>;

/** A widget in edit mode: a dashed frame whose head holds the handle, the sizes and Quitar, over the widget itself, inert. */
function EditFrame({ widget, editor, children }: { widget: LayoutWidget; editor: LayoutEditor; children: ReactNode }) {
  const { t } = useTranslation('home');
  const definition = widgetDefinition(widget.type);
  if (!definition) return null;
  const title = t(definition.titleKey);
  const lifted = editor.carried === widget.id;
  const sizes = SIZED_AREAS.has(definition.area) ? SIZE_ORDER.filter((size) => definition.sizes.includes(size)) : [];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (lifted) editor.drop();
      else editor.lift(widget.id);
    } else if (lifted && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      editor.cancel();
    } else if (lifted && (event.key === 'ArrowUp' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      editor.carry(widget.id, -1);
    } else if (lifted && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) {
      event.preventDefault();
      editor.carry(widget.id, 1);
    }
  };
  const onDragStart = (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData('text/plain', widget.id);
    event.dataTransfer.effectAllowed = 'move';
    editor.lift(widget.id);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    // Only a widget of the same area can land here; the others are refused by not being a target
    if (!editor.carried || editor.carried === widget.id) return;
    const carriedType = editor.layout.widgets.find((candidate) => candidate.id === editor.carried)?.type;
    if (widgetDefinition(carriedType ?? '')?.area !== definition.area) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    editor.over(widget.id);
  };

  return (
    <div className={`widget-edit ${lifted ? 'widget-lifted' : ''}`.trim()} data-edit-widget={widget.type} onDragOver={onDragOver} onDrop={(event) => event.preventDefault()}>
      <div className="widget-editbar">
        <button
          type="button"
          className="icon-btn widget-handle"
          draggable
          aria-label={t('edit.handle', { title })}
          aria-pressed={lifted}
          onKeyDown={onKeyDown}
          onBlur={() => lifted && editor.cancel()}
          onDragStart={onDragStart}
          onDragEnd={(event) => (event.dataTransfer.dropEffect === 'none' ? editor.cancel() : editor.drop())}
        >
          <GripVertical {...ICON} />
        </button>
        <span className="widget-name ellipsis">{title}</span>
        {sizes.length > 1 && (
          <Segmented
            className="widget-sizes"
            label={t('edit.sizes', { title })}
            value={widget.size}
            options={sizes.map((size) => ({ value: size, label: t(`edit.size.${size}`), title: t(`edit.sizeName.${size}`) }))}
            onChange={(size) => editor.resize(widget.id, size)}
          />
        )}
        <button type="button" className={`icon-btn widget-remove ${sizes.length > 1 ? '' : 'widget-remove-end'}`.trim()} aria-label={t('edit.remove', { title })} onClick={() => editor.remove(widget.id)}>
          <X {...ICON} />
        </button>
      </div>
      {/* The widget stays drawn so the page still reads as itself, but nothing in it can be pressed while editing */}
      <div className="widget-edit-body" inert>
        {children}
      </div>
    </div>
  );
}

/** One type in the picker: its symbol, name, a sentence, the sizes it allows and the button that adds it. */
function PickRow({ definition, phone, onAdd }: { definition: WidgetDefinition; phone: boolean; onAdd: () => void }) {
  const { t } = useTranslation('home');
  const title = t(definition.titleKey);
  return (
    <li className="pick-row">
      <span className="pick-ico" aria-hidden>
        <WidgetIcon type={definition.type} />
      </span>
      <span className="pick-text">
        <span className="pick-name">
          {title}
          {NEW_TYPES.has(definition.type) && <span className="badge badge-accent">{t('edit.new')}</span>}
        </span>
        {!phone && (
          <>
            <span className="pick-desc">{t(`widgets.${definition.type}.about`)}</span>
            <span className="pick-sizes">{SIZE_ORDER.filter((size) => definition.sizes.includes(size)).map((size) => t(`edit.size.${size}`)).join(' · ')}</span>
          </>
        )}
      </span>
      <button type="button" className="btn btn-sm pick-add" aria-label={t('edit.addNamed', { title })} onClick={onAdd}>
        <Plus {...ICON_SM} />
        {t('edit.addShort')}
      </button>
    </li>
  );
}

/** The add-widget picker: a dialog on a desktop, a Sheet on a phone. It stays open so several can be added. */
function AddWidgetPicker({ layout, scope, phone, onAdd, onClose }: { layout: DashboardLayout; scope: DashboardScope; phone: boolean; onAdd: (type: string) => void; onClose: () => void }) {
  const { t } = useTranslation('home');
  const addable = addableWidgets(layout, scope);
  const present = presentWidgets(layout);
  const body = (
    <>
      {addable.length === 0 ? (
        <p className="muted">{t('edit.allAdded')}</p>
      ) : (
        <ul className="pick-list">
          {addable.map((definition) => (
            <PickRow key={definition.type} definition={definition} phone={phone} onAdd={() => onAdd(definition.type)} />
          ))}
        </ul>
      )}
      {!phone && present.length > 0 && (
        <section className="pick-have-section">
          <h3 className="section-label">{t('edit.have')}</h3>
          <ul className="pick-have">
            {present.map((definition) => (
              <li key={definition.type} className="chip">
                {t(definition.titleKey)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
  const close = (
    <button type="button" className="btn" onClick={onClose}>
      {t('edit.close')}
    </button>
  );
  return phone ? (
    <Sheet open onOpenChange={(open) => !open && onClose()} title={t('edit.pickerTitle')} description={t('edit.pickerHint')} footer={close}>
      {body}
    </Sheet>
  ) : (
    <Dialog title={t('edit.pickerTitle')} onClose={onClose} footer={close} width={640}>
      <p className="muted">{t('edit.pickerHint')}</p>
      {body}
    </Dialog>
  );
}

/** Phone edit mode: a list with one row per widget and 44 px up, down and remove buttons, so nothing needs a drag. */
function PhoneEditList({ editor }: { editor: LayoutEditor }) {
  const { t } = useTranslation('home');
  const rows = WIDGET_AREAS.flatMap((area) => widgetsInArea(editor.layout, area));
  return (
    <ul className="move-list" aria-label={t('edit.listLabel')}>
      {rows.map((widget) => {
        const definition = widgetDefinition(widget.type);
        const position = positionOf(editor.layout, widget.id);
        if (!definition || !position) return null;
        const title = t(definition.titleKey);
        const first = position.index === 0;
        const last = position.index === position.count - 1;
        return (
          <li key={widget.id} className="move-row" data-edit-widget={widget.type}>
            <span className="pick-ico" aria-hidden>
              <WidgetIcon type={widget.type} />
            </span>
            <span className="pick-name grow ellipsis">{title}</span>
            <button type="button" className="icon-btn" disabled={first} aria-label={first ? t('edit.isFirst', { title }) : t('edit.up', { title })} onClick={() => editor.shift(widget.id, -1)}>
              <ArrowUp {...ICON} />
            </button>
            <button type="button" className="icon-btn" disabled={last} aria-label={last ? t('edit.isLast', { title }) : t('edit.down', { title })} onClick={() => editor.shift(widget.id, 1)}>
              <ArrowDown {...ICON} />
            </button>
            <button type="button" className="icon-btn widget-remove" aria-label={t('edit.remove', { title })} onClick={() => editor.remove(widget.id)}>
              <X {...ICON} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Edit mode of a Home: the bar (what is being edited, Añadir widget, Restablecer, Listo), then the
 * dashboard with every widget in its frame, or on a phone the list of widgets with up and down.
 * Nothing is saved with a button: each change is written at once, and Listo only leaves the mode.
 */
export function EditableDashboard({
  layout: saved,
  project,
  scope,
  label,
  stored,
  save,
  reset,
  onDone,
}: {
  layout: DashboardLayout;
  project: Project | null;
  scope: DashboardScope;
  label: string;
  stored: boolean;
  save: (layout: DashboardLayout) => Promise<void>;
  reset: () => Promise<void>;
  onDone: () => void;
}) {
  const { t } = useTranslation('home');
  const phone = useMediaQuery(NARROW);
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState('');
  const editor = useLayoutEditor(saved, save, setMessage);
  const frame: WidgetFrame = (widget, content) => (
    <EditFrame widget={widget} editor={editor}>
      {content}
    </EditFrame>
  );
  const add = (
    <button type="button" className="widget-add" onClick={() => setPicking(true)}>
      <Plus {...ICON} />
      {t('edit.add')}
    </button>
  );

  return (
    <>
      <div className="home-editbar" role="group" aria-label={t('edit.barLabel')}>
        <p className="home-editbar-title">{project ? t('edit.title', { name: project.name }) : t('edit.titleAll')}</p>
        <div className="home-editbar-actions">
          {!phone && (
            <button type="button" className="btn" onClick={() => setPicking(true)}>
              <Plus {...ICON_SM} />
              {t('edit.add')}
            </button>
          )}
          <button type="button" className="btn" disabled={!stored} onClick={() => void reset()}>
            {t('edit.reset')}
          </button>
          <button type="button" className="btn edit-done" onClick={onDone}>
            {t('edit.done')}
          </button>
        </div>
      </div>
      {phone ? (
        <>
          <p className="muted small edit-note">{t('edit.phoneNote')}</p>
          <PhoneEditList editor={editor} />
          <button type="button" className="widget-add" onClick={() => setPicking(true)}>
            <Plus {...ICON} />
            {t('edit.add')}
          </button>
        </>
      ) : (
        <Dashboard layout={editor.layout} project={project} label={label} frame={frame} after={add} />
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {message}
      </div>
      {picking && <AddWidgetPicker layout={editor.layout} scope={scope} phone={phone} onAdd={editor.add} onClose={() => setPicking(false)} />}
    </>
  );
}
