// Markdown renderer for Claude's answers, split from the shell bundle: RichText loads it on first use.
import { streamingMarkdownExtension } from '@tanstack/markdown/extensions/streaming';
import { Markdown as MarkdownView, type MarkdownComponentProps, type MarkdownReactOptions } from '@tanstack/markdown/react';
import { isValidElement, type ReactNode } from 'react';
import { autolinkExtension } from '../lib/markdown-autolink';
import { CodeBlock } from './CodeBlock';

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** The code text inside the `<code>` element the renderer puts in every `<pre>`. */
function codeOf(children: ReactNode): string {
  if (!isValidElement<{ children?: ReactNode }>(children)) return '';
  const content = children.props.children;
  // The streaming profile hands a growing block over as groups of lines, not one string
  return Array.isArray(content) ? content.join('') : typeof content === 'string' ? content : '';
}

/**
 * How markdown elements render. Raw HTML in a message is never interpreted (the renderer's default:
 * it stays text), links open outside the panel, and images show as links: a transcript must not
 * fetch whatever URL the model wrote.
 */
const OPTIONS: MarkdownReactOptions = {
  // The streaming profile drops the empty heading or list item a half-written line parses into.
  extensions: [streamingMarkdownExtension(), autolinkExtension()],
  // Ids would repeat across every message on the page
  headingIds: false,
  components: {
    a: (props: MarkdownComponentProps<'a'>) => <a {...props} {...EXTERNAL} />,
    img: ({ src, alt }: MarkdownComponentProps<'img'>) =>
      typeof src === 'string' ? (
        <a href={src} {...EXTERNAL} className="md-image-link">
          {alt || src}
        </a>
      ) : null,
    pre: ({ children, ...props }: MarkdownComponentProps<'pre'> & { 'data-lang'?: string }) => {
      const lang = props['data-lang'];
      // A fence without a language comes through as `plaintext`
      return <CodeBlock code={codeOf(children)} lang={lang === 'plaintext' ? '' : lang} header />;
    },
    table: (props: MarkdownComponentProps<'table'>) => (
      <div className="md-table">
        <table {...props} />
      </div>
    ),
    // Task list boxes are read-only marks, not form controls
    input: ({ type, checked }: MarkdownComponentProps<'input'>) =>
      type === 'checkbox' ? <span className={`md-task ${checked ? 'is-done' : ''}`} aria-label={checked ? 'done' : 'to do'} /> : null,
  },
};

/** Rendered inside RichText's wrapper, which owns the styling. */
export default function Markdown({ text }: { text: string }) {
  return <MarkdownView {...OPTIONS}>{text}</MarkdownView>;
}
