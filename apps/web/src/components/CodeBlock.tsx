import { Fragment, useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from './ui';

type Tokens = Awaited<ReturnType<typeof import('./highlight').highlight>>;

/**
 * Highlights off the main bundle and a beat after the code stops changing. While a block is still
 * streaming, the part already coloured stays coloured and only the new tail shows plain.
 */
function useHighlight(code: string, lang: string | undefined, enabled: boolean): { tokens: NonNullable<Tokens>; rest: string } | null {
  const [done, setDone] = useState<{ code: string; tokens: NonNullable<Tokens> } | null>(null);
  useEffect(() => {
    if (!enabled || !lang) return;
    let live = true;
    const timer = setTimeout(() => {
      import('./highlight')
        .then((m) => m.highlight(code, lang))
        .then((tokens) => {
          if (live && tokens) setDone({ code, tokens });
        })
        .catch(() => {
          // colour is a nicety: the plain block is already on screen
        });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, lang, enabled]);
  if (!done || !code.startsWith(done.code)) return null;
  return { tokens: done.tokens, rest: code.slice(done.code.length) };
}

/**
 * Code surface with a copy button. `header` gives it the always-visible bar with the language that
 * chat answers get; tool payloads keep the quieter bar that shows on hover.
 */
export function CodeBlock({ code, lang, tone, header = false }: { code: string; lang?: string; tone?: 'error'; header?: boolean }) {
  const { t } = useTranslation('components');
  const highlighted = useHighlight(code, lang, tone !== 'error');
  return (
    <div className={`code-block ${tone === 'error' ? 'is-error' : ''} ${header ? 'has-header' : ''}`}>
      <div className="code-block-bar">
        {(lang || header) && <span className="code-lang">{lang || 'text'}</span>}
        <CopyButton text={code} label={t('ui.copyCode')} />
      </div>
      {/* Highlighted, the block carries the foreground colour, which the bare runs inherit */}
      {/* Focusable so long lines can be scrolled from the keyboard; a group, not a landmark, since a transcript holds many */}
      <pre className="code" role="group" aria-label={lang ? t('codeBlock.labelLang', { lang }) : t('codeBlock.label')} tabIndex={0} data-lang={lang || undefined} style={highlighted ? (highlighted.tokens.base as CSSProperties) : undefined}>
        {highlighted ? (
          <>
            {highlighted.tokens.lines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 && '\n'}
                {line.map((run, j) =>
                  typeof run === 'string' ? (
                    run
                  ) : (
                    <span key={j} style={run.style as CSSProperties}>
                      {run.content}
                    </span>
                  ),
                )}
              </Fragment>
            ))}
            {highlighted.rest}
          </>
        ) : (
          code
        )}
      </pre>
    </div>
  );
}
