import type { ProviderId, ProviderStatus, ProvidersSettings } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, GripVertical, RefreshCw } from 'lucide-react';
import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Select, Sheet, Switch } from '../../components/controls';
import { ICON, ICON_SM } from '../../components/icons';
import { ProviderRow, useProviderReason } from '../../components/ProviderRow';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { Card, ErrorBox, Skeleton, Tag } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { providerLink, STATE_TONE, stateLabelKey } from '../../lib/provider-state';
import { effectiveDefault, entryOf, latestCheck, moveBy, moveTo, orderedIds, withEntry, withOrder } from '../../lib/provider-settings';
import { useProviders, useRefreshProviders } from '../../lib/providers';

/** The value of the "Automatic" option: `Select` takes strings and `null` is not one. */
const AUTO = '';

/**
 * Which providers Agentry offers, in what order, which one new chats start with, and where a binary
 * lives when the search cannot find it. Every change is one PUT of the whole document; the statuses
 * come from the detector and are read again when `providers.changed` arrives.
 */
export function ProvidersTab() {
  const { t } = useTranslation('providers');
  const toast = useToast();
  const queryClient = useQueryClient();
  const narrow = useMediaQuery(NARROW);
  const statuses = useProviders();
  const settings = useQuery({
    queryKey: keys.providerSettings,
    queryFn: () => api.providerSettings(),
  });
  const refresh = useRefreshProviders();
  // The row being read again: a binary was just chosen for it, or "all" after Check again
  const [checking, setChecking] = useState<ProviderId | 'all' | null>(null);
  const [binaryOf, setBinaryOf] = useState<ProviderId | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);

  const save = useMutation({
    mutationFn: (next: ProvidersSettings) => api.putProviderSettings(next),
    // The switch and the order answer at once; a failed save puts the server's document back
    onMutate: (next) => queryClient.setQueryData(keys.providerSettings, next),
    onSuccess: (saved) => queryClient.setQueryData(keys.providerSettings, saved),
    onError: (err) => {
      toast.error(t('saveFailed'), err);
      void queryClient.invalidateQueries({ queryKey: keys.providerSettings });
    },
  });

  if (statuses.error || settings.error) {
    return <ErrorBox error={statuses.error ?? settings.error} />;
  }
  if (!statuses.data || !settings.data) return <Skeleton rows={5} />;

  const list = statuses.data;
  const current = settings.data;
  const byId = new Map(list.map((s) => [s.id, s]));
  const order = orderedIds(list, current);
  const shown = order.flatMap((id) => byId.get(id) ?? []);
  const shownDefault = effectiveDefault(list, current);
  const checkedAt = latestCheck(list);
  const ready = shown.filter((s) => entryOf(current, s.id).enabled && s.state === 'ready').length;

  const persist = (next: ProvidersSettings) => save.mutate(next);
  const setEnabled = (id: ProviderId, enabled: boolean) => persist(withEntry(current, order, id, { enabled }));
  const setOrder = (next: ProviderId[]) => persist(withOrder(current, next, current.defaultProvider));
  const setDefault = (value: string) => persist(withOrder(current, order, value === AUTO ? null : value));

  const recheck = async (scope: ProviderId | 'all'): Promise<ProviderStatus[] | null> => {
    setChecking(scope);
    try {
      return await refresh.mutateAsync();
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(null);
    }
  };

  /**
   * Point a provider at a binary (or back at the PATH) and read it. A binary the detector rejects is
   * not kept: the previous choice is put back, so "Check and save" never leaves a broken program in
   * the settings.
   */
  const useBinary = async (id: ProviderId, binaryPath: string | null): Promise<ProviderStatus | null> => {
    const previous = entryOf(current, id).binaryPath;
    setChecking(id);
    try {
      await save.mutateAsync(withEntry(current, order, id, { binaryPath }));
      const fresh = await refresh.mutateAsync();
      const found = fresh.find((s) => s.id === id) ?? null;
      if (binaryPath !== null && found && !WORKS.has(found.state)) {
        await save.mutateAsync(withEntry(current, order, id, { binaryPath: previous }));
        void refresh.mutateAsync().catch(() => undefined);
      }
      return found;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(null);
    }
  };

  const open = binaryOf ? byId.get(binaryOf) : undefined;

  const toolbar = (
    <div className="prov-toolbar">
      <button type="button" className="btn" disabled={checking !== null} onClick={() => void recheck('all')}>
        {checking === 'all' ? <Spinner /> : <RefreshCw {...ICON_SM} />}
        {t('refresh')}
      </button>
      <span className="prov-checked mono">{checkedAt ? t('checkedAgo', { time: timeAgo(checkedAt) }) : t('notChecked')}</span>
    </div>
  );

  if (narrow) {
    const summary =
      current.defaultProvider && byId.get(current.defaultProvider)
        ? t('default.position', {
            name: byId.get(current.defaultProvider)?.label,
            position: order.indexOf(current.defaultProvider) + 1,
            total: order.length,
          })
        : t('default.autoPosition');
    return (
      <div className="prov-page">
        {toolbar}
        <button type="button" className="card prov-order-cell" onClick={() => setOrderOpen(true)} aria-label={t('default.cell')}>
          <span className="prov-order-cell-name">{t('default.cell')}</span>
          <span className="mono prov-order-cell-sub">{summary}</span>
        </button>
        <section className="card grad-border prov-card" aria-label={t('list.aria')}>
          {shown.map((status) => {
            const entry = entryOf(current, status.id);
            return (
              <ProviderRow
                key={status.id}
                status={status}
                variant="cell"
                enabled={entry.enabled}
                isDefault={status.id === shownDefault}
                checking={checking === 'all' || checking === status.id}
                onRetry={() => void recheck(status.id)}
                onChooseBinary={() => setBinaryOf(status.id)}
                trailing={
                  <Switch
                    className="prov-switch"
                    checked={entry.enabled}
                    onChange={(on) => setEnabled(status.id, on)}
                    aria-label={t(entry.enabled ? 'enable.on' : 'enable.off', {
                      name: status.label,
                    })}
                  />
                }
              />
            );
          })}
        </section>
        {/* Mounted only while open, so each opening starts a draft from what is saved now */}
        {orderOpen && (
          <OrderSheet
            open
            onOpenChange={setOrderOpen}
            statuses={shown}
            order={order}
            defaultProvider={current.defaultProvider}
            onSave={(nextOrder, nextDefault) => persist(withOrder(current, nextOrder, nextDefault))}
          />
        )}
        {open && (
          <Sheet open onOpenChange={(next) => !next && setBinaryOf(null)} title={open.label} className="prov-sheet">
            <BinaryEditor
              key={open.id}
              status={open}
              saved={entryOf(current, open.id).binaryPath}
              busy={checking === open.id}
              enabled={entryOf(current, open.id).enabled}
              onEnabled={(on) => setEnabled(open.id, on)}
              onUse={(path) => useBinary(open.id, path)}
              onDone={() => setBinaryOf(null)}
              sheet
            />
          </Sheet>
        )}
      </div>
    );
  }

  return (
    <div className="prov-page">
      {toolbar}
      <Card
        className="grad-border prov-card"
        title={<span id="prov-list-title">{t('list.title')}</span>}
        actions={
          <span className="mono prov-summary">
            {t('list.total', { count: shown.length })} · {t('list.ready', { count: ready })}
          </span>
        }
      >
        <div className="prov-default">
          <div className="prov-default-text">
            <span className="prov-default-title" id="prov-default-title">
              {t('default.title')}
            </span>
            <span className="prov-default-hint">{t('default.hint')}</span>
          </div>
          <Select
            className="prov-default-select"
            aria-label={t('default.group')}
            value={current.defaultProvider && byId.has(current.defaultProvider) ? current.defaultProvider : AUTO}
            onChange={setDefault}
            options={[...shown.map((s) => ({ value: s.id, label: s.label })), { value: AUTO, label: t('default.auto') }]}
          />
        </div>
        <ProviderList
          statuses={shown}
          settings={current}
          defaultId={shownDefault}
          checking={checking}
          binaryOf={binaryOf}
          onOrder={setOrder}
          onEnabled={setEnabled}
          onRetry={(id) => void recheck(id)}
          onChooseBinary={(id) => setBinaryOf((now) => (now === id ? null : id))}
          panel={(status) => (
            <BinaryEditor
              key={status.id}
              status={status}
              saved={entryOf(current, status.id).binaryPath}
              busy={checking === status.id}
              onUse={(path) => useBinary(status.id, path)}
              onDone={() => setBinaryOf(null)}
            />
          )}
        />
      </Card>
    </div>
  );
}

