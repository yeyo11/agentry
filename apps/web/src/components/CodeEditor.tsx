import { lazy, Suspense } from 'react';

export type EditorLanguage = 'json' | 'markdown' | 'javascript' | 'typescript' | 'yaml' | 'text';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: EditorLanguage;
  readOnly?: boolean;
  /** Soft-wrap long lines (default true) */
  wrap?: boolean;
  minHeight?: string;
  maxHeight?: string;
  placeholder?: string;
  /** Ctrl/Cmd+S inside the editor */
  onSave?: () => void;
  invalid?: boolean;
  ariaLabel?: string;
}

const EXTENSION_LANGUAGE: Record<string, EditorLanguage> = {
  json: 'json',
  jsonl: 'json',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  yaml: 'yaml',
};

/** Shell scripts, dotfiles and unknown types fall back to plain text. */
export function languageForPath(path: string): EditorLanguage {
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  return EXTENSION_LANGUAGE[ext] ?? 'text';
}

// CodeMirror is by far the heaviest dependency: keep it out of the main bundle.
const Impl = lazy(() => import('./CodeEditorImpl'));

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="code-editor code-editor-loading" role="status" style={{ minHeight: props.minHeight ?? '220px' }}>
          <span className="spinner" aria-hidden /> Loading editor…
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  );
}
