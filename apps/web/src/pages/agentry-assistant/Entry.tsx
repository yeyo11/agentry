import { useMutation } from '@tanstack/react-query';
import { ArrowUp, FolderGit2, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, useOverview } from '../../api';
import { AssistantMark } from '../../components/assistant/run';
import { ModelPicker } from '../../components/ModelPicker';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { useUsageNow } from '../../lib/usage-now';
import { useProjectScope } from '../../lib/project-scope';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { ErrorBox, usePageTitle } from '@agentry/ui/components/ui';
import { formatCost } from '@agentry/ui/lib/format';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { STARTERS } from './model';

/** The model a chat of the assistant starts with unless the person picks another (the core's default too) */
const DEFAULT_MODEL = 'sonnet';

/**
 * `/assistant`: the greeting, what the assistant can do as suggestions, and the box to ask in.
 * The project in scope is context and not a requirement: the chip clears it before the first
 * prompt. Starting creates the chat in the core, confined there, and opens it.
 */
export function AgentryAssistant() {
  const { t } = useTranslation('assistant');
  const navigate = useNavigate();
  const narrow = useMediaQuery(NARROW);
  const { project } = useProjectScope();
  const [dropped, setDropped] = useState(false);
  const context = dropped ? null : project;
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const box = useRef<HTMLTextAreaElement>(null);
  usePageTitle(t('agentry.title'));

  const start = useMutation({
    mutationFn: () => api.startAgentryAssistantChat({ prompt: prompt.trim(), projectId: context?.id ?? null, model }),
    onSuccess: (chat) => navigate(`/chats/${chat.id}`),
  });
  const ready = prompt.trim().length > 0 && !start.isPending;
  const send = () => {
    if (ready) start.mutate();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  // The box grows with what is typed, as the chat's does
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [prompt]);

  return (
    <div className="run-layout as-entry">
      <section className="run-main" aria-label={t('agentry.title')}>
        {narrow && <PhoneHeader title={t('agentry.title')} back={{ fallback: '/' }} />}
        <div className="run-stage">
          <div className="run-scroll as-scroll glow-top" data-scroll-root>
            <div className="as-body">
              <Hello />
              <section className="as-starters-section" aria-labelledby="as-starters-label">
                <h2 id="as-starters-label" className="section-label">
                  {t('agentry.starters')}
                </h2>
                <div className="as-starters">
                  {STARTERS.map(({ key, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className="as-starter"
                      onClick={() => {
                        setPrompt(t(`agentry.starter.${key}.ask`));
                        box.current?.focus();
                      }}
                    >
                      <Icon {...ICON} aria-hidden />
                      <span className="as-starter-body">
                        <span className="as-starter-title">{t(`agentry.starter.${key}.title`)}</span>
                        <span className="as-starter-ask">{t(`agentry.starter.${key}.ask`)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
        <div className="composer-wrap as-composer">
          <ErrorBox error={start.error} title={t('agentry.startError')} />
          <form className="composer" aria-label={t('agentry.message')} onSubmit={submit}>
            <textarea
              ref={box}
              autoFocus={!narrow}
              rows={1}
              aria-label={t('agentry.message')}
              placeholder={narrow ? t('agentry.placeholderShort') : t('agentry.placeholder')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" className="composer-send" aria-label={start.isPending ? t('agentry.starting') : t('agentry.send')} disabled={!ready}>
              <ArrowUp {...ICON_SM} />
            </button>
          </form>
          <div className="as-composer-foot">
            {context && (
              <span className="chip as-context">
                <FolderGit2 {...ICON_SM} aria-hidden />
                <span className="ellipsis">{t('agentry.context', { name: context.name })}</span>
                <button type="button" className="x" aria-label={t('agentry.clearContext')} onClick={() => setDropped(true)}>
                  <X {...ICON_SM} aria-hidden />
                </button>
              </span>
            )}
            <ModelPicker value={model} onChange={setModel} aria-label={t('agentry.model')} />
          </div>
        </div>
      </section>
    </div>
  );
}

/** The greeting block: the mark, the line, and the live figures, which are only what the shell already reads */
function Hello() {
  const { t } = useTranslation('assistant');
  const counts = useOverview().data?.counts;
  const { todayCost } = useUsageNow();
  const chats = counts?.chatsWorking ?? 0;
  const orchestrations = counts?.orchestrationsRunning ?? 0;
  const figures: Array<{ live: boolean; text: string }> = [];
  if (chats > 0) figures.push({ live: true, text: t('agentry.chatsWorking', { count: chats, n: chats }) });
  if (orchestrations > 0) figures.push({ live: true, text: t('agentry.orchestrations', { count: orchestrations, n: orchestrations }) });
  if (todayCost != null) figures.push({ live: false, text: t('agentry.today', { cost: formatCost(todayCost) }) });
  return (
    <div className="as-hello">
      <AssistantMark />
      <h1 className="as-hello-title">{t('agentry.hello')}</h1>
      <p className="as-hello-sub">{t('agentry.sub')}</p>
      {figures.length > 0 && (
        <p className="as-figures" aria-label={t('agentry.figures')}>
          {figures.map((figure) => (
            <span key={figure.text} className={figure.live ? 'live' : undefined}>
              {figure.text}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
