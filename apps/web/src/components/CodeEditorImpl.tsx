import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
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

// Surfaces and syntax both come from our CSS tokens, so the editor follows the app theme with no
// preset of CodeMirror's: those paint keys red and headings green, colours the design system keeps
// for a status. Syntax is muted, as the reference's editor draws it: keys in the muted grey,
// punctuation and comments faint, headings in weight rather than colour, and the rest from `--sx-*`.
const syntax = HighlightStyle.define([
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.propertyName)], color: 'var(--fg-2)' },
  { tag: tags.heading, color: 'var(--fg)', fontWeight: '600' },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--fg-3)' },
  { tag: [tags.comment, tags.quote], color: 'var(--sx-com)' },
  { tag: [tags.keyword, tags.bool, tags.null, tags.atom, tags.modifier, tags.operatorKeyword], color: 'var(--sx-kw)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--sx-str)' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--sx-num)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--sx-type)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--sx-fn)' },
  { tag: [tags.link, tags.url], color: 'var(--fg-2)', textDecoration: 'underline' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, color: 'var(--fg-2)' },
  { tag: tags.invalid, textDecoration: 'underline wavy', textDecorationColor: 'var(--fg-3)' },
]);

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

// No preset, only CodeMirror's own dark flag, so its base styles (a panel, a tooltip) read as dark
const darkBase = EditorView.theme({}, { dark: true });

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
      syntaxHighlighting(syntax),
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
    // Every editor is a textbox that needs a name, and a tab stop said out loud: a read-only one would
    // otherwise drop out of the tab order, and checkers don't count contenteditable as focusable, so
    // a long file would read as a scroll area the keyboard can't reach
    list.push(EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? 'Editor', tabindex: '0' }));
    return list;
  }, [language, wrap, ariaLabel]);

  return (
    <div className={`code-editor ${invalid ? 'is-invalid' : ''} ${readOnly ? 'is-readonly' : ''}`}>
      <CodeMirror
        value={value}
        theme={dark ? darkBase : 'none'}
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
