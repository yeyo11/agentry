import type { Health, HealthSignal, SupervisorProposal } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleSlash, Clock, Lightbulb, Pencil, Repeat, Send, TriangleAlert, OctagonX, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { cancellable, healthWord, type HealthWord } from '../../lib/observe';
import { healthReason, signalHint, signalReason } from '../../lib/server-strings';
import { Tooltip } from '../controls/Tooltip';
import { useConfirm } from '../Dialog';
import { ICON_SM } from '../icons';
import { useToast } from '../Toast';
import { ErrorBox, Field } from '../ui';

const TONE: Record<HealthWord, string> = { ok: 'ok', slow: 'warn', stuck: 'bad', looping: 'bad' };
// A shape per word besides the colour and the text: it still reads in greyscale
const ICON: Record<HealthWord, LucideIcon> = { ok: CircleCheck, slow: Clock, stuck: OctagonX, looping: Repeat };

/**
 * ok, slow, stuck or looping: said in words and with a shape, the reason one hover away. A hint the
 * supervisor proposed and nobody has judged yet is part of the badge, since it is what to act on.
 */
export function HealthBadge({ health }: { health: Pick<Health, 'level' | 'signals' | 'reason' | 'proposal'> }) {
  const { t } = useTranslation('observe');
  const word = healthWord(health);
  const Icon = ICON[word];
  const proposed = health.proposal?.status === 'proposed';
  return (
    <Tooltip content={proposed ? `${healthReason(health)} ${t('supervisor.badgeHint')}` : healthReason(health)}>
      <span className={`badge badge-${TONE[word]}`}>
        <Icon size={12} strokeWidth={2} aria-hidden />
        {t(`health.word.${word}`)}
        {proposed && (
          <>
            <Lightbulb size={12} strokeWidth={2} aria-hidden />
            <span className="sr-only">{t('supervisor.badgeHint')}</span>
          </>
        )}
      </span>
    </Tooltip>
  );
}

/**
 * What the supervisor proposed for the worst signal. Send delivers it as written; Edit opens the
 * hint box with it, and a hint sent from there answers the proposal, so it is dismissed after it.
 */
