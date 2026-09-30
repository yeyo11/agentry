import type { WorkItemPriority, WorkItemTriage, WorkItemType } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { DecisionMarkOf } from '../../../components/DecisionMark';
import { ICON_SM } from '../../../components/icons';
import type { SetDraft } from './model';

/** The title is asked about once it is long enough to say something, and only when the person pauses. */
const MIN_CHARS = 4;
const PAUSE_MS = 900;

interface Inputs {
  projectId: string | null;
  title: string;
  description: string;
  offered: readonly WorkItemType[];
  set: SetDraft;
}

/**
 * `board.triage` while the draft is typed: the type and priority it would prefill, and a warning when
 * an open item seems to cover it. It only fills a field the person has not touched, and changes
 * nothing for a project whose point is off (the answer is then null and the form stays as it is).
 */
export function useTriage({ projectId, title, description, offered, set }: Inputs) {
  const [triage, setTriage] = useState<WorkItemTriage | null>(null);
  const touched = useRef({ type: false, priority: false });
  const asked = useRef('');
  const latest = useRef({ offered, set });
  latest.current = { offered, set };

  useEffect(() => {
    setTriage(null);
    asked.current = '';
  }, [projectId]);

  const text = title.trim();
  useEffect(() => {
    if (!projectId || text.length < MIN_CHARS) return;
    const key = `${projectId}\n${text}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (asked.current === key) return;
      asked.current = key;
      api
        .triageWorkItem(projectId, { title: text, description }, { signal: controller.signal })
        .then(({ triage: found }) => {
          setTriage(found);
          if (!found) return;
          const { offered: types, set: fill } = latest.current;
          if (!touched.current.type && types.includes(found.type)) fill('type', found.type);
          if (!touched.current.priority) fill('priority', found.priority);
        })
        .catch(() => {
          // A suggestion is a convenience: the form works without it
          asked.current = '';
        });
    }, PAUSE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, text, description]);

  /** A field the person set is theirs: the suggestion stops filling it, and its mark goes if they changed it. */
  const own = (field: 'type' | 'priority', value: WorkItemType | WorkItemPriority): void => {
    touched.current[field] = true;
    if (triage && triage[field] !== value) setTriage({ ...triage, decisionId: null });
  };

  return { triage, own };
}

/** The mark of the decision that filled the form, and the warning about a possible duplicate. */
export function TriageNote({ triage }: { triage: WorkItemTriage | null }) {
  const { t } = useTranslation('workItem');
  const found = useQuery({
    queryKey: keys.decision(triage?.decisionId ?? ''),
    queryFn: ({ signal }) => api.decision(triage?.decisionId ?? '', { signal }),
    enabled: Boolean(triage?.decisionId),
    staleTime: 60_000,
  });
  const decision = triage?.decisionId ? found.data : undefined;
  if (!triage || (!triage.duplicate && !decision)) return null;
  return (
    <div className="newtask-triage">
      {decision && <DecisionMarkOf decision={decision} />}
      {decision && <span className="small muted">{t('newTask.triage.filled')}</span>}
      {triage.duplicate && (
        <span className="newtask-triage-dup small" role="status">
          <TriangleAlert {...ICON_SM} />
          {t('newTask.triage.duplicate')}
        </span>
      )}
    </div>
  );
}
