import type { FlowRun, ProviderId, ProviderMove, WorkItemDetail } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { Repeat2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@agentry/ui/components/icons';
import { formatHour } from '@agentry/ui/lib/format';
import { useChatUi } from '@agentry/chat-ui/lib/context';
import { api, keys, useProviderMoves, useWorkItemRuns } from '../../api';
import { ProviderChain, useMovedWords } from '../../components/ProviderChain';
import { useProviderLabel } from '../../lib/provider-status';
import { rotationOf } from '../config/providers/rotation';
import { movedRunsOf } from '../tasks/item/model';

/** The moves a flow run made that made a new chat, oldest first. */
export function movesOfRun(run: FlowRun, moves: readonly ProviderMove[]): ProviderMove[] {
  return movedRunsOf([run], moves).map((moved) => moved.move);
}

/** The providers the run went through, oldest first, each with the chat it ran in. */
export function chainOfMoves(moves: readonly ProviderMove[]): Array<{ chatId: string; provider: ProviderId }> {
  const first = moves[0];
  if (!first) return [];
  return [{ chatId: first.fromChat, provider: first.fromProvider }, ...moves.flatMap((move) => (move.toChat && move.toProvider ? [{ chatId: move.toChat, provider: move.toProvider }] : []))];
}

/**
 * Under the header of a flow run's chat that came from another provider: "This run continues here
 * from Claude Code", the chain the run went through and how many moves it has made of the ones the
 * settings allow. It is still the member's run of the item, so the strip says that first. Nothing in
 * it moves: a move is history, not live work.
 */
export function FlowMovedNote({ chatId, link }: { chatId: string; link: { item: Pick<WorkItemDetail, 'id' | 'projectId' | 'links'> } }) {
  const { t } = useTranslation('chats');
  const label = useProviderLabel();
  const movedWords = useMovedWords();
  const { paths } = useChatUi();
  const { item } = link;
  const flowChat = item.links.some((l) => l.kind === 'chat' && l.chatId === chatId && Boolean(l.teamRole));
  const runs = useWorkItemRuns(item.id, flowChat).data;
  const moves = useProviderMoves(flowChat ? item.projectId : null).data;
  const settings = useQuery({ queryKey: keys.providerSettings, queryFn: () => api.providerSettings(), enabled: flowChat });
  const run = runs?.find((r) => r.chatId === chatId);
  if (!run || !moves) return null;
  const made = movesOfRun(run, moves);
  const last = made.at(-1);
  if (!last || last.toChat !== chatId || !last.toProvider) return null;
  const max = settings.data ? rotationOf(settings.data).onLimit.maxMoves : null;
  const from = label(last.fromProvider);
  const to = label(last.toProvider);
  const how = [movedWords(last.action), formatHour(last.at), last.toModel].filter(Boolean).join(' · ');
  return (
    <div className="flow-moved" role="status">
      <Repeat2 {...ICON_SM} className="flow-moved-icon" aria-hidden />
      <div className="flow-moved-body">
        <span>
          <b>{t('limit.flowMoved.title', { name: from })}</b> {t(last.action === 'restart' ? 'limit.flowMoved.restart' : 'limit.flowMoved.handoff', { name: from, to })}
        </span>
        <ProviderChain chain={chainOfMoves(made)} how={how} />
        <div className="flow-moved-foot">
          <span className="mono">{max === null ? t('limit.flowMoved.movesNoMax', { count: made.length }) : t('limit.flowMoved.moves', { count: made.length, max })}</span>
          <Link to={paths.chat(last.fromChat)} className="btn btn-small btn-ghost">
            {t('limit.flowMoved.previous')}
          </Link>
        </div>
      </div>
    </div>
  );
}
