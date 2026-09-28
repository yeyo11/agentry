import type { DocumentNode, Project } from '@agentry/shared';
import { ChevronLeft, ChevronRight, FileText, Folder, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useDocuments } from '../../api';
import { ICON, ICON_SM } from '../../components/icons';
import { Empty, ErrorBox, Skeleton } from '../../components/ui';
import { useLeaveGuard } from '../../lib/dirty';
import { formatNumber } from '../../lib/format';
import { NARROW, useMediaQuery } from '../../lib/media';
import { queryView } from '../../lib/query-view';
import { ancestorsOf, baseName, filterTree, findFile, mainTie, tiedDocuments } from './model';
import { DocumentPane, type PaneMode } from './Pane';
import { NewDocumentDialog, NewDocumentCard, TiedList } from './Tied';
import { DocumentTree } from './DocumentTree';

/** What the address holds of the tab: the open file, whether it is being edited, a phone's folder. */
function useDocumentsAddress() {
  const [params, setParams] = useSearchParams();
  const guard = useLeaveGuard();
  const path = params.get('doc');
  const mode: PaneMode = params.get('mode') === 'edit' && path ? 'edit' : 'view';
  const dir = params.get('dir');
  const go = (next: { doc?: string | null; mode?: PaneMode; dir?: string | null }, check = true) =>
    void (check ? guard() : Promise.resolve(true)).then((ok) => {
      if (!ok) return;
      setParams(
        (current) => {
          const query = new URLSearchParams(current);
          const set = (name: string, value: string | null | undefined) => (value ? query.set(name, value) : query.delete(name));
          if ('doc' in next) set('doc', next.doc);
          if ('mode' in next) set('mode', next.mode === 'edit' ? 'edit' : null);
          if ('dir' in next) set('dir', next.dir);
          return query;
        },
        { replace: false },
      );
    });
  return { path, mode, dir, go };
}

/** Where the documents folder is set: the project's settings. */
function settingsHref(params: URLSearchParams): string {
  const next = new URLSearchParams();
  const project = params.get('project');
  if (project) next.set('project', project);
  next.set('view', 'settings');
  return `/?${next.toString()}`;
}

/**
 * The Documents tab (decision 34): the repository's documents folder, read and edited in place,
 * and the documents tied to work items, most of them written by a team member during the flow. A
 * desktop draws the tree, the open document and the tied list side by side; a phone makes each a
 * screen of its own.
 */
export function ProjectDocuments({ project }: { project: Project }) {
  const narrow = useMediaQuery(NARROW);
  const { t } = useTranslation('documents');
  const docs = useDocuments(project.id);
  const address = useDocumentsAddress();
  const [creating, setCreating] = useState<'blank' | 'item' | null>(null);
  const data = docs.data;
  const tied = useMemo(() => tiedDocuments(data?.tree ?? []), [data]);

  // Only a tree that never arrived is an error: a failed refetch keeps the open document, and its edit
  const view = queryView(docs);
  if (view === 'loading') return <Skeleton rows={6} height={18} />;
  if (view !== 'shown' || !data) return <ErrorBox error={docs.error} title={t('loadFailed')} />;

  const dialog = creating && (
    <NewDocumentDialog
      project={project}
      root={data.root}
      from={creating}
      onClose={() => setCreating(null)}
      onCreated={(path) => {
        setCreating(null);
        address.go({ doc: path, mode: 'edit', dir: null }, false);
      }}
    />
  );

  if (data.fileCount === 0 && !address.path) {
    return (
      <>
        <Empty
          illustration="not-found"
          title={data.exists ? t('empty.title', { root: data.root }) : t('empty.missing', { root: data.root })}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreating('blank')}>
              {t('empty.write')}
            </button>
          }
        >
          {t('empty.hint')}
        </Empty>
        {dialog}
      </>
    );
  }

  return (
    <>
      {narrow ? (
        <PhoneDocuments project={project} tree={data.tree} root={data.root} fileCount={data.fileCount} tied={tied} address={address} />
      ) : (
        <DesktopDocuments project={project} tree={data.tree} root={data.root} fileCount={data.fileCount} tied={tied} address={address} onNew={setCreating} />
      )}
      {dialog}
    </>
  );
}

