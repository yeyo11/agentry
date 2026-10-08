import type { DocumentKind } from '@agentry/shared';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useDocuments } from '../../../api';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Skeleton } from '@agentry/ui/components/ui';
import { formatNumber, timeAgo } from '@agentry/ui/lib/format';
import { mainTie } from '../../documents/model';
import { useRoleName } from '../../team/RoleAvatar';
import { configCount } from '../layout';
import { documentFolder, recentDocuments } from '../model';
import type { WidgetProps } from '../registry';
import { WidgetCard } from '../WidgetCard';

/** How many documents a size shows; a layout's `limit` overrides it. */
const ROWS = { s: 3, m: 4, l: 6, full: 8 } as const;

/**
 * The project's most recently modified documents: the file, where it sits and who wrote it, its kind
 * and its age. It exists only while the Documents module is on, and says so briefly when the folder
 * holds nothing: a widget beside other content gets a line, not an illustration.
 */
export function DocumentsWidget({ project, size, config, title, id }: WidgetProps) {
  const { t } = useTranslation(['home', 'documents']);
  const roleName = useRoleName();
  const on = !!project?.modules.includes('documents');
  const documents = useDocuments(on && project ? project.id : null);
  if (!project || !on) return null;
  const tree = documents.data;
  const rows = tree ? recentDocuments(tree.tree, configCount(config, 'limit', ROWS[size])) : [];
  const fileCount = tree?.fileCount ?? 0;
  return (
    <WidgetCard
      id={id}
      title={title}
      icon={<FileText {...ICON} className="widget-icon" />}
      aside={fileCount > 0 ? <span className="count">{formatNumber(fileCount)}</span> : undefined}
      actions={
        <Link to="/?view=documents" className="link-more">
          {t('widgets.documents.all')}
        </Link>
      }
    >
      {documents.isLoading ? (
        <Skeleton rows={3} height={14} />
      ) : rows.length === 0 ? (
        <p className="muted small">{t('widgets.documents.empty')}</p>
      ) : (
        <ul className="widget-rows">
          {rows.map((file) => {
            const tie = mainTie(file.ties);
            const kind: DocumentKind = tie?.kind ?? 'doc';
            const folder = documentFolder(file.path);
            const author = tie?.teamRole ? roleName(tie.teamRole) : t('widgets.documents.you');
            return (
              <li key={file.path}>
                <Link to={`/?view=documents&doc=${encodeURIComponent(file.path)}`} className="doc-row widget-link">
                  <FileText {...ICON_SM} className="doc-row-icon" />
                  <span className="doc-row-text">
                    <span className="doc-name ellipsis">{file.name}</span>
                    <span className="small muted mono ellipsis">{folder ? `${folder} · ${author}` : author}</span>
                  </span>
                  <span className="badge">{t(`documents:kinds.${kind}.tag`)}</span>
                  <span className="small muted doc-row-age">{timeAgo(file.updatedAt)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {tree && fileCount > 0 && (
        <div className="widget-foot">
          <span>{t('widgets.documents.count', { count: fileCount, n: formatNumber(fileCount) })}</span>
          <span className="grow" />
          <span>{t('widgets.documents.tied', { count: tree.tiedCount, n: formatNumber(tree.tiedCount) })}</span>
        </div>
      )}
    </WidgetCard>
  );
}
