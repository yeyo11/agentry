import type { ConfigFileNode } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiRequestError, keys, type Scope } from '../../api';
import { CodeEditor, languageForPath } from '../../components/CodeEditor';
import { Select, Switch, Tooltip } from '../../components/controls';
import { Dialog, useConfirm } from '../../components/Dialog';
import { fileIcon, ICON_SM } from '../../components/icons';
import { Collapse } from '../../components/motion';
import { useToast } from '../../components/Toast';
import { Card, CopyButton, Empty, ErrorBox, Field, Skeleton, Tag } from '../../components/ui';
import { useDirty, useLeaveGuard } from '../../lib/dirty';
import { errorMessage, formatBytes, timeAgo } from '../../lib/format';

// Labels live in the `config` locale under files.templates
const TEMPLATES = [
  { id: 'empty', path: '', executable: false, content: '' },
  {
    id: 'hook',
    path: 'hooks/my-hook.sh',
    executable: true,
    content: `#!/usr/bin/env bash
# Claude Code hook. The event payload arrives as JSON on stdin.
# Exit 0 = continue · exit 2 = block, and stderr is shown to Claude.
set -euo pipefail

payload="$(cat)"
tool_name="$(jq -r '.tool_name // empty' <<<"$payload")"
command="$(jq -r '.tool_input.command // empty' <<<"$payload")"

# Example: block a dangerous command
# if [[ "$tool_name" == "Bash" && "$command" == *"rm -rf /"* ]]; then
#   echo "Blocked by hook" >&2
#   exit 2
# fi

exit 0
`,
  },
  {
    id: 'keybindings',
    path: 'keybindings.json',
    executable: false,
    content: '{\n  "bindings": []\n}\n',
  },
  {
    id: 'rule',
    path: 'rules/my-rule.md',
    executable: false,
    content: '---\npaths:\n  - "src/**/*.ts"\n---\n\n# Rule\n\n- …\n',
  },
] as const;

const FILE_ICONS: Record<string, string> = { md: '▤', json: '{}', sh: '$', js: 'js', ts: 'ts', yml: '≡', yaml: '≡' };

/** Paths of the rows that are on screen, in order: the closed folders hide their children. */
function visiblePaths(nodes: ConfigFileNode[], expanded: ReadonlySet<string>, out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.path);
    if (node.type === 'dir' && expanded.has(node.path) && node.children) visiblePaths(node.children, expanded, out);
  }
  return out;
}

/**
 * One row of the tree. The row itself is the treeitem (the ARIA tree pattern: one tab stop, arrow
 * keys, Delete on a folder) and the folder's delete button sits inside it, out of the tab order.
 */