/** States in which the program runs; anything else after "Check and save" means the path is refused. */
const WORKS: ReadonlySet<ProviderStatus['state']> = new Set(['ready', 'degraded', 'signed-out']);

/**
 * The rows with a drag handle each. The handle is a button too, so the order can be changed from the
 * keyboard with the arrow keys: dragging is never the only way.
 */
function ProviderList({
  statuses,
  settings,
  defaultId,
  checking,
  binaryOf,
  onOrder,
  onEnabled,
  onRetry,
  onChooseBinary,
  panel,
}: {
  statuses: ProviderStatus[];
  settings: ProvidersSettings;
  defaultId: ProviderId | null;
  checking: ProviderId | 'all' | null;
  binaryOf: ProviderId | null;
  onOrder: (order: ProviderId[]) => void;
  onEnabled: (id: ProviderId, enabled: boolean) => void;
  onRetry: (id: ProviderId) => void;
  onChooseBinary: (id: ProviderId) => void;
  panel: (status: ProviderStatus) => React.ReactNode;
}) {
  const { t } = useTranslation('providers');
  const ids = statuses.map((s) => s.id);
  const list = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<ProviderId | null>(null);
  // The gap the row would land in: 0 is above the first row, `ids.length` below the last
  const [gap, setGap] = useState<number | null>(null);

  const gapAt = (clientY: number): number => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>('.prov-row') ?? []);
    const below = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return below === -1 ? rows.length : below;
  };

  const onDragStart = (event: DragEvent<HTMLElement>, id: ProviderId) => {
    const row = event.currentTarget.closest('.prov-row');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    if (row) event.dataTransfer.setDragImage(row, 0, 0);
    setDragging(id);
  };
  const onDragEnd = () => {
    setDragging(null);
    setGap(null);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const from = dragging === null ? -1 : ids.indexOf(dragging);
    const at = gap ?? gapAt(event.clientY);
    onDragEnd();
    if (from < 0) return;
    const to = at > from ? at - 1 : at;
    if (to !== from) onOrder(moveTo(ids, from, to));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: ProviderId) => {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = moveBy(ids, id, delta);
    if (next.join() !== ids.join()) onOrder(next);
  };

  return (
    <div
      ref={list}
      className="prov-list"
      onDragOver={(event) => {
        if (dragging === null) return;
        event.preventDefault();
        setGap(gapAt(event.clientY));
      }}
      onDrop={onDrop}
    >
      {statuses.map((status, at) => {
        const entry = entryOf(settings, status.id);
        return (
          <div key={status.id} className="prov-item">
            {dragging !== null && gap === at && <div className="prov-drop" aria-hidden />}
            <ProviderRow
              status={status}
              enabled={entry.enabled}
              isDefault={status.id === defaultId}
              checking={checking === 'all' || checking === status.id}
              onRetry={() => onRetry(status.id)}
              onChooseBinary={() => onChooseBinary(status.id)}
              leading={
                <button
                  type="button"
                  className="prov-grip"
                  draggable
                  aria-label={t('order.handle', { name: status.label })}
                  onDragStart={(event) => onDragStart(event, status.id)}
                  onDragEnd={onDragEnd}
                  onKeyDown={(event) => onKeyDown(event, status.id)}
                >
                  <GripVertical {...ICON_SM} />
                </button>
              }
              trailing={
                <Switch
                  className="prov-switch"
                  checked={entry.enabled}
                  onChange={(on) => onEnabled(status.id, on)}
                  aria-label={t(entry.enabled ? 'enable.on' : 'enable.off', {
                    name: status.label,
                  })}
                />
              }
            />
            {binaryOf === status.id && panel(status)}
          </div>
        );
      })}
      {dragging !== null && gap === statuses.length && <div className="prov-drop" aria-hidden />}
    </div>
  );
}

