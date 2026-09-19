import { Eye, EyeOff, X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Tooltip } from './controls/Tooltip';
import { ICON_SM } from './icons';

/** Chip list with an "add" input: permission rules, args, directories… */
export function StringListEditor({
  values,
  onChange,
  placeholder,
  addLabel = 'Add',
  mono = true,
  allowDuplicates = false,
  emptyText = 'None',
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  mono?: boolean;
  allowDuplicates?: boolean;
  emptyText?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (allowDuplicates || !values.includes(value)) onChange([...values, value]);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    } else if (event.key === 'Backspace' && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="list-editor">
      <div className="chips">
        {values.length === 0 && <span className="small muted">{emptyText}</span>}
        {values.map((value, index) => (
          <span key={`${value}-${index}`} className={`chip chip-static ${mono ? 'mono' : ''}`} title={value}>
            <span className="ellipsis">{value}</span>
            <button
              type="button"
              className="chip-x"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <div className="list-editor-add">
        <input
          className={mono ? 'mono' : ''}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="btn btn-small" disabled={!draft.trim()} onClick={add}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

export interface KeyValueRow {
  key: string;
  value: string;
}

export function recordToRows(record: unknown): KeyValueRow[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.entries(record as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

export function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) if (row.key.trim()) record[row.key.trim()] = row.value;
  return record;
}

/** Key/value table (env vars, HTTP headers). Values can be masked because they are often secrets. */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value',
  maskValues = false,
  addLabel = 'Add variable',
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  maskValues?: boolean;
  addLabel?: string;
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const update = (index: number, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const duplicates = new Set(rows.map((r) => r.key.trim()).filter((k, i, all) => k && all.indexOf(k) !== i));

  return (
    <div className="kv-editor">
      {rows.map((row, index) => {
        const shown = !maskValues || revealed.has(index);
        return (
          <div key={index} className="kv-editor-row">
            <Tooltip content={duplicates.has(row.key.trim()) && 'Duplicate name: the last one wins'}>
              <input
                className={`mono ${duplicates.has(row.key.trim()) ? 'is-invalid' : ''}`}
                value={row.key}
                placeholder={keyPlaceholder}
                aria-label="Name"
                onChange={(e) => update(index, { key: e.target.value })}
              />
            </Tooltip>
            <input
              className="mono"
              type={shown ? 'text' : 'password'}
              autoComplete="off"
              value={row.value}
              placeholder={valuePlaceholder}
              aria-label="Value"
              onChange={(e) => update(index, { value: e.target.value })}
            />
            {maskValues && (
              <Tooltip content={shown ? 'Hide value' : 'Reveal value'}>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={shown ? 'Hide value' : 'Reveal value'}
                  onClick={() =>
                    setRevealed((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    })
                  }
                >
                  {shown ? <EyeOff {...ICON_SM} /> : <Eye {...ICON_SM} />}
                </button>
              </Tooltip>
            )}
            <Tooltip content="Remove">
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${row.key || 'row'}`}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <X {...ICON_SM} />
              </button>
            </Tooltip>
          </div>
        );
      })}
      <div>
        <button type="button" className="btn btn-small" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          + {addLabel}
        </button>
      </div>
    </div>
  );
}
