import { pieces, roleOf, type Piece, type Role } from './paint';
import type { HighlightToken } from '@tanstack/highlight/core';

const SHELL_BUILTINS = new Set(
  '. alias bg bind break builtin caller cd command compgen complete continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait'.split(' '),
);
const SHELL_WORD = /\\\n|\d*>>?&?\d*|&>|\|\||&&|;;|[|;&(){}\n=]|\$\(|\$\{?[\w*@#?$!-]+\}?|[^\s|;&(){}<>"'$=]+|[<>]/g;
const SHELL_EXPANSION = /\$\{?[\d*@#?$!]\}?|\$\{?[A-Za-z_]\w*\}?/g;
/** After these a command may start */
const SHELL_SEPARATORS = new Set(['\n', ';', '|', '||', '&&', '&', '$(', '{', '(']);
const expansion = (word: string): Role | null => (/^\$\{?[A-Za-z_]/.test(word) ? null : 'constant');

/**
 * TanStack marks commands only at the start of a line and leaves arguments, options and most
 * operators unclassed, where the shell grammar colours all three. Enough of a shell's shape to
 * tell them apart: whether a word stands where a command goes, or where a case pattern does.
 */
export function* paintShell(tokens: HighlightToken[]): Generator<Piece> {
  let command = true;
  let pattern = false;
  let assigned = false;
  for (const token of tokens) {
    const text = token.value;
    switch (token.className) {
      case 'keyword':
        pattern = text === 'in' ? pattern : false;
        if (text === 'case') pattern = true;
        command = text !== 'in' && text !== 'case';
        yield [text, 'keyword'];
        break;
      case 'command':
        // The `1` of `2>&1` comes out as a command
        yield [text, /^\d+$/.test(text) ? 'keyword' : SHELL_BUILTINS.has(text) ? 'constant' : 'entity'];
        command = false;
        break;
      case 'variable':
        // An assignment's name, in the foreground like every variable
        yield [text, null];
        break;
      case 'string':
        yield* pieces(text, SHELL_EXPANSION, expansion, 'string');
        command = false;
        assigned = false;
        break;
      case undefined:
        yield* pieces(text, SHELL_WORD, (word, at) => {
          if (word === '=') {
            assigned = true;
            return 'keyword';
          }
          if (word === ';;') {
            pattern = true;
            return null;
          }
          if (SHELL_SEPARATORS.has(word)) {
            command = !pattern;
            assigned = false;
            return word === '||' || (word === '|' && !pattern) ? 'keyword' : null;
          }
          // A line continuation
          if (word === '\\\n') return 'keyword';
          if (word === ')') {
            if (!pattern) return null;
            pattern = false;
            command = true;
            return 'keyword';
          }
          if (/^\d*[<>]|^&>/.test(word)) return 'keyword';
          if (word === '}' || word === ']' || word === ']]') return null;
          if (word.startsWith('$')) return expansion(word);
          if (pattern) return 'string';
          if (assigned) {
            assigned = false;
            return /^\d+$/.test(word) ? 'constant' : 'string';
          }
          if (command) {
            // `NAME=value` before a command
            if (text[at + word.length] === '=') return null;
            command = false;
            if (word === '[' || word === '[[') return null;
            if (text.startsWith('()', at + word.length)) return 'function';
            // A command given by path is an unquoted string to the grammar
            return SHELL_BUILTINS.has(word) ? 'constant' : word.includes('/') ? 'string' : 'entity';
          }
          return /^--?[A-Za-z\d]/.test(word) || /^\d+$/.test(word) ? 'constant' : 'string';
        });
        break;
      default:
        yield [text, roleOf(token)];
    }
  }
}

