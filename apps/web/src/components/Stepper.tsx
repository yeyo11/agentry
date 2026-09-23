import { Ban, Check, Circle, Hand, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { StepState } from '../lib/progress';
import { Spinner } from './Spinner';

export interface StepItem {
  id: string;
  label: ReactNode;
  state: StepState;
  /** A second line under the label: "2/2", "web-chats-tools", a duration */
  meta?: ReactNode;
}

/* A step's state is said with a shape and a word as well as a colour: `current` is the only one
   that gets the spinner, because it is the only one still happening. */
const STEP_ICON: Record<StepState, LucideIcon | null> = {
  done: Check,
  current: null,
  waiting: Hand,
  failed: TriangleAlert,
  skipped: Ban,
  pending: Circle,
};

/**
 * The stages of something long, in order. Horizontal while its container is wide and a vertical
 * timeline when it is not (a container query, so it follows the box it is in and not the window).
 * With `onSelect` the steps are buttons; without it they are a list of what happened.
 */
export function Stepper({
  steps,
  label,
  selected,
  onSelect,
  compact = false,
  expanded,
  className = '',
}: {
  steps: readonly StepItem[];
  /** Names the list for a screen reader: "Stages of this orchestration" */
  label: string;
  selected?: string;
  onSelect?: (id: string) => void;
  /** The tighter form for a widget: no meta line, smaller markers */
  compact?: boolean;
  /**
   * Shown inside the selected step, under it: what a timeline on a phone opens in place, so only
   * the step being looked at is expanded. Meant for the vertical form; a wide stepper puts its
   * panel after the whole row instead.
   */
  expanded?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  return (
    <div className={`stepper ${compact ? 'is-compact' : ''} ${className}`.trim()}>
      <ol className="stepper-list" aria-label={label}>
        {steps.map((step) => {
          const Icon = STEP_ICON[step.state];
          const state = t(`step.${step.state}`);
          const body = (
            <>
              <span className="step-marker" aria-hidden>
                {Icon ? <Icon size={12} strokeWidth={2.25} /> : <Spinner />}
              </span>
              <span className="step-text">
                <span className="step-label">{step.label}</span>
                {!compact && step.meta !== undefined && <span className="step-meta">{step.meta}</span>}
              </span>
              <span className="sr-only">{state}</span>
            </>
          );
          const classes = `step is-${step.state} ${selected === step.id ? 'is-selected' : ''}`.trim();
          return (
            <li key={step.id} className="step-item">
              {onSelect ? (
                <button type="button" className={classes} aria-current={selected === step.id ? 'step' : undefined} onClick={() => onSelect(step.id)}>
                  {body}
                </button>
              ) : (
                <span className={classes} aria-current={selected === step.id ? 'step' : undefined}>
                  {body}
                </span>
              )}
              {expanded !== undefined && selected === step.id && <div className="step-expanded">{expanded}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