function ProposalRow({
  proposal,
  live,
  sendHint,
  onChanged,
}: {
  proposal: SupervisorProposal;
  live: boolean;
  sendHint: (text: string) => Promise<unknown>;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['observe', 'common']);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const settle = useMutation({
    mutationFn: (action: 'send' | 'dismiss') => api.settleSupervisorProposal(proposal, action),
    onSuccess: (_result, action) => {
      if (action === 'send') toast.success(t('observe:health.hintSent'));
      onChanged();
    },
  });
  const sendEdited = async (text: string) => {
    await sendHint(text);
    // The hint reached the worker already; a proposal settled in the meantime is nothing to report
    await api.settleSupervisorProposal(proposal, 'dismiss').catch(() => undefined);
  };

  return (
    <div className="obs-signal obs-proposal" role="group" aria-label={t('observe:supervisor.title')}>
      <div className="obs-signal-line">
        <Lightbulb {...ICON_SM} />
        <span className="strong">{t('observe:supervisor.proposes')}</span>
      </div>
      <p className="small break obs-proposal-text">{proposal.hint}</p>
      {!editing && (
        <div className="task-actions">
          {live && (
            <button type="button" className="btn btn-small btn-primary" disabled={settle.isPending} onClick={() => settle.mutate('send')}>
              <Send {...ICON_SM} /> {t('observe:supervisor.send')}
            </button>
          )}
          {live && (
            <button type="button" className="btn btn-small" disabled={settle.isPending} onClick={() => setEditing(true)}>
              <Pencil {...ICON_SM} /> {t('observe:supervisor.edit')}
            </button>
          )}
          <button type="button" className="btn btn-small" disabled={settle.isPending} onClick={() => settle.mutate('dismiss')}>
            <X {...ICON_SM} /> {t('observe:supervisor.dismiss')}
          </button>
        </div>
      )}
      <ErrorBox error={settle.error} />
      {editing && (
        <HintBox
          initial={proposal.hint}
          send={sendEdited}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** The signals a person can do something about; the rest of a chat's facts stay in the side card. */
const STEP_IN = new Set<HealthSignal['kind']>(['hung-command', 'repeat-stall', 'no-progress', 'loop', 'weakened-test', 'silence', 'budget']);

export const isStepIn = (signal: HealthSignal): boolean => STEP_IN.has(signal.kind);

function HintBox({ initial, send, onDone }: { initial: string; send: (text: string) => Promise<unknown>; onDone: () => void }) {
  const { t } = useTranslation(['observe', 'common']);
  const toast = useToast();
  const [text, setText] = useState(initial);
  const mutation = useMutation({
    mutationFn: () => send(text.trim()),
    onSuccess: () => {
      toast.success(t('observe:health.hintSent'));
      onDone();
    },
  });
  return (
    <form
      className="stack-tight"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) mutation.mutate();
      }}
    >
      <Field label={t('observe:health.hintLabel')} hint={t('observe:health.hintExplained')}>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </Field>
      <ErrorBox error={mutation.error} />
      <div className="form-actions">
        <button type="submit" className="btn btn-small btn-primary" disabled={mutation.isPending || !text.trim()}>
          <Send {...ICON_SM} /> {mutation.isPending ? t('observe:health.sending') : t('observe:health.sendHint')}
        </button>
        <button type="button" className="btn btn-small" onClick={onDone} disabled={mutation.isPending}>
          {t('common:actions.cancel')}
        </button>
      </div>
    </form>
  );
}

function SignalRow({
  signal,
  chatId,
  live,
  sendHint,
  onChanged,
}: {
  signal: HealthSignal;
  chatId: string | null;
  live: boolean;
  sendHint: (text: string) => Promise<unknown>;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['observe', 'common']);
  const confirm = useConfirm();
  const toast = useToast();
  const [hinting, setHinting] = useState(false);
  const cancel = useMutation({
    mutationFn: (toolUseId: string) => api.cancelCommand(chatId ?? '', toolUseId),
    onSuccess: (result) => {
      toast.success(t('observe:health.cancelled'), result.command);
      onChanged();
    },
  });
  const toolUseId = cancellable(signal) ? signal.toolUseId : null;
  const hint = signalHint(signal);
  // `detail` is a command or a path for most signals, and the word `time` or `cost` for a budget
  const detail = signal.detail && signal.detail !== 'time' && signal.detail !== 'cost' ? signal.detail : null;

  return (
    <li className={`obs-signal obs-signal-${signal.level}`}>
      <div className="obs-signal-line">
        <TriangleAlert {...ICON_SM} />
        <span>
          <span className="sr-only">{t(`observe:health.level.${signal.level}`)}: </span>
          {signalReason(signal)}
        </span>
      </div>
      {detail && <div className="mono small muted break">{detail}</div>}
      {live && chatId && (toolUseId || hint) && (
        <div className="task-actions">
          {toolUseId && (
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={cancel.isPending}
              onClick={() =>
                void confirm({
                  title: t('observe:health.cancelTitle'),
                  body: (
                    <>
                      <p>{t('observe:health.cancelBody')}</p>
                      {detail && <p className="mono small break">{detail}</p>}
                    </>
                  ),
                  confirmLabel: t('observe:health.cancel'),
                  danger: true,
                }).then((ok) => {
                  if (ok) cancel.mutate(toolUseId);
                })
              }
            >
              <CircleSlash {...ICON_SM} /> {t('observe:health.cancel')}
            </button>
          )}
          {hint && !hinting && (
            <button type="button" className="btn btn-small" onClick={() => setHinting(true)}>
              <Send {...ICON_SM} /> {t('observe:health.hint')}
            </button>
          )}
        </div>
      )}
      <ErrorBox error={cancel.error} />
      {hinting && <HintBox initial={hint ?? ''} send={sendHint} onDone={() => setHinting(false)} />}
    </li>
  );
}

/**
 * What core noticed about a worker, and the three ways to step in: cancel the command that hangs
 * (the worker carries on), send it a hint that is already written for this signal, or interrupt the
 * turn. Only a chat something is working on can be acted on, so a finished one just shows why.
 */
export function HealthPanel({
  health,
  chatId,
  live,
  sendHint,
  badge = true,
}: {
  health: Health;
  /** The chat that does the work: a task's worker or the chat itself */
  chatId: string | null;
  live: boolean;
  sendHint: (text: string) => Promise<unknown>;
  /** Off where the caller already shows the badge */
  badge?: boolean;
}) {
  const { t } = useTranslation('observe');
  const queryClient = useQueryClient();
  const signals = health.signals.filter(isStepIn);
  const proposal = health.proposal?.status === 'proposed' ? health.proposal : null;
  const refresh = () => {
    if (chatId) void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
    void queryClient.invalidateQueries({ queryKey: ['orchestration'] });
    void queryClient.invalidateQueries({ queryKey: ['orchestrations'] });
  };
  const interrupt = useMutation({ mutationFn: () => api.interruptChat(chatId ?? ''), onSuccess: refresh });

  if (signals.length === 0 && !proposal) return null;
  return (
    <div className="stack-tight obs-health" role="group" aria-label={t('health.title')}>
      <div className="obs-health-head">
        {badge && <HealthBadge health={health} />}
        {live && chatId && (
          <Tooltip content={t('health.interruptHint')}>
            <button type="button" className="btn btn-small" disabled={interrupt.isPending} onClick={() => interrupt.mutate()}>
              <CircleSlash {...ICON_SM} /> {t('health.interrupt')}
            </button>
          </Tooltip>
        )}
      </div>
      {proposal && <ProposalRow key={proposal.id} proposal={proposal} live={live && Boolean(chatId)} sendHint={sendHint} onChanged={refresh} />}
      <ul className="obs-signals">
        {signals.map((signal) => (
          <SignalRow key={`${signal.kind}:${signal.toolUseId ?? signal.detail ?? ''}`} signal={signal} chatId={chatId} live={live} sendHint={sendHint} onChanged={refresh} />
        ))}
      </ul>
      <ErrorBox error={interrupt.error} />
    </div>
  );
}
