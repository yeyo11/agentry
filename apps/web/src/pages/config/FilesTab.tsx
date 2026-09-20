import type { ConfigFileNode } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
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

const TEMPLATES = [
  { id: 'empty', label: 'Empty file', path: '', executable: false, content: '' },
  {
    id: 'hook',
    label: 'Hook script (bash)',
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
    label: 'keybindings.json',
    path: 'keybindings.json',
    executable: false,
    content: '{\n  "bindings": []\n}\n',
  },
  {
    id: 'rule',
    label: 'Rule (markdown)',
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
          <Tooltip content="Delete folder (Delete key)">
            <button
              type="button"
              className="icon-btn tree-delete"
              tabIndex={-1}
              aria-label={`Delete folder ${node.path}`}
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
                  empty
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
  const [templateId, setTemplateId] = useState<(typeof TEMPLATES)[number]['id']>('empty');
  const [path, setPath] = useState('');
  const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const clean = path.trim().replace(/^\/+/, '');
  const invalid = clean.split('/').some((part) => part === '' || part === '.' || part === '..');
  const taken = existing.has(clean);

  return (
    <Dialog
      title="New file"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!clean || invalid || taken}
            onClick={() => onCreate(clean, template.content, template.executable)}
          >
            Create in editor
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Template">
          <Select
            value={templateId}
            onChange={(value) => {
              const next = TEMPLATES.find((t) => t.id === value) ?? TEMPLATES[0];
              setTemplateId(next.id);
              if (next.path) setPath(next.path);
            }}
            options={TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
          />
        </Field>
        <Field label="Path" hint="Relative to the root shown above. Missing directories are created on save.">
          <input
            data-autofocus
            className={`mono ${clean && (invalid || taken) ? 'is-invalid' : ''}`}
            value={path}
            placeholder="hooks/my-hook.sh"
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
        {taken && <span className="field-hint text-err">A file with this path already exists.</span>}
        {clean && invalid && <span className="field-hint text-err">Use a relative path without “..”.</span>}
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
      toast.success('File saved', saved.absolutePath);
    },
    onError: (err) => toast.error('Could not save the file', err),
  });

  const remove = useMutation({
    mutationFn: (path: string) => api.deleteFile(rootId, path),
    onSuccess: (_result, path) => {
      void queryClient.invalidateQueries({ queryKey: keys.fileTree(rootId) });
      setSelected(null);
      setFile(null);
      toast.success(`Deleted ${path}`);
    },
    onError: (err) => toast.error('Could not delete', err),
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
      title: `Delete folder ${path}?`,
      body: 'The folder and everything inside it are deleted from disk. This cannot be undone.',
      confirmLabel: 'Delete folder',
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
      title="Files"
      actions={
        <div className="toolbar">
          <button className="btn btn-small" onClick={() => void tree.refetch()} disabled={tree.isFetching}>
            Refresh
          </button>
          <button className="btn btn-small btn-primary" onClick={() => void guard().then((ok) => ok && setCreating(true))}>
            <Plus size={14} strokeWidth={2} aria-hidden />
            New file
          </button>
        </div>
      }
    >
      <div className="editor-meta">
        <span className="small muted">Root</span>
        <span className="mono small break">{root?.path ?? rootId}</span>
        {root && <CopyButton text={root.path} label="Copy root path" />}
        {root && !root.exists && <Tag tone="info">directory does not exist yet · created on first save</Tag>}
      </div>
      <p className="small muted">
        Everything Claude Code reads from this directory: hook scripts, skill resources, rules, keybindings, memory… Secrets,
        transcripts and caches are hidden by the API.
      </p>
      <ErrorBox error={tree.error} />

      <div className="master-detail master-detail-files">
        <div className="master">
          {tree.isLoading ? (
            <Skeleton rows={6} />
          ) : (tree.data ?? []).length === 0 && !newRow ? (
            <div className="small muted master-empty">No files yet.</div>
          ) : (
            <ul className="tree-group" role="tree" aria-label="Configuration files" onKeyDown={onTreeKeyDown}>
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
                    aria-label={`${newRow}, new file`}
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
                      <Tag tone="warn">new</Tag>
                    </div>
                  </div>
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="detail">
          {selected === null ? (
            <Empty title="Select a file" action={<button className="btn btn-primary" onClick={() => setCreating(true)}>New file</button>}>
              Pick a file from the tree to view and edit it, or create a new one.
            </Empty>
          ) : loadError && !file ? (
            <div className="state state-empty">
              <strong>{loadError.status === 404 ? 'File not found' : 'This file cannot be opened here'}</strong>
              <div className="muted">{errorMessage(loadError)}</div>
              <div className="small muted">Binary, very large and protected files are not editable from the browser.</div>
            </div>
          ) : !file ? (
            <Skeleton rows={10} />
          ) : (
            <div className="form">
              <div className="editor-meta">
                <nav className="breadcrumb" aria-label="File path">
                  {file.path.split('/').map((part, index, parts) => (
                    <span key={index} className={index === parts.length - 1 ? 'strong' : 'muted'}>
                      {part}
                      {index < parts.length - 1 && <span className="breadcrumb-sep">/</span>}
                    </span>
                  ))}
                </nav>
                {content.data && !file.isNew && (
                  <>
                    <CopyButton text={content.data.absolutePath} label="Copy absolute path" />
                    <span className="small muted">
                      {formatBytes(content.data.size)} · {timeAgo(content.data.updatedAt)}
                    </span>
                  </>
                )}
                {dirty && <Tag tone="warn">{file.isNew ? 'not saved yet' : 'unsaved changes'}</Tag>}
              </div>
              <CodeEditor
                key={`${rootId}:${file.path}:${file.isNew}`}
                language={languageForPath(file.path)}
                ariaLabel={`Contents of ${file.path}`}
                minHeight="400px"
                value={file.content}
                onChange={(next) => setFile((f) => (f ? { ...f, content: next } : f))}
                onSave={trySave}
              />
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(file)}>
                  {save.isPending ? 'Saving…' : file.isNew ? 'Create file' : 'Save'}
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
                  Discard
                </button>
                <Switch
                  checked={file.executable}
                  onChange={(executable) => setFile((f) => (f ? { ...f, executable } : f))}
                  tooltip="chmod +x — required for hook scripts run directly"
                >
                  Executable
                </Switch>
                {!file.isNew && selectedNode && (
                  <button
                    className="btn btn-danger push-right"
                    disabled={remove.isPending}
                    onClick={() =>
                      void confirm({
                        title: `Delete ${file.path}?`,
                        body: 'The file is deleted from disk. This cannot be undone.',
                        confirmLabel: 'Delete file',
                        danger: true,
                      }).then((ok) => ok && remove.mutate(file.path))
                    }
                  >
                    Delete
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