type Address = ReturnType<typeof useDocumentsAddress>;

interface LayoutProps {
  project: Project;
  tree: DocumentNode[];
  root: string;
  fileCount: number;
  tied: ReturnType<typeof tiedDocuments>;
  address: Address;
}

function DesktopDocuments({ project, tree, root, fileCount, tied, address, onNew }: LayoutProps & { onNew: (from: 'blank' | 'item') => void }) {
  const { t } = useTranslation('documents');
  const [params] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const shown = useMemo(() => filterTree(tree, filter), [tree, filter]);

  // Open by default: the root and the folders on the way to the open file; a click flips one
  const open = useMemo(() => {
    const base = new Set<string>([root, ...(address.path ? ancestorsOf(address.path) : [])]);
    for (const path of toggled) {
      if (base.has(path)) base.delete(path);
      else base.add(path);
    }
    if (filter.trim()) {
      const every = (nodes: readonly DocumentNode[]) => {
        for (const node of nodes) {
          if (node.type === 'dir') {
            base.add(node.path);
            every(node.children ?? []);
          }
        }
      };
      base.add(root);
      every(shown);
    }
    return base;
  }, [root, address.path, toggled, filter, shown]);

  const toggle = (path: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="doc-layout">
      <section className="card doc-tree-card" aria-label={t('tree.label')}>
        <label className="doc-filter">
          <Search {...ICON_SM} />
          <input type="search" value={filter} placeholder={t('tree.filter')} aria-label={t('tree.filter')} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <div className="doc-tree-scroll">
          {shown.length === 0 && filter.trim() ? (
            <p className="small muted doc-card-note">{t('tree.noMatch')}</p>
          ) : (
            <DocumentTree
              nodes={shown}
              root={root}
              rootCount={fileCount}
              selected={address.path}
              open={open}
              onToggle={toggle}
              onOpen={(path) => address.go({ doc: path, mode: 'view' })}
            />
          )}
        </div>
        <div className="doc-tree-foot">
          <span className="mono small muted doc-fill">{root}/</span>
          <Link to={settingsHref(params)} className="link-btn small">
            {t('tree.change')}
          </Link>
        </div>
      </section>
      <section className="card doc-pane" aria-label={address.path ?? t('pane.none')}>
        {address.path ? (
          <DocumentPane
            key={address.path}
            project={project}
            path={address.path}
            mode={address.mode}
            onMode={(mode) => address.go({ mode }, mode === 'view')}
            onClosed={() => address.go({ doc: null, mode: 'view' }, false)}
          />
        ) : (
          <div className="doc-pane-body">
            <Empty icon={FileText} title={t('pane.none')}>
              {t('pane.noneHint')}
            </Empty>
          </div>
        )}
      </section>
      <div className="doc-aside">
        <TiedList docs={tied} selected={address.path} onOpen={(path) => address.go({ doc: path, mode: 'view' })} />
        <NewDocumentCard onNew={onNew} />
      </div>
    </div>
  );
}

/** The nodes of the folder a phone is in: the root, or a folder it opened. */
function nodesAt(tree: readonly DocumentNode[], dir: string | null): DocumentNode[] | null {
  if (!dir) return [...tree];
  for (const node of tree) {
    if (node.type !== 'dir') continue;
    if (node.path === dir) return node.children ?? [];
    if (dir.startsWith(`${node.path}/`)) return nodesAt(node.children ?? [], dir);
  }
  return null;
}

