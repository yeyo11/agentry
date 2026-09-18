import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
import CodeMirror, { EditorView, keymap, Prec, type Extension } from '@uiw/react-codemirror';
import { useMemo, useRef } from 'react';
import { useEffectiveTheme } from '../lib/theme';
import type { CodeEditorProps, EditorLanguage } from './CodeEditor';

function languageExtension(language: EditorLanguage): Extension[] {
  switch (language) {
    case 'json':
      return [json()];
    case 'markdown':
      // Agents, skills, commands and memories all start with a YAML frontmatter block
      return [yamlFrontmatter({ content: markdown() })];
    case 'javascript':
      return [javascript({ jsx: true })];
    case 'typescript':
      return [javascript({ jsx: true, typescript: true })];
    case 'yaml':
      return [yaml()];
    default:
      return [];
  }
}

// Surfaces come from our CSS tokens, so the editor follows the app theme; only the syntax
// palette is switched between CodeMirror's light and dark presets.
const chrome = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', fontVariantLigatures: 'none' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-faint, var(--text-muted))', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft) !important',
  },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-elev)', border: '1px solid var(--border-strong)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--bg-elev)', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-hover)', border: 'none', color: 'var(--text-muted)' },
});

export default function CodeEditorImpl({
  value,
  onChange,
  language = 'text',
  readOnly = false,
  wrap = true,
  minHeight = '220px',
  maxHeight = '64vh',
  placeholder,
  onSave,
  invalid = false,
  ariaLabel,
}: CodeEditorProps) {
  const dark = useEffectiveTheme() === 'dark';
  // The keymap is created once; the ref keeps it pointing at the latest handler.
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const extensions = useMemo(() => {
    const list: Extension[] = [
      chrome,
      ...languageExtension(language),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              saveRef.current?.();
              return true;
            },
          },
        ]),
      ),
    ];
    if (wrap) list.push(EditorView.lineWrapping);
    if (ariaLabel) list.push(EditorView.contentAttributes.of({ 'aria-label': ariaLabel }));
    return list;
  }, [language, wrap, ariaLabel]);

  return (
    <div className={`code-editor ${invalid ? 'is-invalid' : ''} ${readOnly ? 'is-readonly' : ''}`}>
      <CodeMirror
        value={value}
        theme={dark ? 'dark' : 'light'}
        extensions={extensions}
        minHeight={minHeight}
        maxHeight={maxHeight}
        readOnly={readOnly}
        editable={!readOnly}
        placeholder={placeholder}
        basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, autocompletion: false, tabSize: 2 }}
        onChange={(next) => onChange?.(next)}
      />
    </div>
  );
}