/**
 * The binary override: the path Agentry runs instead of searching the PATH. On desktop it opens
 * under the row; on a phone it fills a sheet, with the switch that turns the provider on or off.
 */
function BinaryEditor({
  status,
  saved,
  busy,
  enabled,
  onEnabled,
  onUse,
  onDone,
  sheet = false,
}: {
  status: ProviderStatus;
  saved: string | null;
  busy: boolean;
  enabled?: boolean;
  onEnabled?: (on: boolean) => void;
  onUse: (path: string | null) => Promise<ProviderStatus | null>;
  onDone: () => void;
  sheet?: boolean;
}) {
  const { t } = useTranslation('providers');
  const toast = useToast();
  const [path, setPath] = useState(saved ?? status.binaryPath ?? '');
  const [refused, setRefused] = useState<ProviderStatus | null>(null);
  const trimmed = path.trim();
  const own = useProviderReason(status);
  const reason = useProviderReason(refused ?? status);
  const install = providerLink(status.id, 'install');

  const check = async () => {
    setRefused(null);
    const found = await onUse(trimmed);
    if (!found) return;
    if (WORKS.has(found.state)) {
      toast.success(t('bin.saved', { name: status.label }));
      onDone();
    } else {
      setRefused(found);
    }
  };
  const usePath = async () => {
    setRefused(null);
    const found = await onUse(null);
    if (!found) return;
    toast.success(t('bin.cleared', { name: status.label }));
    onDone();
  };

  const field = (
    <label className="field field-mono">
      {sheet && <span className="field-label">{t('bin.title', { name: status.label })}</span>}
      <input
        className="mono"
        value={path}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={t('bin.placeholder', { id: status.id })}
        aria-label={t('bin.path', { name: status.label })}
        onChange={(event) => setPath(event.target.value)}
      />
    </label>
  );
  const hint = (
    <span className="form-hint">{status.compatibleRange ? t('bin.hint', { range: status.compatibleRange }) : t('bin.hintNoRange')}</span>
  );
  const problem = refused && (
    <p className="field-error" role="alert">
      {t('bin.rejected', { reason })}
    </p>
  );
  const submit = (
    <button type="button" className={sheet ? 'btn btn-primary' : 'btn'} disabled={busy || trimmed === ''} onClick={() => void check()}>
      {busy && <Spinner />}
      {busy ? t('bin.checking') : t('bin.check')}
    </button>
  );

  if (sheet) {
    return (
      <div className="prov-sheet-body">
        <div className="prov-cell-head">
          <div className="prov-id">
            <span className="prov-meta">{status.configHome ?? status.binaryPath ?? ''}</span>
          </div>
          <Tag tone={STATE_TONE[status.state]}>{t(stateLabelKey(status.state))}</Tag>
        </div>
        <p className="prov-reason">{own}</p>
        {onEnabled && enabled !== undefined && (
          <label className="prov-sheet-switch">
            <span>{t('enable.label')}</span>
            <Switch
              className="prov-switch"
              checked={enabled}
              onChange={onEnabled}
              aria-label={t(enabled ? 'enable.on' : 'enable.off', {
                name: status.label,
              })}
            />
          </label>
        )}
        {field}
        {hint}
        {problem}
        <div className="prov-sheet-actions">
          {submit}
          <div className="prov-sheet-row">
            <button type="button" className="btn prov-quiet" disabled={busy} onClick={() => void usePath()}>
              {t('bin.usePath')}
            </button>
            {install && (
              <a className="btn prov-quiet" href={install} target="_blank" rel="noopener noreferrer">
                {t('row.install')}
                <span className="sr-only"> ({t('row.opensNewTab')})</span>
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prov-bin" role="group" aria-label={t('bin.title', { name: status.label })}>
      <span className="section-label">{t('bin.title', { name: status.label })}</span>
      {field}
      {hint}
      {problem}
      <div className="prov-bin-actions">
        {submit}
        <button type="button" className="btn prov-quiet" onClick={onDone}>
          {t('bin.cancel')}
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-small prov-quiet" disabled={busy} onClick={() => void usePath()}>
          {t('bin.usePath')}
        </button>
      </div>
    </div>
  );
}

/**
 * Phone: the default and the order in one sheet. Nothing is saved until Save, so a slip of the
 * thumb on a radio can be cancelled.
 */
function OrderSheet({
  open,
  onOpenChange,
  statuses,
  order,
  defaultProvider,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statuses: ProviderStatus[];
  order: ProviderId[];
  defaultProvider: ProviderId | null;
  onSave: (order: ProviderId[], defaultProvider: ProviderId | null) => void;
}) {
  const { t } = useTranslation('providers');
  const [draftOrder, setDraftOrder] = useState(order);
  const [draftDefault, setDraftDefault] = useState(defaultProvider);
  const byId = new Map(statuses.map((s) => [s.id, s]));

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('default.sheetTitle')}
      description={t('default.hintPhone')}
      className="prov-sheet"
      footer={
        <div className="prov-sheet-row">
          <button type="button" className="btn" onClick={() => onOpenChange(false)}>
            {t('sheet.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onSave(draftOrder, draftDefault);
              onOpenChange(false);
            }}
          >
            {t('sheet.save')}
          </button>
        </div>
      }
    >
      <div role="radiogroup" aria-label={t('default.group')} className="prov-order">
        <div className="prov-order-row">
          <button
            type="button"
            className="icon-btn"
            role="radio"
            aria-checked={draftDefault === null}
            aria-label={t('default.autoRow')}
            onClick={() => setDraftDefault(null)}
          >
            <span className={`prov-radio${draftDefault === null ? ' on' : ''}`} />
          </button>
          <span className="prov-order-text">
            <span>{t('default.autoShort')}</span>
            <span className="prov-order-sub">{t('default.autoHint')}</span>
          </span>
        </div>
        {draftOrder.map((id, at) => {
          const status = byId.get(id);
          if (!status) return null;
          return (
            <div className="prov-order-row" key={id}>
              <button
                type="button"
                className="icon-btn"
                role="radio"
                aria-checked={draftDefault === id}
                aria-label={t('default.rowFor', { name: status.label })}
                onClick={() => setDraftDefault(id)}
              >
                <span className={`prov-radio${draftDefault === id ? ' on' : ''}`} />
              </button>
              <span className="prov-order-text">
                <span>{status.label}</span>
                <span className="prov-order-sub mono">
                  {t('default.positionState', {
                    position: at + 1,
                    state: t(stateLabelKey(status.state)),
                  })}
                </span>
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={t('order.up', { name: status.label })}
                disabled={at === 0}
                onClick={() => setDraftOrder(moveBy(draftOrder, id, -1))}
              >
                <ChevronUp {...ICON} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={t('order.down', { name: status.label })}
                disabled={at === draftOrder.length - 1}
                onClick={() => setDraftOrder(moveBy(draftOrder, id, 1))}
              >
                <ChevronDown {...ICON} />
              </button>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
