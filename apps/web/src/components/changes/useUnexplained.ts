import type { DecisionRecord } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { api, keys } from '../../api';
import { UNEXPLAINED_POINT } from './review-model';

/** Every judgement of the chat's edits: one request for all the steps of a review. */
export function useUnexplainedRows(chatId: string | null): readonly DecisionRecord[] {
  const query = { point: UNEXPLAINED_POINT, subjectKind: 'chat', subjectId: chatId ?? '', visible: true, limit: 200 } as const;
  const rows = useQuery({ queryKey: keys.decisionsRecent(query), queryFn: () => api.decisions(query), enabled: !!chatId, staleTime: 15_000 });
  return rows.data?.items ?? [];
}
