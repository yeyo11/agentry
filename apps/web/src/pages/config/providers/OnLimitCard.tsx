import type { ProvidersSettings } from '@agentry/shared';
import { Repeat2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox, NumberInput, Sheet, Switch } from '@agentry/ui/components/controls';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Card, Segmented } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { useDirty } from '../../../lib/dirty';
import { ACTIONS, MOVES, WAIT_HOURS, allowedWith, clampInt, onLimitWith, rotationOf, type OnLimit } from './rotation';

/**
 * "When a provider reaches its limit": what Agentry does with the work it launches itself (flows,
 * the tasks of an orchestration, the assistant), which actions a decision point may choose among,
 * the longest wait and the moves one piece of work may make. A person's own chat is never moved by
 * this: it asks, and this action goes first. Nothing is saved until Save, because widening it
 * widens where work and its handoff may go.
 */
export function OnLimitCard({ settings, onSave, saving }: { settings: ProvidersSettings; onSave: (next: OnLimit) => void; saving: boolean }) {
  const { t } = useTranslation('providers');
  const narrow = useMediaQuery(NARROW);
  const saved = rotationOf(settings).onLimit;
  const [edit, setEdit] = useState<{ base: string; next: OnLimit } | null>(null);
  // The draft is of this block only, so a mapping saved meanwhile does not drop it; what was saved
  // elsewhere shows unless the person edited: an edit made on an older block is dropped
  const base = JSON.stringify(saved);
  const on = edit && edit.base === base ? edit.next : saved;
  const dirty = JSON.stringify(on) !== base;
  useDirty('providers-on-limit', dirty);
  const [open, setOpen] = useState(false);

  const change = (next: OnLimit) => setEdit({ base, next });
  const discard = () => setEdit(null);
  const save = () => {
    onSave(on);
    setEdit(null);
  };

  const wait = (
    <NumberInput
      value={on.maxWaitHours}
      min={WAIT_HOURS.min}
      max={WAIT_HOURS.max}
      aria-label={t('onLimit.maxWait.aria')}
      onChange={(v) => v !== undefined && change(onLimitWith(on, { maxWaitHours: clampInt(v, WAIT_HOURS.min, WAIT_HOURS.max) }))}
    />
  );
  const moves = (
    <NumberInput
      value={on.maxMoves}
      min={MOVES.min}
      max={MOVES.max}
      aria-label={t('onLimit.maxMoves.aria')}
      onChange={(v) => v !== undefined && change(onLimitWith(on, { maxMoves: clampInt(v, MOVES.min, MOVES.max) }))}
    />
  );

  const actions = (
    <>
      <button type="button" className="btn prov-quiet" disabled={!dirty || saving} onClick={discard}>
        {t('onLimit.discard')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
        {t('onLimit.save')}
      </button>
    </>
  );

  if (narrow) {
    return (
      <>
        <button type="button" className="card prov-order-cell" onClick={() => setOpen(true)}>
          <span className="prov-order-cell-name">{t('onLimit.title')}</span>
          <span className="mono prov-order-cell-sub">{t(`onLimit.action.${saved.action}.label`)}</span>
        </button>
        {open && (
          <Sheet
            open
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) discard();
            }}
            title={t('onLimit.title')}
            description={t('onLimit.intro')}
            side="bottom"
            className="prov-sheet"
            footer={<div className="prov-sheet-row">{actions}</div>}
          >
            <div className="rot-sheet">
              <span className="section-label">{t('onLimit.action.label')}</span>
              <div className="card" role="radiogroup" aria-label={t('onLimit.action.aria')}>
                {ACTIONS.map((a) => (
                  <button key={a} type="button" className="rot-radio" role="radio" aria-checked={on.action === a} onClick={() => change(onLimitWith(on, { action: a }))}>
                    <span className={`prov-radio${on.action === a ? ' on' : ''}`} />
                    <span className="rot-col grow">
                      <span>{t(`onLimit.action.${a}.label`)}</span>
                      <span className="small muted">{t(`onLimit.action.${a}.hint`)}</span>
                    </span>
                  </button>
                ))}
              </div>
              <span className="section-label">{t('onLimit.allowed.label')}</span>
              <div className="card">
                {ACTIONS.map((a) => (
                  <div key={a} className="rot-allow">
                    <span className="rot-col grow">
                      <span>{t(`onLimit.action.${a}.label`)}</span>
                      <span className="small muted">{a === on.action ? t('onLimit.allowed.chosen') : on.allowed.includes(a) ? t('onLimit.allowed.yes') : t('onLimit.allowed.no')}</span>
                    </span>
                    <Switch checked={on.allowed.includes(a)} disabled={a === on.action} onChange={(v) => change(allowedWith(on, a, v))} aria-label={t(`onLimit.action.${a}.label`)} className="prov-switch" />
                  </div>
                ))}
              </div>
              <span className="form-hint">{t('onLimit.allowed.hint')}</span>
              <div className="card">
                <div className="rot-allow">
                  <span className="rot-col grow">
                    <span>{t('onLimit.maxWait.label')}</span>
                    <span className="small muted">{t('onLimit.maxWait.short')}</span>
                  </span>
                  {wait}
                </div>
                <div className="rot-allow">
                  <span className="rot-col grow">
                    <span>{t('onLimit.maxMoves.label')}</span>
                    <span className="small muted">{t('onLimit.maxMoves.short')}</span>
                  </span>
                  {moves}
                </div>
              </div>
            </div>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <Card
      className="prov-card"
      title={
        <span className="prov-card-title" id="prov-onlimit-title">
          <Repeat2 {...ICON_SM} />
          {t('onLimit.title')}
        </span>
      }
      actions={<span className="mono prov-summary">{t('onLimit.scope')}</span>}
    >
      <div className="rot-intro">
        <p>{t('onLimit.intro')}</p>
        <div className="rot-callout">
          <span>{t('onLimit.default')}</span>
        </div>
      </div>
      <div className="rot-row">
        <div className="rot-col rot-text">
          <span className="rot-name">{t('onLimit.action.label')}</span>
          <span className="small muted">{t(`onLimit.action.${on.action}.hint`)}</span>
        </div>
        <div className="rot-ctl">
          <Segmented
            label={t('onLimit.action.aria')}
            value={on.action}
            onChange={(a) => change(onLimitWith(on, { action: a }))}
            options={ACTIONS.map((a) => ({ value: a, label: t(`onLimit.action.${a}.label`) }))}
          />
        </div>
      </div>
      <div className="rot-row">
        <div className="rot-col rot-text">
          <span className="rot-name">{t('onLimit.allowed.label')}</span>
          <span className="small muted">{t('onLimit.allowed.hint')}</span>
        </div>
        <div className="rot-ctl">
          <div className="rot-col rot-checks">
            {ACTIONS.map((a) => (
              <Checkbox
                key={a}
                className="rot-check"
                checked={on.allowed.includes(a)}
                disabled={a === on.action}
                onChange={(v) => change(allowedWith(on, a, v))}
                aria-label={t(`onLimit.action.${a}.label`)}
              >
                <span className="rot-col">
                  <span>{t(`onLimit.action.${a}.label`)}</span>
                  {a === on.action && <span className="small muted">{t('onLimit.allowed.chosen')}</span>}
                </span>
              </Checkbox>
            ))}
          </div>
        </div>
      </div>
      <div className="rot-row">
        <div className="rot-col rot-text">
          <span className="rot-name">{t('onLimit.maxWait.label')}</span>
          <span className="small muted">{t('onLimit.maxWait.hint', { min: WAIT_HOURS.min, max: WAIT_HOURS.max })}</span>
        </div>
        <div className="rot-ctl">
          {wait}
          <span className="mono small muted">{t('onLimit.maxWait.unit')}</span>
        </div>
      </div>
      <div className="rot-row">
        <div className="rot-col rot-text">
          <span className="rot-name">{t('onLimit.maxMoves.label')}</span>
          <span className="small muted">{t('onLimit.maxMoves.hint', { min: MOVES.min, max: MOVES.max })}</span>
        </div>
        <div className="rot-ctl">{moves}</div>
      </div>
      <div className="rot-foot">{actions}</div>
    </Card>
  );
}
