import type { PermissionDecision, PermissionRequest, PermissionUpdate } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, ChevronLeft, ChevronRight, ClipboardList, MessageCircleQuestion, ShieldQuestion, X } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, keys } from '../api';
import { useChatPermissions } from '../lib/chats';
import { ICON_SM } from './icons';
import { RichText } from './Transcript';
import { ErrorBox, TabPanel, Tabs, useTabGroup } from './ui';

/** The shell command, the file, the url — whatever this particular tool is actually about. */
function summarize(request: PermissionRequest): string {
  const input = request.input;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return JSON.stringify(input);
}

/** What accepting a suggestion would remember, in words. */
function describeSuggestion(update: PermissionUpdate): string {
  if (update.type === 'setMode' && typeof update.mode === 'string') return `switch to ${update.mode}`;
  if (update.type === 'addRules' && Array.isArray(update.rules)) {
    const rules = (update.rules as Array<{ toolName?: string; ruleContent?: string }>).map((r) =>
      r.ruleContent ? `${r.toolName ?? ''}(${r.ruleContent})` : (r.toolName ?? ''),
    );
    return `always allow ${rules.join(', ')}`;
  }
  if (update.type === 'addDirectories' && Array.isArray(update.directories)) return `allow ${update.directories.join(', ')}`;
  return update.type;
}

/** One mutation per prompt; answering removes it from the list the panel polls. */
function useAnswer(request: PermissionRequest) {
  const queryClient = useQueryClient();
  return useMutation({
    // `runId` on a request is the chat it belongs to
    mutationFn: (decision: PermissionDecision) => api.answerPermission(request.runId, request.id, decision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.chatPermissions(request.runId) });
      void queryClient.invalidateQueries({ queryKey: keys.chats });
    },
  });
}

/** Deny with a reason the model can read: one it can learn from beats one it can only retry blindly. */
function DenyReason({ value, onChange, disabled, placeholder }: { value: string; onChange: (v: string) => void; disabled: boolean; placeholder: string }) {
  return <input className="permission-reason" aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />;
}

function ToolPrompt({ request }: { request: PermissionRequest }) {
  const answer = useAnswer(request);
  const [reason, setReason] = useState('');
  const suggestions = request.suggestions ?? [];
  const described = request.description ?? request.input.description;
  const description = typeof described === 'string' ? described : '';
  const deny = () => answer.mutate({ behavior: 'deny', ...(reason.trim() ? { message: reason.trim() } : {}) });

  return (
    <li className="permission" aria-live="polite">
      <div className="permission-head">
        <ShieldQuestion {...ICON_SM} aria-hidden />
        <strong>{request.toolName}</strong>
        <span className="muted small">wants to run</span>
      </div>
      {/* Focusable so a long command can be scrolled sideways from the keyboard */}
      <pre className="permission-input" role="group" aria-label="What it wants to run" tabIndex={0}>
        {summarize(request)}
      </pre>
      {description && <p className="muted small">{description}</p>}
      <div className="permission-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={answer.isPending} onClick={() => answer.mutate({ behavior: 'allow' })}>
          <Check {...ICON_SM} /> Allow
        </button>
        {suggestions.length > 0 && (
          <button
            type="button"
            className="btn btn-small"
            disabled={answer.isPending}
            title={suggestions.map(describeSuggestion).join('; ')}
            onClick={() => answer.mutate({ behavior: 'allow', updatedPermissions: suggestions })}
          >
            <CheckCheck {...ICON_SM} /> Allow and {suggestions.map(describeSuggestion).join('; ')}
          </button>
        )}
        <button type="button" className="btn btn-danger btn-small" disabled={answer.isPending} onClick={deny}>
          <X {...ICON_SM} /> Deny
        </button>
        <DenyReason value={reason} onChange={setReason} disabled={answer.isPending} placeholder="Why not? (sent to the model when denying)" />
      </div>
      <ErrorBox error={answer.error} />
    </li>
  );
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
}

/**
 * Arrow keys move through the options of a single-choice question. They only move focus: choosing
 * one advances to the next question, which would take focus away in the middle of the arrowing.
 */
function radioArrows(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
  if (step === 0) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]:not(:disabled)')];
  const at = radios.findIndex((r) => r === document.activeElement);
  const next = radios[(at + step + radios.length) % radios.length];
  if (at < 0 || !next) return;
  event.preventDefault();
  next.focus();
}

