import type { JournalEntry, JournalEntryKind } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookText, Check, GitCommitVertical, StickyNote, Trash2, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useJournal } from '../../../api';
import { useConfirm, Dialog } from '../../../components/Dialog';
import { ICON_SM, Monogram } from '../../../components/icons';
import { useToast } from '../../../components/Toast';
import { ErrorBox, Segmented, Skeleton } from '../../../components/ui';
import { formatDate, formatDateTime, formatNumber, timeAgo } from '../../../lib/format';
import { taskPath } from '../../../lib/work-items';
import { usePersonName } from '../../tasks/item/hooks';
import { RoleAvatar, useRoleName } from '../../team/RoleAvatar';
import { dayGroups, hourMinute } from './model';

const KIND_ICON: Record<JournalEntryKind, LucideIcon> = { closed: Check, decision: GitCommitVertical, memory: BookText, note: StickyNote };

/** How many entries a page reads, and how many more "Show more" adds. */
const PAGE = 30;

type Say = (key: string, values?: Record<string, string>) => string;

/** Who wrote an entry and who approved it, in one mono line: "Product Owner · from AGN-12 · approved by you". */
function useCause() {
  const { t } = useTranslation('home');
  const roleName = useRoleName();
  const say = t as unknown as Say;
  return (entry: JournalEntry): string => {
    const parts: string[] = [];
    if (entry.kind === 'closed') {
      parts.push(entry.approvedBy?.kind === 'person' || !entry.approvedBy ? say('memoryTab.journal.approvedDone') : say('memoryTab.journal.closedBy'));
      return parts.join(' · ');
    }
    if (entry.author.kind === 'agent') parts.push(entry.author.role ? roleName(entry.author.role) : say('memoryTab.journal.agent'));
    else if (entry.kind === 'note' || entry.kind === 'decision') parts.push(say('memoryTab.journal.byYou'));
    if (entry.documentPath) parts.push(entry.documentPath.split('/').pop() ?? entry.documentPath);
    if (entry.item) parts.push(say('memoryTab.journal.fromItem', { key: entry.item.key }));
    if (entry.approvedBy?.kind === 'person' && entry.author.kind !== 'person') parts.push(say('memoryTab.journal.approvedByYou'));
    return parts.join(' · ');
  };
}

/** The entry's own line: the item closed, the decision, the memory, the note. */
function EntryText({ entry }: { entry: JournalEntry }) {
  const { t } = useTranslation('home');
  if (entry.kind === 'closed') {
    return (
      <span>
        {entry.item ? (
          <Link to={taskPath(entry.item.key)} className="journal-key">
            {entry.item.key}
          </Link>
        ) : null}{' '}
        {t('memoryTab.journal.closed')} · {entry.text}
      </span>
    );
  }
  if (entry.kind === 'decision') return <span>{t('memoryTab.journal.decision', { text: entry.text })}</span>;
  if (entry.kind === 'memory') return <span>{t('memoryTab.journal.memory', { text: entry.text })}</span>;
  return <span>{entry.text}</span>;
}

function DeleteEntry({ entry }: { entry: JournalEntry }) {
  const { t } = useTranslation(['home', 'common']);
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeJournalEntry(entry.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.journal(entry.projectId) }),
    onError: (error) => toast.error(t('memoryTab.journal.deleteFailed'), error),
  });
  return (
    <button
      type="button"
      className="icon-btn journal-delete"
      aria-label={t('memoryTab.journal.delete')}
      disabled={remove.isPending}
      onClick={() =>
        void confirm({ title: t('memoryTab.journal.deleteTitle'), body: t('memoryTab.journal.deleteBody'), confirmLabel: t('common:actions.delete'), danger: true }).then(
          (ok) => ok && remove.mutate(),
        )
      }
    >
      <Trash2 {...ICON_SM} />
    </button>
  );
}

/** The mark of who wrote an entry on a phone: the role, or the person. */
function Author({ entry, person }: { entry: JournalEntry; person: string }) {
  if (entry.author.kind === 'agent' && entry.author.role) return <RoleAvatar role={entry.author.role} size="sm" />;
  return <Monogram name={person} size={22} />;
}

/**
 * The project journal (decision 32): decisions taken and items closed, newest first, grouped by
 * day. The newest of it is handed to every flow run; the header says how much.
 */
