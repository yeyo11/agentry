import type { FlowRun, ProviderMove, WorkItemDetail } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { NoCounterpartWhy, ProviderChain, useMovedWords, useNoCounterpart, WaitLine } from '../../../components/ProviderChain';
import { useItemRuns } from './Activity';

type ChainMove = Pick<ProviderMove, 'subjectId' | 'fromChat' | 'toChat' | 'fromProvider' | 'toProvider' | 'toModel' | 'action' | 'at'>;

/**
 * The providers a run went through, from the moves that took it: the chat it started in, then each
 * new chat. Empty for a run that never moved.
 */
export function runChain(run: Pick<FlowRun, 'id'>, moves: readonly ChainMove[]) {
  const own = moves.filter((move) => move.subjectId === run.id && move.toChat !== null && move.toProvider !== null && move.action !== 'wait').sort((a, b) => a.at.localeCompare(b.at));
  const first = own[0];
  if (!first) return [];
  return [
    { chatId: first.fromChat, provider: first.fromProvider, model: null, action: null },
    ...own.map((move) => ({ chatId: move.toChat ?? '', provider: move.toProvider ?? move.fromProvider, model: move.toModel, action: move.action })),
  ];
}

function WaitingRun({ run }: { run: FlowRun & { waiting: NonNullable<FlowRun['waiting']> } }) {
  const { t } = useTranslation('components');
  const noCounterpart = useNoCounterpart(run.waiting);
  return <WaitLine wait={run.waiting} why={noCounterpart ? <NoCounterpartWhy provider={noCounterpart.provider} model={run.model} /> : t('limitWait.why')} />;
}

/**
 * What the item's active runs say about their provider: the wait line while a run waits for its
 * limit to reset (warn and still, never live), and the chain of providers a run that moved went
 * through. Nothing when no run waits or moved.
 */
export function RunState({ item }: { item: Pick<WorkItemDetail, 'id' | 'links' | 'projectId'> }) {
  const { runs, moved } = useItemRuns(item);
  const movedWords = useMovedWords();
  const active = runs.filter((run) => run.state === 'running' || run.state === 'queued');
  const waiting = active.flatMap((run) => (run.waiting ? [{ ...run, waiting: run.waiting }] : []));
  const moves = moved.map((m) => m.move);
  const chains = active.flatMap((run) => {
    const chain = runChain(run, moves);
    const last = chain[chain.length - 1];
    return chain.length > 1 && last ? [{ id: run.id, chain, how: [movedWords(last.action), last.model].filter(Boolean).join(' · ') }] : [];
  });
  if (waiting.length === 0 && chains.length === 0) return null;
  return (
    <div className="workitem-runstate">
      {chains.map((c) => (
        <ProviderChain key={c.id} chain={c.chain} how={c.how || undefined} />
      ))}
      {waiting.map((run) => (
        <WaitingRun key={run.id} run={run} />
      ))}
    </div>
  );
}