/** The question's panel is named by its tab when there are tabs, and is a plain block when there is one question. */
function Panel({ group, tab, tabbed, children }: { group: string; tab: string; tabbed: boolean; children: ReactNode }) {
  return tabbed ? (
    <TabPanel group={group} tab={tab} className="question">
      {children}
    </TabPanel>
  ) : (
    <div className="question">{children}</div>
  );
}

/**
 * `AskUserQuestion`: the CLI waits for the answers inside the tool call itself, so they travel back
 * as the call's input — `answers` maps each question to the chosen labels.
 *
 * One question at a time behind tabs: the model can ask several at once, and laid out together
 * they bury the conversation they are about.
 */
function QuestionPrompt({ request }: { request: PermissionRequest }) {
  const answer = useAnswer(request);
  const group = useTabGroup();
  const questions = (Array.isArray(request.input.questions) ? request.input.questions : []) as Question[];
  const [tab, setTab] = useState('0');
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const index = Math.min(Number(tab), Math.max(questions.length - 1, 0));
  const current = questions[index];
  const valueOf = (q: Question) => [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question]?.trim() ?? ''] : [])];
  const answered = questions.filter((q) => valueOf(q).length > 0).length;
  const complete = questions.length > 0 && answered === questions.length;
  const go = (i: number) => setTab(String(Math.max(0, Math.min(i, questions.length - 1))));

  /** After a single choice, move on to the next question still open; stay put on the last one. */
  const advanceFrom = (i: number, justAnswered: string) => {
    const next = questions.findIndex((q, j) => j > i && q.question !== justAnswered && valueOf(q).length === 0);
    if (next !== -1) go(next);
  };
  const toggle = (q: Question, label: string) => {
    const chosen = picked[q.question] ?? [];
    if (q.multiSelect) {
      setPicked({ ...picked, [q.question]: chosen.includes(label) ? chosen.filter((l) => l !== label) : [...chosen, label] });
      return;
    }
    const off = chosen[0] === label;
    setOther({ ...other, [q.question]: '' });
    setPicked({ ...picked, [q.question]: off ? [] : [label] });
    if (!off) advanceFrom(index, q.question);
  };
  const submit = () =>
    answer.mutate({
      behavior: 'allow',
      updatedInput: { ...request.input, answers: Object.fromEntries(questions.map((q) => [q.question, valueOf(q).join(', ')])) },
    });

  return (
    <li className="permission permission-question" aria-live="polite">
      <div className="permission-head">
        <MessageCircleQuestion {...ICON_SM} aria-hidden />
        <strong>Claude is asking</strong>
        {questions.length > 1 && (
          <span className="muted small">
            {answered} of {questions.length} answered
          </span>
        )}
      </div>
      {questions.length > 1 && (
        <Tabs
          inline
          label="Questions"
          group={group}
          value={String(index)}
          onChange={setTab}
          tabs={questions.map((q, i) => ({
            id: String(i),
            label: (
              <>
                {valueOf(q).length > 0 ? (
                  <>
                    <Check {...ICON_SM} className="text-ok" />
                    <span className="sr-only">answered: </span>
                  </>
                ) : (
                  <span className="question-num">{i + 1}</span>
                )}
                {q.header || `Question ${i + 1}`}
              </>
            ),
          }))}
        />
      )}
      {current && (
        <Panel key={index} group={group} tab={String(index)} tabbed={questions.length > 1}>
          <p className="question-text">
            {current.question}
            {current.multiSelect && <span className="muted small"> · pick any</span>}
          </p>
          <div
            className="question-options"
            role={current.multiSelect ? 'group' : 'radiogroup'}
            aria-label={current.question}
            onKeyDown={current.multiSelect ? undefined : radioArrows}
          >
            {(current.options ?? []).map((o, at) => {
              const on = (picked[current.question] ?? []).includes(o.label);
              // One tab stop for the radios: the chosen one, or the first while none is
              const stop = current.multiSelect || on || ((picked[current.question] ?? []).length === 0 && at === 0);
              return (
                <button
                  key={o.label}
                  type="button"
                  role={current.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  tabIndex={stop ? 0 : -1}
                  className={`question-option ${on ? 'is-on' : ''} ${current.multiSelect ? 'is-multi' : ''}`}
                  disabled={answer.isPending}
                  onClick={() => toggle(current, o.label)}
                >
                  <span className="question-mark" aria-hidden>
                    {on && <Check {...ICON_SM} />}
                  </span>
                  <span className="question-label">
                    <span className="strong">{o.label}</span>
                    {o.description && <span className="muted small">{o.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <input
            className="question-other"
            placeholder="Other answer…"
            aria-label={`Other answer to: ${current.question}`}
            value={other[current.question] ?? ''}
            disabled={answer.isPending}
            onChange={(e) => {
              const value = e.target.value;
              setOther({ ...other, [current.question]: value });
              // A written answer replaces the picked one where only one is allowed
              if (!current.multiSelect && value.trim()) setPicked({ ...picked, [current.question]: [] });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valueOf(current).length) {
                e.preventDefault();
                if (complete) submit();
                else advanceFrom(index, current.question);
              }
            }}
          />
        </Panel>
      )}
      {declining ? (
        <div className="permission-actions">
          <DenyReason value={reason} onChange={setReason} disabled={answer.isPending} placeholder="Why not? (optional, sent to the model)" />
          <button
            type="button"
            className="btn btn-danger btn-small"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ behavior: 'deny', message: reason.trim() || 'The user declined to answer' })}
          >
            <X {...ICON_SM} /> Decline
          </button>
          <button type="button" className="btn btn-small" disabled={answer.isPending} onClick={() => setDeclining(false)}>
            Back to the questions
          </button>
        </div>
      ) : (
        <div className="permission-actions question-footer">
          {questions.length > 1 && (
            <>
              <button type="button" className="btn btn-small" disabled={index === 0} onClick={() => go(index - 1)}>
                <ChevronLeft {...ICON_SM} /> Previous
              </button>
              <button type="button" className="btn btn-small" disabled={index === questions.length - 1} onClick={() => go(index + 1)}>
                Next <ChevronRight {...ICON_SM} />
              </button>
            </>
          )}
          <span className="question-spacer" />
          <button type="button" className="btn btn-small" disabled={answer.isPending} onClick={() => setDeclining(true)}>
            <X {...ICON_SM} /> Decline
          </button>
          <button type="button" className="btn btn-primary btn-small" disabled={!complete || answer.isPending} onClick={submit}>
            <Check {...ICON_SM} /> {complete || questions.length === 1 ? 'Answer' : `Answer (${answered}/${questions.length})`}
          </button>
        </div>
      )}
      <ErrorBox error={answer.error} />
    </li>
  );
}

/** `ExitPlanMode`: approving lets the model start working; rejecting keeps it planning, with feedback. */
function PlanPrompt({ request }: { request: PermissionRequest }) {
  const answer = useAnswer(request);
  const [feedback, setFeedback] = useState('');
  const plan = typeof request.input.plan === 'string' ? request.input.plan : summarize(request);

  return (
    <li className="permission permission-plan" aria-live="polite">
      <div className="permission-head">
        <ClipboardList {...ICON_SM} aria-hidden />
        <strong>Plan ready for review</strong>
      </div>
      <div className="permission-plan-body" role="group" aria-label="Plan" tabIndex={0}>
        <RichText text={plan} />
      </div>
      <div className="permission-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={answer.isPending} onClick={() => answer.mutate({ behavior: 'allow' })}>
          <Check {...ICON_SM} /> Approve
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={answer.isPending}
          title="Approve and let it edit files without asking for the rest of the session"
          onClick={() => answer.mutate({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] })}
        >
          <CheckCheck {...ICON_SM} /> Approve and accept edits
        </button>
        <button
          type="button"
          className="btn btn-danger btn-small"
          disabled={answer.isPending}
          onClick={() => answer.mutate({ behavior: 'deny', message: feedback.trim() || 'The user wants to keep planning' })}
        >
          <X {...ICON_SM} /> Keep planning
        </button>
        <DenyReason value={feedback} onChange={setFeedback} disabled={answer.isPending} placeholder="What should change? (sent to the model)" />
      </div>
      <ErrorBox error={answer.error} />
    </li>
  );
}

function Prompt({ request }: { request: PermissionRequest }) {
  if (request.toolName === 'AskUserQuestion') return <QuestionPrompt request={request} />;
  if (request.toolName === 'ExitPlanMode') return <PlanPrompt request={request} />;
  return <ToolPrompt request={request} />;
}

/**
 * What the chat is holding until someone decides: tool calls, questions, plans. Fetched rather than
 * pushed: a request that arrives while the page is closed must still be waiting when it opens. The
 * event feed says when the list changes; a slow poll only covers the feed being down.
 */
export function PermissionPrompts({ chatId, live }: { chatId: string; live: boolean }) {
  const { data } = useChatPermissions(chatId, live);
  if (!data?.length) return null;
  return (
    <section className="permission-list" aria-label="Waiting for you">
      <ul>
        {data.map((request) => (
          <Prompt key={request.id} request={request} />
        ))}
      </ul>
    </section>
  );
}