export function Journal({ projectId, phone = false }: { projectId: string; phone?: boolean }) {
  const { t, i18n } = useTranslation('home');
  const [limit, setLimit] = useState(PAGE);
  const journal = useJournal(projectId, { limit });
  const cause = useCause();
  const person = usePersonName();
  const page = journal.data;
  // Newest first by when it happened: an entry written late about an earlier day still sorts by its day
  const groups = dayGroups([...(page?.entries ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), new Date());
  const say = t as unknown as Say;
  const dayLabel = (day: string) => (day === 'today' ? t('memoryTab.journal.today') : day === 'yesterday' ? t('memoryTab.journal.yesterday') : formatDate(day));

  const more = page?.nextBefore && (
    <button type="button" className="btn doc-quiet btn-small journal-more" disabled={journal.isFetching} onClick={() => setLimit((n) => Math.min(n + PAGE * 2, 200))}>
      {t('memoryTab.journal.more')}
    </button>
  );

  const body = journal.isLoading ? (
    <Skeleton rows={4} height={16} />
  ) : journal.error ? (
    <ErrorBox error={journal.error} />
  ) : groups.length === 0 ? (
    <p className="small muted memory-none">{t('memoryTab.journal.none')}</p>
  ) : phone ? (
    <>
      {groups.map((group) => (
        <section key={group.day} className="journal-day">
          <h3 className="section-label">{dayLabel(group.day)}</h3>
          <ul className="card journal-cards">
            {group.entries.map((entry) => (
              <li key={entry.id} className="journal-card">
                <div className="journal-card-top">
                  <span className="badge journal-kind">
                    {(() => {
                      const Icon = KIND_ICON[entry.kind];
                      return <Icon size={11} strokeWidth={2} aria-hidden />;
                    })()}
                    {say(`memoryTab.journal.kind.${entry.kind}`)}
                  </span>
                  {entry.item && <span className="workitem-key">{entry.item.key}</span>}
                  <span className="doc-fill" />
                  <time className="mono small muted tnum" dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
                    {hourMinute(entry.createdAt, i18n.language)}
                  </time>
                </div>
                <p className="journal-card-text">{entry.text}</p>
                <div className="journal-card-by">
                  <Author entry={entry} person={person} />
                  <span>{cause(entry)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more}
    </>
  ) : (
    <div className="journal-list">
      {groups.map((group) => (
        <section key={group.day} className="journal-day" aria-label={dayLabel(group.day)}>
          <h3 className="section-label journal-day-label">{dayLabel(group.day)}</h3>
          <ul className="journal-entries">
            {group.entries.map((entry) => {
              const Icon = KIND_ICON[entry.kind];
              return (
                <li key={entry.id} className="history-entry journal-entry">
                  <span className="history-icon" aria-hidden>
                    <span>
                      <Icon size={11} strokeWidth={2} />
                    </span>
                  </span>
                  <span className="history-text">
                    <EntryText entry={entry} />
                    <span className="history-cause">{cause(entry)}</span>
                  </span>
                  <DeleteEntry entry={entry} />
                  <time dateTime={entry.createdAt} title={formatDateTime(entry.createdAt)}>
                    {timeAgo(entry.createdAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {more}
    </div>
  );

  const total = page?.total ?? 0;
  if (phone) {
    return (
      <>
        <p className="small muted memory-phone-intro">{t('memoryTab.journal.phoneIntro', { n: formatNumber(page?.handed.entries ?? 0) })}</p>
        {body}
      </>
    );
  }
  return (
    <section className="card memory-card" aria-labelledby="memory-journal-title">
      <div className="card-head">
        <h2 id="memory-journal-title">{t('memoryTab.journal.title')}</h2>
        <span className="doc-fill" />
        <span className="mono small muted">{t('memoryTab.journal.summary', { count: total, n: formatNumber(total) })}</span>
      </div>
      {body}
    </section>
  );
}

/** "Add to the journal": a decision taken or a note, written by the person. */
export function AddJournalDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useTranslation(['home', 'common']);
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'decision' | 'note'>('decision');
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => api.addJournalEntry(projectId, { kind, text: text.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.journal(projectId) });
      onClose();
    },
    onError: (error) => toast.error(t('memoryTab.journal.addFailed'), error),
  });
  return (
    <Dialog
      title={t('memoryTab.journal.addTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={!text.trim() || add.isPending} onClick={() => add.mutate()}>
            {t('memoryTab.journal.add')}
          </button>
        </>
      }
    >
      <div className="form">
        <Segmented<'decision' | 'note'>
          label={t('memoryTab.journal.kindLabel')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'decision', label: t('memoryTab.journal.kind.decision') },
            { value: 'note', label: t('memoryTab.journal.kind.note') },
          ]}
        />
        <label className="field">
          <span className="field-label">{kind === 'decision' ? t('memoryTab.journal.decisionLabel') : t('memoryTab.journal.noteLabel')}</span>
          <textarea data-autofocus rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          <span className="field-hint">{t('memoryTab.journal.addHint')}</span>
        </label>
      </div>
    </Dialog>
  );
}