function TreeNode({
  node,
  depth,
  expanded,
  selected,
  tabStop,
  onToggle,
  onSelect,
  onDeleteDir,
  onFocusItem,
}: {
  node: ConfigFileNode;
  depth: number;
  expanded: ReadonlySet<string>;
  selected: string | null;
  tabStop: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDeleteDir: (path: string) => void;
  onFocusItem: (path: string) => void;
}) {
  const isDir = node.type === 'dir';
  const open = expanded.has(node.path);
  const FileIcon = fileIcon(node.name);
  const { t } = useTranslation(['config', 'common']);
  return (
    <li role="none">
      <div
        role="treeitem"
        aria-label={isDir ? node.name : `${node.name}${node.size !== undefined ? `, ${formatBytes(node.size)}` : ''}`}
        aria-level={depth + 1}
        aria-expanded={isDir ? open : undefined}
        aria-selected={selected === node.path}
        tabIndex={tabStop === node.path ? 0 : -1}
        data-path={node.path}
        data-dir={isDir ? '' : undefined}
        className="tree-line"
        onFocus={(event) => event.target === event.currentTarget && onFocusItem(node.path)}
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
      >
        <div className={`tree-row ${selected === node.path ? 'tree-row-on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          {isDir ? (
            <ChevronRight size={12} strokeWidth={2} className={`tree-chevron ${open ? 'is-open' : ''}`} aria-hidden />
          ) : (
            <span className="tree-spacer" aria-hidden />
          )}
          <span className={`tree-icon ${isDir ? 'tree-icon-dir' : ''}`} aria-hidden>
            {isDir ? open ? <FolderOpen {...ICON_SM} /> : <Folder {...ICON_SM} /> : <FileIcon {...ICON_SM} />}
          </span>
          <span className={`break ${isDir ? 'strong' : ''}`}>{node.name}</span>
          {!isDir && node.size !== undefined && <span className="small muted tree-size">{formatBytes(node.size)}</span>}
        </div>
        {isDir && (
          <Tooltip content={t('files.deleteFolderKey')}>
            <button
              type="button"
              className="icon-btn tree-delete"
              tabIndex={-1}
              aria-label={t('files.deleteFolderPath', { path: node.path })}
              onClick={(event) => {
                event.stopPropagation();
                onDeleteDir(node.path);
              }}
            >
              <Trash2 {...ICON_SM} />
            </button>
          </Tooltip>
        )}
      </div>
      {isDir && (
        <Collapse open={open}>
          <ul role="group" className="tree-group">
            {node.children?.length ? (
              node.children.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  expanded={expanded}
                  selected={selected}
                  tabStop={tabStop}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onDeleteDir={onDeleteDir}
                  onFocusItem={onFocusItem}
                />
              ))
            ) : (
              <li role="none" aria-hidden>
                <div className="small muted tree-empty" style={{ paddingLeft: 22 + (depth + 1) * 14 }}>
                  {t('files.emptyDir')}
                </div>
              </li>
            )}
          </ul>
        </Collapse>
      )}
    </li>
  );
}

function NewFileDialog({
  existing,
  onCreate,
  onClose,
}: {
  existing: ReadonlySet<string>;
  onCreate: (path: string, content: string, executable: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['config', 'common']);
  const [templateId, setTemplateId] = useState<(typeof TEMPLATES)[number]['id']>('empty');
  const [path, setPath] = useState('');
  const template = TEMPLATES.find((entry) => entry.id === templateId) ?? TEMPLATES[0];
  const clean = path.trim().replace(/^\/+/, '');
  const invalid = clean.split('/').some((part) => part === '' || part === '.' || part === '..');
  const taken = existing.has(clean);

  return (
    <Dialog
      title={t('files.newFile')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common:actions.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!clean || invalid || taken}
            onClick={() => onCreate(clean, template.content, template.executable)}
          >
            {t('files.createInEditor')}
          </button>
        </>
      }
    >
      <div className="form">
        <Field label={t('files.template')}>
          <Select
            value={templateId}
            onChange={(value) => {
              const next = TEMPLATES.find((entry) => entry.id === value) ?? TEMPLATES[0];
              setTemplateId(next.id);
              if (next.path) setPath(next.path);
            }}
            options={TEMPLATES.map((entry) => ({
              value: entry.id,
              label: t(`files.templates.${entry.id}`),
            }))}
          />
        </Field>
        <Field label={t('files.path')} hint={t('files.pathHint')}>
          <input
            data-autofocus
            className={`mono ${clean && (invalid || taken) ? 'is-invalid' : ''}`}
            value={path}
            placeholder="hooks/my-hook.sh"
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
        {taken && <span className="field-hint text-err">{t('files.taken')}</span>}
        {clean && invalid && <span className="field-hint text-err">{t('files.invalidPath')}</span>}
      </div>
    </Dialog>
  );
}

interface OpenFile {
  path: string;
  content: string;
  saved: string;
  executable: boolean;
  savedExecutable: boolean;
  isNew: boolean;
}

function flatten(nodes: ConfigFileNode[], out = new Set<string>()): Set<string> {
  for (const node of nodes) {
    out.add(node.path);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

export function FilesTab({ scope }: { scope: Scope }) {
  const { t } = useTranslation(['config', 'common']);
  const rootId = scope.projectId ?? 'user';
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const guard = useLeaveGuard();

  const roots = useQuery({ queryKey: keys.fileRoots, queryFn: api.fileRoots });
  const tree = useQuery({ queryKey: keys.fileTree(rootId), queryFn: () => api.fileTree(rootId) });
  const root = roots.data?.find((r) => r.id === rootId);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [creating, setCreating] = useState(false);
  const allPaths = useMemo(() => flatten(tree.data ?? []), [tree.data]);
  // The tree is one tab stop: the row last focused, else the open file, else the first row on screen
  const [focusPath, setFocusPath] = useState<string | null>(null);

  const content = useQuery({
    queryKey: keys.fileContent(rootId, selected ?? ''),
    queryFn: () => api.fileContent(rootId, selected ?? ''),
    enabled: selected !== null && !file?.isNew,
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    const loaded = content.data;
    if (loaded && loaded.path === selected && (!file || file.path !== loaded.path)) {
      setFile({
        path: loaded.path,
        content: loaded.content,
        saved: loaded.content,
        executable: loaded.executable,
        savedExecutable: loaded.executable,
        isNew: false,
      });
    }
  }, [content.data, selected, file]);

  const dirty = file !== null && (file.isNew || file.content !== file.saved || file.executable !== file.savedExecutable);
  useDirty('files', dirty);

  const save = useMutation({
    mutationFn: (f: OpenFile) => api.putFile({ root: rootId, path: f.path, content: f.content, executable: f.executable }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.fileTree(rootId) });
      queryClient.setQueryData(keys.fileContent(rootId, saved.path), saved);
      setFile({
        path: saved.path,
        content: saved.content,
        saved: saved.content,
        executable: saved.executable,
        savedExecutable: saved.executable,
        isNew: false,
      });
      toast.success(t('files.saved'), saved.absolutePath);
    },
    onError: (err) => toast.error(t('files.saveFailed'), err),
  });

  const remove = useMutation({
    mutationFn: (path: string) => api.deleteFile(rootId, path),
    onSuccess: (_result, path) => {
      void queryClient.invalidateQueries({ queryKey: keys.fileTree(rootId) });
      setSelected(null);
      setFile(null);
      toast.success(t('files.deleted', { path }));
    },
    onError: (err) => toast.error(t('files.deleteFailed'), err),
  });

  const select = async (path: string) => {
    if (path === selected) return;
    if (!(await guard())) return;
    setFile(null);
    setSelected(path);
  };

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startNew = (path: string, template: string, executable: boolean) => {
    setCreating(false);
    // Reveal the parents so the file is visible in the tree once saved
    const parts = path.split('/');
    setExpanded((current) => new Set([...current, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]));
    setSelected(path);
    setFile({ path, content: template, saved: '', executable, savedExecutable: false, isNew: true });
  };

  const trySave = () => file && dirty && !save.isPending && save.mutate(file);
  const loadError = content.error instanceof ApiRequestError ? content.error : null;
  const selectedNode = selected !== null && allPaths.has(selected);
  const newRow = file?.isNew && !allPaths.has(file.path) ? file.path : null;
  const rows = [...visiblePaths(tree.data ?? [], expanded), ...(newRow ? [newRow] : [])];
  const tabStop = [focusPath, selected].find((path) => path !== null && rows.includes(path)) ?? rows[0] ?? null;

  const askDeleteDir = (path: string) =>
    void confirm({
      title: t('files.deleteFolderTitle', { path }),
      body: t('files.deleteFolderBody'),
      confirmLabel: t('files.deleteFolder'),
      danger: true,
    }).then((ok) => ok && remove.mutate(path));

  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role=treeitem]') : null;
    // Keys typed in the folder's delete button are the button's own
    if (!item || event.target !== item) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=treeitem]')];
    const at = items.indexOf(item);
    const path = item.dataset.path ?? '';
    const isDir = item.dataset.dir !== undefined;
    const isOpen = item.getAttribute('aria-expanded') === 'true';
    const go = (target: HTMLElement | null | undefined) => {
      event.preventDefault();
      target?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(items[at + 1]);
      case 'ArrowUp':
        return go(items[at - 1]);
      case 'Home':
        return go(items[0]);
      case 'End':
        return go(items[items.length - 1]);
      case 'ArrowRight':
        if (!isDir) return;
        if (!isOpen) {
          event.preventDefault();
          return toggle(path);
        }
        return go(items[at + 1]);
      case 'ArrowLeft':
        if (isDir && isOpen) {
          event.preventDefault();
          return toggle(path);
        }
        return go(item.closest('li')?.parentElement?.closest('li')?.querySelector<HTMLElement>(':scope > [role=treeitem]'));
      case 'Enter':
      case ' ':
        event.preventDefault();
        return item.click();
      case 'Delete':
        if (!isDir) return;
        event.preventDefault();
        return askDeleteDir(path);
    }
  };

  return (
    <Card
      title={t('config.tabs.files')}
      actions={
        <div className="toolbar">
          <button className="btn btn-small" onClick={() => void tree.refetch()} disabled={tree.isFetching}>
            {t('shared.refresh')}
          </button>
          <button className="btn btn-small btn-primary" onClick={() => void guard().then((ok) => ok && setCreating(true))}>
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t('files.newFile')}
          </button>
        </div>
      }
    >
      <div className="editor-meta">
        <span className="small muted">{t('files.root')}</span>
        <span className="mono small break">{root?.path ?? rootId}</span>
        {root && <CopyButton text={root.path} label={t('files.copyRoot')} />}
        {root && !root.exists && <Tag tone="info">{t('files.rootMissing')}</Tag>}
      </div>
      <p className="small muted">{t('files.intro')}</p>
      <ErrorBox error={tree.error} />

      <div className="master-detail master-detail-files">
        <div className="master">
          {tree.isLoading ? (
            <Skeleton rows={6} />
          ) : (tree.data ?? []).length === 0 && !newRow ? (
            <div className="small muted master-empty">{t('files.noFiles')}</div>
          ) : (
            <ul className="tree-group" role="tree" aria-label={t('files.tree')} onKeyDown={onTreeKeyDown}>
              {(tree.data ?? []).map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  selected={selected}
                  tabStop={tabStop}
                  onToggle={toggle}
                  onSelect={(path) => void select(path)}
                  onDeleteDir={askDeleteDir}
                  onFocusItem={setFocusPath}
                />
              ))}
              {newRow && (
                <li role="none">
                  <div
                    role="treeitem"
                    aria-label={t('files.newFileNamed', { name: newRow })}
                    aria-level={1}
                    aria-selected
                    tabIndex={tabStop === newRow ? 0 : -1}
                    data-path={newRow}
                    className="tree-line"
                    onFocus={(event) => event.target === event.currentTarget && setFocusPath(newRow)}
                  >
                    <div className="tree-row tree-row-on" style={{ paddingLeft: 8 }}>
                      <span className="tree-icon" aria-hidden>
                        +
                      </span>
                      <span className="break">{newRow}</span>
                      <Tag tone="warn">{t('files.new')}</Tag>
                    </div>
                  </div>
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="detail">
          {selected === null ? (
            <Empty
              title={t('files.select')}
              action={
                // The toolbar's New file is the primary; this is the same action, closer to hand
                <button className="btn" onClick={() => setCreating(true)}>
                  {t('files.newFile')}
                </button>
              }
            >
              {t('files.selectHint')}
            </Empty>
          ) : loadError && !file ? (
            <div className="state state-empty">
              <strong>{loadError.status === 404 ? t('files.notFound') : t('files.cannotOpen')}</strong>
              <div className="muted">{errorMessage(loadError)}</div>
              <div className="small muted">{t('files.cannotOpenHint')}</div>
            </div>
          ) : !file ? (
            <Skeleton rows={10} />
          ) : (
            <div className="form">
              <div className="editor-meta">
                <nav className="breadcrumb" aria-label={t('files.filePath')}>
                  {file.path.split('/').map((part, index, parts) => (
                    <span key={index} className={index === parts.length - 1 ? 'strong' : 'muted'}>
                      {part}
                      {index < parts.length - 1 && <span className="breadcrumb-sep">/</span>}
                    </span>
                  ))}
                </nav>
                {content.data && !file.isNew && (
                  <>
                    <CopyButton text={content.data.absolutePath} label={t('files.copyAbsolute')} />
                    <span className="small muted">
                      {formatBytes(content.data.size)} · {timeAgo(content.data.updatedAt)}
                    </span>
                  </>
                )}
                {dirty && <Tag tone="warn">{file.isNew ? t('resources.notSavedYet') : t('shared.unsaved')}</Tag>}
              </div>
              <CodeEditor
                key={`${rootId}:${file.path}:${file.isNew}`}
                language={languageForPath(file.path)}
                ariaLabel={t('files.contents', { path: file.path })}
                minHeight="400px"
                value={file.content}
                onChange={(next) => setFile((f) => (f ? { ...f, content: next } : f))}
                onSave={trySave}
              />
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(file)}>
                  {save.isPending ? t('shared.saving') : file.isNew ? t('files.create') : t('shared.save')}
                </button>
                <button
                  className="btn"
                  disabled={!dirty}
                  onClick={() => {
                    if (file.isNew) {
                      setFile(null);
                      setSelected(null);
                    } else setFile({ ...file, content: file.saved, executable: file.savedExecutable });
                  }}
                >
                  {t('shared.discard')}
                </button>
                <Switch
                  checked={file.executable}
                  onChange={(executable) => setFile((f) => (f ? { ...f, executable } : f))}
                  tooltip={t('files.executableHint')}
                >
                  {t('files.executable')}
                </Switch>
                {!file.isNew && selectedNode && (
                  <button
                    className="btn btn-danger push-right"
                    disabled={remove.isPending}
                    onClick={() =>
                      void confirm({
                        title: t('files.deleteTitle', { path: file.path }),
                        body: t('resources.deleteFileBody'),
                        confirmLabel: t('files.deleteFile'),
                        danger: true,
                      }).then((ok) => ok && remove.mutate(file.path))
                    }
                  >
                    {t('common:actions.delete')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {creating && <NewFileDialog existing={allPaths} onClose={() => setCreating(false)} onCreate={startNew} />}
    </Card>
  );
}
