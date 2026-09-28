import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useWidth } from '../../lib/use-width';
import { printSegments } from './review-model';

// The change fingerprint (design system §5): one segment per file, as wide as its churn, added
// then removed. The current file is ringed and the seen ones fade; each segment opens its file.
// Past what the strip's width holds, the smallest files share one neutral segment at the end.

export interface PrintFile {
  path: string;
  additions: number;
  deletions: number;
}

/** Before the strip is measured it draws every file, so nothing folds and unfolds on first paint */
const UNMEASURED = 100_000;

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
  const [ref, width] = useWidth<HTMLElement>(0, UNMEASURED);
  const { shown, rest } = printSegments(files, width);
  const first = rest[0];
  const restChurn = rest.reduce((n, f) => n + f.additions + f.deletions, 0);
  const restCurrent = current !== null && rest.some((f) => f.path === current);
  return (
    <nav ref={ref} className={['changes-print', className].filter(Boolean).join(' ')} aria-label={t('diff.fingerprint')}>
      {shown.map((f) => {
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
      {first && (
        <Link
          to={to(first.path)}
          className={`changes-print-seg changes-print-rest${restCurrent ? ' is-current' : ''}`}
          style={{ flex: `${Math.max(restChurn, 1)} 1 0` } as CSSProperties}
          aria-label={t('diff.fingerprintMore', { count: rest.length })}
          aria-current={restCurrent ? 'true' : undefined}
        />
      )}
    </nav>
  );
}