function PhoneDocuments({ project, tree, root, fileCount, tied, address }: LayoutProps) {
  const { t } = useTranslation('documents');
  const [filter, setFilter] = useState('');

  if (address.path) {
    const file = findFile(tree, address.path);
    const tie = file ? mainTie(file.ties) : null;
    const heading = tie ? t(`kinds.${tie.kind}.name`) : (file?.title ?? baseName(address.path));
    return (
      <div className="doc-phone">
        <DocumentPane
          key={address.path}
          project={project}
          path={address.path}
          mode={address.mode}
          onMode={(mode) => address.go({ mode }, mode === 'view')}
          onClosed={() => address.go({ doc: null, mode: 'view' }, false)}
          onCancel={() => address.go({ mode: 'view' })}
          phone
          phoneHead={{ title: heading, backLabel: t('phone.back'), fallback: `/?project=${encodeURIComponent(project.id)}&view=documents` }}
        />
      </div>
    );
  }

  const q = filter.trim();
  const nodes = q ? filterTree(tree, q) : (nodesAt(tree, address.dir) ?? tree);
  // A search lists matching files flat, wherever they are
  const rows = q ? flatFiles(nodes) : nodes;
  const here = q ? null : address.dir;
  const count = here ? (findDir(tree, here)?.fileCount ?? 0) : fileCount;

  return (
    <div className="doc-phone">
      <label className="doc-filter doc-filter-phone">
        <Search {...ICON_SM} />
        <input type="search" value={filter} placeholder={t('phone.search')} aria-label={t('phone.search')} onChange={(e) => setFilter(e.target.value)} />
      </label>
      {!q && !here && <TiedList docs={tied} selected={null} onOpen={(path) => address.go({ doc: path })} phone />}
      <section className="doc-phone-section" aria-labelledby="doc-folder-title">
        <div className="doc-phone-label">
          {here && (
            <button type="button" className="icon-btn" aria-label={t('phone.up')} onClick={() => address.go({ dir: parentDir(here, root) }, false)}>
              <ChevronLeft {...ICON_SM} />
            </button>
          )}
          <h2 id="doc-folder-title" className="section-label doc-fill">
            {q ? t('phone.results') : `${here ?? root}/`}
          </h2>
          <span className="mono small muted tnum">{formatNumber(q ? rows.length : count)}</span>
        </div>
        {rows.length === 0 ? (
          <p className="small muted doc-card-note">{t('tree.noMatch')}</p>
        ) : (
          <ul className="card doc-cells">
            {rows.map((node) => (
              <li key={node.path}>
                <button
                  type="button"
                  className="doc-cell"
                  onClick={() => (node.type === 'dir' ? address.go({ dir: node.path }, false) : address.go({ doc: node.path }))}
                >
                  {node.type === 'dir' ? <Folder {...ICON} className="tree-icon" /> : <FileText {...ICON} className="tree-icon" />}
                  <span className={`doc-cell-name ${node.type === 'dir' ? 'mono' : ''}`.trim()}>{node.type === 'dir' ? `${node.name}/` : q ? node.path : node.name}</span>
                  {node.type === 'dir' && <span className="mono small muted tnum">{t('phone.docCount', { count: node.fileCount ?? 0, n: formatNumber(node.fileCount ?? 0) })}</span>}
                  <ChevronRight {...ICON_SM} className="doc-row-chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function flatFiles(nodes: readonly DocumentNode[]): DocumentNode[] {
  return nodes.flatMap((node) => (node.type === 'file' ? [node] : flatFiles(node.children ?? [])));
}

function findDir(tree: readonly DocumentNode[], path: string): DocumentNode | null {
  for (const node of tree) {
    if (node.type !== 'dir') continue;
    if (node.path === path) return node;
    const inner = findDir(node.children ?? [], path);
    if (inner) return inner;
  }
  return null;
}

function parentDir(dir: string, root: string): string | null {
  const parent = dir.split('/').slice(0, -1).join('/');
  return parent && parent !== root ? parent : null;
}
