import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@agentry/ui/components/icons';
import { addLabel } from '../item/model';

/** The dialog's labels: a removable chip per label and an input that adds on Enter, a comma or blur. */
export function LabelsInput({
  labels,
  onChange,
  labelDraft,
  setLabelDraft,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
  labelDraft: string;
  setLabelDraft: (value: string) => void;
}) {
  const { t } = useTranslation('workItem');
  return (
    <div className="newtask-labels">
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          className="workitem-label workitem-label-remove"
          aria-label={t('fields.removeLabel', { label })}
          onClick={() => onChange(labels.filter((l) => l !== label))}
        >
          {label}
          <X size={10} strokeWidth={2} aria-hidden />
        </button>
      ))}
      <input
        value={labelDraft}
        aria-label={t('fields.addLabel')}
        placeholder={t('newTask.labelsPlaceholder')}
        onChange={(e) => setLabelDraft(e.target.value)}
        onBlur={() => {
          onChange(addLabel(labels, labelDraft));
          setLabelDraft('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            onChange(addLabel(labels, labelDraft));
            setLabelDraft('');
          } else if (e.key === 'Backspace' && !labelDraft && labels.length) onChange(labels.slice(0, -1));
        }}
      />
    </div>
  );
}

/** One acceptance criterion's input; Enter adds the next one. */
export function CriterionInput({
  criteria,
  index,
  className,
  onChange,
}: {
  criteria: string[];
  index: number;
  className?: string;
  onChange: (criteria: string[]) => void;
}) {
  const { t } = useTranslation('workItem');
  const value = criteria[index] ?? '';
  return (
    <input
      className={className}
      value={value}
      autoFocus={index === criteria.length - 1 && value === ''}
      aria-label={t('criteria.nth', { n: index + 1 })}
      onChange={(e) => onChange(criteria.map((c, i) => (i === index ? e.target.value : c)))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onChange([...criteria, '']);
        }
      }}
    />
  );
}

export function RemoveCriterion({ criteria, index, onChange }: { criteria: string[]; index: number; onChange: (criteria: string[]) => void }) {
  const { t } = useTranslation('workItem');
  return (
    <button type="button" className="icon-btn" aria-label={t('criteria.removeNth', { n: index + 1 })} onClick={() => onChange(criteria.filter((_, i) => i !== index))}>
      <X {...ICON_SM} />
    </button>
  );
}
