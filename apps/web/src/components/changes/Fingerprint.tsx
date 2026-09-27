import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

// The change fingerprint (design system §5): one segment per file, as wide as its churn, added
// then removed. The current file is ringed and the seen ones fade; each segment opens its file.

export interface PrintFile {
  path: string;
  additions: number;
  deletions: number;
}

export function Fingerprint({
  files,
  current = null,
  seen,
  to,
  className,
}: {
  files: PrintFile[];
  current?: string | null;
  seen?: ReadonlySet<string>;
  /** Where a segment leads: the review screen on that file */
  to: (path: string) => string;
  className?: string;
}) {
  const { t } = useTranslation('components');
  return (
    <nav className={['changes-print', className].filter(Boolean).join(' ')} aria-label={t('diff.fingerprint')}>
      {files.map((f) => {
        const churn = f.additions + f.deletions;
        const added = churn > 0 ? Math.round((f.additions / churn) * 100) : 50;
        const isSeen = seen?.has(f.path) ?? false;
        const values = { path: f.path, additions: f.additions, deletions: f.deletions };
        return (
          <Link
            key={f.path}
            to={to(f.path)}
            className={`changes-print-seg${f.path === current ? ' is-current' : ''}${isSeen ? ' is-seen' : ''}`}
            style={{ flex: `${Math.max(churn, 1)} 1 0`, '--a': `${added}%` } as CSSProperties}
            aria-label={isSeen ? t('diff.fingerprintFileSeen', values) : t('diff.fingerprintFile', values)}
            aria-current={f.path === current ? 'true' : undefined}
          />
        );
      })}
    </nav>
  );
}
