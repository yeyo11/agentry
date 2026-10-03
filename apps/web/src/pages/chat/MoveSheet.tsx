import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Chat, ProviderCandidates } from '@agentry/shared';
import { Info, Repeat2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '@agentry/ui/components/controls/Sheet';
import { Dialog } from '@agentry/ui/components/Dialog';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { usageTone } from '@agentry/ui/components/motion';
import { ProviderMark } from '@agentry/ui/components/ProviderMark';
import { useToast } from '@agentry/ui/components/Toast';
import { Segmented, Tag } from '@agentry/ui/components/ui';
import { formatNumber } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { modeLabel } from '@agentry/chat-ui/lib/wire-words';
import { useChatUi } from '@agentry/chat-ui/lib/context';
import { api, keys } from '../../api';

/** What the handoff may weigh: the text is cut to this by the server. */
const HANDOFF_MAX_KIB = 12;

export interface MoveChoice {
  provider: string;
  action: 'handoff' | 'restart';
}

/** "3,1 KiB", the unit the handoff is measured in. */
export const kib = (bytes: number): string => `${formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KiB`;

/**
 * The text of a handoff is shown with its section headers in strong type and the pasted block's tags
 * dimmed, as the prototype draws it: the header lines the server writes start with `## `.
 */
export function HandoffText({ text, full = false, label }: { text: string; full?: boolean; label: string }) {
  const lines = text.split('\n');
  return (
    <pre className={`hand-text${full ? ' full' : ''}`} tabIndex={0} aria-label={label}>
      {lines.map((line, at) => (
        // The text is built once, so a line's place is its identity
        // eslint-disable-next-line react/no-array-index-key
        <span key={at}>
          {line.startsWith('## ') ? <b className="hand-h">{line}</b> : line}
          {at < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}

/** A candidate's use of its limit as a thin bar in the usage thresholds: neutral below 60 %, warn from 60 %, bad from 75 %. */
export function UsageMeter({ percent }: { percent: number }) {
  const tone = usageTone(percent);
  return (
    <span className="meter-track meter-thin" aria-hidden>
      <span className={`meter-fill ${tone === 'neutral' ? '' : `is-${tone}`}`.trim()} style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * "Continue on Codex": the one place a move is decided. It shows where the work will go, the facts
 * that carry over and the exact text the next agent will receive, built here and sent nowhere until
 * the person confirms. A dialog on a desktop, a bottom sheet on a phone.
 */
export function MoveSheet({
  chat,
  candidates,
  labelOf,
  initial,
  onClose,
}: {
  chat: Chat;
  candidates: ProviderCandidates;
  labelOf: (id: string) => string;
  initial: MoveChoice;
  onClose: () => void;
}) {
  const { t } = useTranslation('chats');
  const narrow = useMediaQuery(NARROW);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { paths } = useChatUi();
  const [provider, setProvider] = useState(initial.provider);
  const [action, setAction] = useState(initial.action);
  const target = candidates.candidates.find((c) => c.provider === provider) ?? candidates.candidates[0];
  const targetId = target?.provider ?? provider;
  const name = labelOf(targetId);
  const from = labelOf(chat.provider);

  const handoff = useQuery({
    queryKey: keys.chatHandoff(chat.id, targetId, ''),
    queryFn: () => api.chatHandoff(chat.id, targetId),
    enabled: action === 'handoff' && Boolean(target),
    retry: false,
  });
  const move = useMutation({
    mutationFn: () => api.moveChat(chat.id, { provider: targetId, action }),
    onSuccess: (moved) => {
      void queryClient.invalidateQueries({ queryKey: keys.chats });
      void queryClient.invalidateQueries({ queryKey: keys.chatScope(chat.id) });
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      onClose();
      navigate(paths.chat(moved.id));
    },
    onError: (error) => toast.error(t('limit.sheet.moveFailed'), error),
  });

  const mode = chat.executions.at(-1)?.permissionMode;
  const fromModel = chat.model;
  const toModel = target?.model ?? null;
  const modelLine = toModel ? (fromModel && fromModel !== toModel ? `${fromModel} → ${toModel}` : toModel) : (fromModel ?? '—');
  const modelNote = toModel && fromModel && fromModel !== toModel ? t('limit.sheet.modelMapped') : toModel ? t('limit.sheet.modelSame') : t('limit.sheet.modelOwn');
  const title = action === 'handoff' ? t('limit.sheet.title', { name }) : t('limit.sheet.titleRestart', { name });
  const intro = action === 'handoff' ? t('limit.sheet.intro', { name }) : t('limit.sheet.introRestart', { name });

  const text = action === 'handoff' ? handoff.data?.text : chat.firstPrompt;
  const bytes = action === 'handoff' ? handoff.data?.bytes : chat.firstPrompt ? new TextEncoder().encode(chat.firstPrompt).length : undefined;
  const body = (
    <div className="mv-body">
      <Segmented
        label={t('limit.sheet.actionLabel', { name })}
        value={action}
        onChange={setAction}
        options={[
          { value: 'handoff', label: t('limit.sheet.handoff') },
          { value: 'restart', label: t('limit.sheet.restart') },
        ]}
      />
      <div className="mv-list" role="radiogroup" aria-label={t('limit.sheet.whereLabel')}>
        {candidates.candidates.map((candidate) => {
          const on = candidate.provider === targetId;
          const label = labelOf(candidate.provider);
          const percent = candidate.utilization === null ? null : Math.round(candidate.utilization * 100);
          return (
            <button key={candidate.provider} type="button" role="radio" aria-checked={on} className={`mv-cand${on ? ' on' : ''}`} onClick={() => setProvider(candidate.provider)}>
              <span className={`prov-radio${on ? ' on' : ''}`} aria-hidden />
              <ProviderMark provider={candidate.provider} label={label} />
              <span className="mv-main">
                <span className="mv-name">{label}</span>
                <span className="mv-model">{candidate.model && chat.model && candidate.model !== chat.model ? `${chat.model} → ${candidate.model}` : (candidate.model ?? chat.model ?? '—')}</span>
              </span>
              <span className="mv-use">
                <span>{percent === null ? t('limit.sheet.usedUnknown') : t('limit.sheet.used', { percent })}</span>
                {percent !== null && <UsageMeter percent={percent} />}
              </span>
            </button>
          );
        })}
        {candidates.excluded.map((row) => (
          <div key={row.provider} className="mv-cand out">
            <ProviderMark provider={row.provider} label={labelOf(row.provider)} />
            <span className="mv-main">
              <span className="mv-name">
                {labelOf(row.provider)} <Tag>{t('limit.sheet.unavailable')}</Tag>
              </span>
              <span className="mv-why">{t(`limit.excluded.${row.excluded}`)}</span>
            </span>
          </div>
        ))}
        {candidates.movesCapped && <p className="mv-note">{t('limit.capped')}</p>}
      </div>
      <div className="mv-facts">
        <div className="mv-fact">
          <span className="k">{t('limit.sheet.model')}</span>
          <span className="v">
            <span className="mono">{modelLine}</span>
            <small>{modelNote}</small>
          </span>
        </div>
        <div className="mv-fact">
          <span className="k">{t('limit.sheet.permissions')}</span>
          <span className="v">
            <span>{mode ? modeLabel(mode) : '—'}</span>
            <small>{t('limit.sheet.permissionsHint', { name })}</small>
          </span>
        </div>
        <div className="mv-fact">
          <span className="k">{t('limit.sheet.folder')}</span>
          <span className="v">
            <span className="mono">{chat.cwd}</span>
            <small>{t('limit.sheet.folderHint')}</small>
          </span>
        </div>
      </div>
      <div className="mv-text">
        <div className="hand-meta">
          <span className="t-label">{action === 'handoff' ? t('limit.sheet.textLabel') : t('limit.sheet.textRestart')}</span>
          {bytes !== undefined && action === 'handoff' && <span>{t('limit.sheet.size', { size: kib(bytes), max: `${HANDOFF_MAX_KIB} KiB` })}</span>}
          <span>{handoff.data?.model ?? toModel ?? ''}</span>
        </div>
        {action === 'handoff' && handoff.isError ? (
          <div className="mv-note" role="alert">
            <Info {...ICON} />
            <span>
              {t('limit.sheet.loadFailed')}{' '}
              <button type="button" className="btn btn-small" onClick={() => void handoff.refetch()}>
                {t('limit.sheet.retry')}
              </button>
            </span>
          </div>
        ) : text ? (
          <HandoffText text={text} label={t('limit.sheet.textLabel')} />
        ) : action === 'restart' ? (
          <p className="mv-note">{t('limit.sheet.noPrompt')}</p>
        ) : null}
      </div>
      <div className="mv-note">
        <Info {...ICON} />
        <span>{t('limit.sheet.callout', { from, to: name })}</span>
      </div>
    </div>
  );

  const confirm = (
    <div className="mv-foot">
      <span className="t-xs fg-2 grow">{t('limit.sheet.foot')}</span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('limit.sheet.cancel')}
      </button>
      <button type="button" className="btn btn-primary" disabled={!target || move.isPending || (action === 'handoff' && !handoff.data)} onClick={() => move.mutate()}>
        <Repeat2 {...ICON_SM} /> {action === 'handoff' ? t('limit.sheet.confirm', { name }) : t('limit.sheet.confirmRestart', { name })}
      </button>
    </div>
  );

  const heading: ReactNode = (
    <span className="mv-title">
      <ProviderMark provider={targetId} label={name} decorative />
      <span>{title}</span>
    </span>
  );

  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={title} description={intro} footer={confirm} closeLabel={t('limit.sheet.close')}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={heading} onClose={onClose} footer={confirm} width={720}>
      <p className="t-xs fg-2 mv-intro">{intro}</p>
      {body}
    </Dialog>
  );
}
