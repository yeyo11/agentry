import type { Orchestration, VerificationStatus } from '@agentry/shared';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatDuration } from '../lib/format';
import { CodeBlock } from './CodeBlock';
import { Collapsible } from './controls';
import { ICON_SM } from './icons';
import { Card, StatusBadge, Tag } from './ui';

/** Passed and fixed are both good news but not the same news, so each says its own word. */
function VerificationBadge({ status }: { status: VerificationStatus }) {
  const { t } = useTranslation('orchestrationV2');
  if (status === 'passed' || status === 'fixed') return <Tag tone="ok">{t(`verification.status.${status}`)}</Tag>;
  // running, pending and failed have a shape and a word of their own already
  return <StatusBadge status={status} />;
}

/**
 * What the checks on the integration branch did. It sits before the pull request is offered on
 * purpose: this is what a person should read first.
 */
export function VerificationCard({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('orchestrationV2');
  const state = orch.verification;
  if (!state) return null;

  return (
    <Card
      title={
        <span className="title-icon">
          <ShieldCheck {...ICON_SM} /> {t('verification.title')}
        </span>
      }
      actions={<VerificationBadge status={state.status} />}
    >
      <p className="small" role="status">
        {t(`verification.summary.${state.status}`)}
        {state.attempts > 0 && ` ${t('verification.attemptsSpent', { count: state.attempts })}`}
      </p>
      {state.report && <p className="small break">{state.report}</p>}

      <ul className="list">
        {state.commands.map((command) => (
          <li key={command.command} className="stack-tight">
            <div className="list-row list-row-flow small">
              <VerificationBadge status={command.status} />
              <code className="mono break">{command.command}</code>
              {command.durationMs > 0 && <span className="muted nowrap">{formatDuration(command.durationMs)}</span>}
            </div>
            {command.output && (
              <Collapsible className="fold" title={t('verification.output')}>
                <CodeBlock code={command.output} tone={command.status === 'failed' ? 'error' : undefined} />
              </Collapsible>
            )}
          </li>
        ))}
      </ul>

      {state.commits.length > 0 && (
        <div className="stack-tight">
          <div className="strong small">{t('verification.commits', { count: state.commits.length })}</div>
          <ul className="list">
            {state.commits.map((commit) => (
              <li key={commit.hash} className="list-row list-row-flow small">
                <span className="mono">{commit.hash.slice(0, 8)}</span>
                <span className="break">{commit.subject}</span>
                <span className="muted nowrap">{formatDateTime(commit.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
