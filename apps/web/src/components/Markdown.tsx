// Markdown renderer for Claude's answers, split from the shell bundle: RichText loads it on first use.
import { streamingMarkdownExtension } from '@tanstack/markdown/extensions/streaming';
import { Markdown as MarkdownView, type MarkdownComponentProps, type MarkdownReactOptions } from '@tanstack/markdown/react';
import { isValidElement, memo, useRef, type ReactNode } from 'react';
import { autolinkExtension } from '../lib/markdown-autolink';
import { splitMarkdownBlocks, type BlockSplit } from '../lib/markdown-blocks';
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
const COMPONENTS: MarkdownReactOptions['components'] = {
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
};

const autolink = autolinkExtension();

const OPTIONS: MarkdownReactOptions = {
  // The streaming profile drops the empty heading or list item a half-written line parses into.
  extensions: [streamingMarkdownExtension(), autolink],
  // Ids would repeat across every message on the page
  headingIds: false,
  components: COMPONENTS,
};

/**
 * For the last block of an answer that has been cut. Only the start of a document can hold
 * frontmatter (an answer opening with it is never cut), so a later block reading `---` lines as
 * such would not match the whole.
 */
const GROWING: MarkdownReactOptions = { ...OPTIONS, frontmatter: false };

/**
 * For the blocks before it. The streaming profile only ever trims the last block of a document, so
 * leaving it out here keeps the pieces equal to the whole.
 */
const SETTLED: MarkdownReactOptions = { ...GROWING, extensions: [autolink] };

/** The options for piece `index` of `count` an answer is cut into. */
export function pieceOptions(index: number, count: number): MarkdownReactOptions {
  return count === 1 ? OPTIONS : index === count - 1 ? GROWING : SETTLED;
}

/** Memoised on its text, so a finished block is parsed once and then skipped on every update. */
const Block = memo(function Block({ text, options }: { text: string; options: MarkdownReactOptions }) {
  return <MarkdownView {...options}>{text}</MarkdownView>;
});

function StreamingMarkdown({ text }: { text: string }) {
  // A cache, not state: the split is a pure function of the text and the previous split, so a
  // render React throws away leaves it just as valid
  const split = useRef<BlockSplit | null>(null);
  const { text: source, starts } = (split.current = splitMarkdownBlocks(split.current, text));
  // Keyed by where each block starts, so the growing block keeps its elements (and a code block its
  // highlighting) when it settles and a new block starts growing after it
  return (
    <>
      {starts.map((start, index) => (
        <Block
          key={start}
          text={source.slice(start, starts[index + 1])}
          options={pieceOptions(index, starts.length)}
        />
      ))}
    </>
  );
}

/**
 * Rendered inside RichText's wrapper, which owns the styling. `streaming` is for an answer that is
 * still growing: only its last block is parsed again on every update, into the same markup.
 */
export default function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return streaming ? <StreamingMarkdown text={text} /> : <MarkdownView {...OPTIONS}>{text}</MarkdownView>;
}
