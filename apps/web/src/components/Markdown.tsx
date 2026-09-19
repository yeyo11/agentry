// Markdown renderer for Claude's answers, split from the shell bundle: RichText loads it on first use.
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

const REMARK_PLUGINS = [remarkGfm];

/** The slice of a hast node the renderers read; the full type lives in a package this app does not depend on. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

const textOf = (node: HastNode | undefined): string =>
  node ? (node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('')) : '';

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * How markdown elements render. Raw HTML in a message is never interpreted, links open outside the
 * panel, and images show as links: a transcript must not fetch whatever URL the model wrote.
 */
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} {...EXTERNAL} />,
  img: ({ src, alt }) =>
    typeof src === 'string' ? (
      <a href={src} {...EXTERNAL} className="md-image-link">
        {alt || src}
      </a>
    ) : null,
  pre: ({ node }) => {
    const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === 'code');
    const classes = Array.isArray(code?.properties?.className) ? (code.properties.className as string[]) : [];
    const lang = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
    return <CodeBlock code={textOf(code).replace(/\n$/, '')} lang={lang} header />;
  },
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
  // Task list boxes are read-only marks, not form controls
  input: ({ type, checked }) => (type === 'checkbox' ? <span className={`md-task ${checked ? 'is-done' : ''}`} aria-label={checked ? 'done' : 'to do'} /> : null),
};

/** Rendered inside RichText's wrapper, which owns the styling. */
export default function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}
