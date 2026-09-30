import type { DocumentNode } from '@agentry/shared';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@agentry/ui/components/icons';
import { formatNumber } from '@agentry/ui/lib/format';

/**
 * The documents folder as a tree (`.tree-row` of editors.css): folders open and close, the open
 * file carries the accent inset. `open` holds the folders shown open; a filter opens every folder
 * on the way to a match, which the caller does by passing them all.
 */
export function DocumentTree({
  nodes,
  root,
  rootCount,
  selected,
  open,
  onToggle,
  onOpen,
}: {
  nodes: readonly DocumentNode[];
  /** The documents folder, drawn as the first row (`docs/`) */
  root: string;
  rootCount: number;
  selected: string | null;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation('documents');
  const rootOpen = open.has(root);
  return (
    <ul className="tree-group doc-tree" role="tree" aria-label={t('tree.label')}>
      <li role="treeitem" aria-expanded={rootOpen} aria-selected={false}>
        <div className="tree-line">
          <button type="button" className="tree-row" style={{ '--depth': 0 } as CSSProperties} onClick={() => onToggle(root)}>
            <ChevronRight {...ICON_SM} className={`tree-chevron ${rootOpen ? 'is-open' : ''}`.trim()} />
            <Folder {...ICON_SM} className="tree-icon" />
            <span className="tree-name is-dir">{root}/</span>
            <span className="tree-size mono tnum">{formatNumber(rootCount)}</span>
          </button>
        </div>
        {rootOpen && <Branch nodes={nodes} depth={1} selected={selected} open={open} onToggle={onToggle} onOpen={onOpen} />}
      </li>
    </ul>
  );
}

function Branch({
  nodes,
  depth,
  selected,
  open,
  onToggle,
  onOpen,
}: {
  nodes: readonly DocumentNode[];
  depth: number;
  selected: string | null;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="tree-group" role="group">
      {nodes.map((node) => {
        const style = { '--depth': depth } as CSSProperties;
        if (node.type === 'dir') {
          const isOpen = open.has(node.path);
          return (
            <li key={node.path} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
              <div className="tree-line">
                <button type="button" className="tree-row" style={style} onClick={() => onToggle(node.path)}>
                  <ChevronRight {...ICON_SM} className={`tree-chevron ${isOpen ? 'is-open' : ''}`.trim()} />
                  <Folder {...ICON_SM} className="tree-icon" />
                  <span className="tree-name is-dir">{node.name}/</span>
                  <span className="tree-size mono tnum">{formatNumber(node.fileCount ?? 0)}</span>
                </button>
              </div>
              {isOpen && <Branch nodes={node.children ?? []} depth={depth + 1} selected={selected} open={open} onToggle={onToggle} onOpen={onOpen} />}
            </li>
          );
        }
        const on = node.path === selected;
        return (
          <li key={node.path} role="treeitem" aria-selected={on}>
            <div className="tree-line">
              <button
                type="button"
                className={`tree-row ${on ? 'tree-row-on' : ''}`.trim()}
                style={style}
                aria-current={on ? 'true' : undefined}
                title={node.title ?? undefined}
                onClick={() => onOpen(node.path)}
              >
                <span className="tree-spacer" aria-hidden />
                <FileText {...ICON_SM} className="tree-icon" />
                <span className="tree-name">{node.name}</span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
