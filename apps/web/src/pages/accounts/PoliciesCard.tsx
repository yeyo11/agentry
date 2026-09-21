import type { AccountSummary, Project, RotationPolicy } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Route, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys, useProjects } from '../../api';
import { Checkbox, Slider, Tooltip } from '../../components/controls';
import { useConfirm } from '../../components/Dialog';
import { ICON_SM } from '../../components/icons';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, Field } from '../../components/ui';

interface Draft {
  /** Absent while a new policy is being written */
  id?: string;
  threshold: number;
  order: number[];
  projects: string[];
  looseChats: boolean;
}

const NEW_POLICY: Draft = { threshold: 85, order: [], projects: [], looseChats: false };

/** A policy needs something to govern: some projects, the chats without one, or both. */
const governsSomething = (draft: Draft) => draft.projects.length > 0 || draft.looseChats;

const accountName = (accounts: AccountSummary[], number: number) => {
  const found = accounts.find((a) => a.number === number);
  return found ? `#${number} · ${found.alias ?? found.email}` : `#${number}`;
};

/** Which accounts the chats of some projects may use, in what order, and when to move on to the next. */
function PolicyForm({
  draft,
  accounts,
  projects,
  taken,
  looseTaken,
  onChange,
  onDone,
}: {
  draft: Draft;
  accounts: AccountSummary[];
  projects: Project[];
  /** Project id → the policy that already governs it: a project has at most one */
  taken: Map<string, string>;
  /** The policy that already governs the chats without a project, when one does: at most one may */
  looseTaken: string | null;
  onChange: (next: Draft) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const queryClient = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => {
      const body = { threshold: draft.threshold, projects: draft.projects, looseChats: draft.looseChats, ...(draft.order.length ? { order: draft.order } : {}) };
      return draft.id ? api.updateAccountPolicy(draft.id, body) : api.createAccountPolicy(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
      toast.success(draft.id ? t('policies.updated') : t('policies.created'));
      onDone();
    },
  });

  const move = (index: number, by: -1 | 1) => {
    const next = [...draft.order];
    const other = index + by;
    const a = next[index];
    const b = next[other];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[other] = a;
    onChange({ ...draft, order: next });
  };
  const toggleProject = (id: string) =>
    onChange({ ...draft, projects: draft.projects.includes(id) ? draft.projects.filter((p) => p !== id) : [...draft.projects, id] });

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (governsSomething(draft)) save.mutate();
      }}
    >
      <div className="stack-tight">
        <div className="field-label" id="policy-projects">
          {t('policies.projects')}
        </div>
        <div className="chips" role="group" aria-labelledby="policy-projects">
          {projects.length === 0 && <span className="muted small">{t('policies.noProjects')}</span>}
          {projects.map((project) => {
            const on = draft.projects.includes(project.id);
            const other = taken.get(project.id);
            // A project that another policy governs cannot be given to this one
            const blocked = !on && other !== undefined && other !== draft.id;
            return (
              <button
                key={project.id}
                type="button"
                className={`chip ${on ? 'chip-on' : ''}`}
                aria-pressed={on}
                disabled={blocked}
                onClick={() => toggleProject(project.id)}
              >
                {on && <Check size={12} strokeWidth={2.2} aria-hidden />}
                {project.name}
                {blocked && <span className="sr-only"> {t('policies.alreadyGoverned')}</span>}
              </button>
            );
          })}
        </div>
        <span className="field-hint">{t('policies.projectsHint')}</span>
      </div>

      <div className="stack-tight">
        <Checkbox checked={draft.looseChats} disabled={!draft.looseChats && looseTaken !== null && looseTaken !== draft.id} onChange={(looseChats) => onChange({ ...draft, looseChats })}>
          {t('policies.looseChats')}
        </Checkbox>
        <span className="field-hint">
          {!draft.looseChats && looseTaken !== null && looseTaken !== draft.id ? t('policies.looseChatsTaken') : t('policies.looseChatsHint')}
        </span>
      </div>

      <Field label={t('policies.thresholdValue', { pct: draft.threshold })} hint={t('policies.thresholdHint')}>
        <Slider aria-label={t('policies.threshold')} min={50} max={99} value={draft.threshold} onChange={(threshold) => onChange({ ...draft, threshold })} />
      </Field>

      <div className="stack-tight">
        <div className="field-label" id="policy-order">
          {t('policies.order')}
        </div>
        {draft.order.length === 0 ? (
          <p className="muted small">{t('policies.orderEmpty')}</p>
        ) : (
          <ol className="list" aria-labelledby="policy-order">
            {draft.order.map((number, i) => (
              <li key={number} className="list-row list-row-flow small">
                <span className="count">{i + 1}</span>
                <span className="break">{accountName(accounts, number)}</span>
                <span className="row-actions">
                  <button type="button" className="icon-btn" disabled={i === 0} aria-label={t('policies.moveEarlier', { name: accountName(accounts, number) })} onClick={() => move(i, -1)}>
                    <ArrowUp {...ICON_SM} />
                  </button>
                  <button type="button" className="icon-btn" disabled={i === draft.order.length - 1} aria-label={t('policies.moveLater', { name: accountName(accounts, number) })} onClick={() => move(i, 1)}>
                    <ArrowDown {...ICON_SM} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('policies.removeAccount', { name: accountName(accounts, number) })} onClick={() => onChange({ ...draft, order: draft.order.filter((n) => n !== number) })}>
                    <X {...ICON_SM} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="chips" role="group" aria-label={t('policies.addAccount')}>
          {accounts
            .filter((a) => !draft.order.includes(a.number))
            .map((a) => (
              <button key={a.number} type="button" className="chip" onClick={() => onChange({ ...draft, order: [...draft.order, a.number] })}>
                <Plus size={12} strokeWidth={2.2} aria-hidden />
                {accountName(accounts, a.number)}
              </button>
            ))}
        </div>
        <span className="field-hint">{t('policies.orderHint')}</span>
      </div>

      <ErrorBox error={save.error} title={t('policies.saveFailed')} />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!governsSomething(draft) || save.isPending}>
          {save.isPending ? t('policies.saving') : draft.id ? t('policies.update') : t('policies.create')}
        </button>
        <button type="button" className="btn" disabled={save.isPending} onClick={onDone}>
          {t('common:actions.cancel')}
        </button>
      </div>
    </form>
  );
}

export function PoliciesCard({ policies, accounts }: { policies: RotationPolicy[]; accounts: AccountSummary[] }) {
  const { t } = useTranslation(['accountsConfig', 'common']);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const projects = useProjects(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const projectList = projects.data ?? [];
  const taken = new Map(policies.flatMap((policy) => policy.projects.map((project) => [project, policy.id] as const)));
  const looseTaken = policies.find((policy) => policy.looseChats)?.id ?? null;
  const nameOfProject = (id: string) => projectList.find((p) => p.id === id)?.name ?? id;
  // What a policy is called in the list and in its buttons: its projects, and the chats without one
  const governed = (policy: RotationPolicy) =>
    [...policy.projects.map(nameOfProject), ...(policy.looseChats ? [t('policies.looseChatsName')] : [])].join(', ');

  const remove = useMutation({
    mutationFn: (policy: RotationPolicy) => api.deleteAccountPolicy(policy.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
      toast.success(t('policies.deleted'));
    },
  });

  return (
    <Card
      title={
        <span className="title-icon">
          <Route {...ICON_SM} /> {t('policies.title')}
        </span>
      }
      actions={
        !draft && (
          <button type="button" className="btn btn-small" onClick={() => setDraft(NEW_POLICY)}>
            <Plus {...ICON_SM} /> {t('policies.new')}
          </button>
        )
      }
    >
      <p className="muted small">{t('policies.intro')}</p>
      <ErrorBox error={remove.error} />
      {draft && <PolicyForm draft={draft} accounts={accounts} projects={projectList} taken={taken} looseTaken={looseTaken} onChange={setDraft} onDone={() => setDraft(null)} />}
      {policies.length === 0 && !draft ? (
        <Empty icon={Route} title={t('policies.none')}>
          {t('policies.noneHint')}
        </Empty>
      ) : (
        <ul className="list">
          {policies.map((policy) => (
            <li key={policy.id} className="list-row list-row-flow">
              <div className="list-row-main">
                <div className="strong break">{governed(policy)}</div>
                <div className="muted small">
                  {t('policies.rotateAt', { pct: policy.threshold })} ·{' '}
                  {policy.order?.length ? t('policies.inOrder', { accounts: policy.order.map((n) => `#${n}`).join(' → ') }) : t('policies.anyAccount')}
                </div>
              </div>
              <span className="row-actions">
                <Tooltip content={t('policies.edit')}>
                  <button
                    type="button"
                    className="btn btn-small"
                    aria-label={t('policies.editNamed', { projects: governed(policy) })}
                    onClick={() => setDraft({ id: policy.id, threshold: policy.threshold, order: policy.order ?? [], projects: policy.projects, looseChats: policy.looseChats === true })}
                  >
                    <Pencil {...ICON_SM} />
                  </button>
                </Tooltip>
                <Tooltip content={t('common:actions.delete')}>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={remove.isPending}
                    aria-label={t('policies.deleteNamed', { projects: governed(policy) })}
                    onClick={() =>
                      void confirm({
                        title: t('policies.deleteTitle'),
                        body: t('policies.deleteBody'),
                        confirmLabel: t('common:actions.delete'),
                        danger: true,
                      }).then((ok) => {
                        if (ok) remove.mutate(policy);
                      })
                    }
                  >
                    <Trash2 {...ICON_SM} />
                  </button>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
