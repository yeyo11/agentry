// A synthetic transcript for the specs that page through a long one. Every entry carries a
// marker (m0000…) in its visible text, so a spec can tell which row of the whole is on screen.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const mark = (i) => `m${String(i).padStart(4, '0')}`;
const at = (i) => new Date(Date.UTC(2026, 0, 1, 9, 0, i)).toISOString();

/** Cycles through the shapes a real conversation has: prompts, markdown with code, tool calls and their results. */
export function entry(i, session) {
  const base = { uuid: `${session}-${mark(i)}`, timestamp: at(i), cwd: '/work/paging', version: '2.1.0', sessionId: session };
  const assistant = (content) => ({ ...base, type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content } });
  const user = (content) => ({ ...base, type: 'user', message: { role: 'user', content } });
  switch (i % 4) {
    case 0:
      return user(`${mark(i)} Please look at the parser again, the second pass drops trailing commas.`);
    case 1:
      return assistant([
        {
          type: 'text',
          text:
            `${mark(i)} The **second pass** is where it goes wrong:\n\n` +
            '```ts\nexport function parse(src: string): Node[] {\n  const out: Node[] = [];\n  for (const tok of lex(src)) {\n    if (tok.kind === "comma") continue;\n    out.push(toNode(tok));\n  }\n  return out;\n}\n```\n\n' +
            '- it skips the comma\n- and never records the gap',
        },
        { type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command: `pnpm test parser ${mark(i)}` } },
      ]);
    case 2:
      return user([{ type: 'tool_result', tool_use_id: `tool-${i - 1}`, content: `${mark(i)} ✓ parser (12 tests)\nall passed` }]);
    default:
      return assistant([{ type: 'text', text: `${mark(i)} Fixed: trailing commas now survive the second pass.` }]);
  }
}

const lines = (session, from, to) => Array.from({ length: to - from }, (_, i) => JSON.stringify(entry(from + i, session))).join('\n');

/** Writes a transcript of `total` entries into the config dir; returns the file, for growing it later. */
export function seedTranscript(configDir, project, session, total) {
  const dir = join(configDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session}.jsonl`);
  writeFileSync(file, lines(session, 0, total));
  return file;
}

/** The chat wrote on: entries `from` up to `to` go on the end of the file, as the CLI appends them. */
export function growTranscript(file, session, from, to) {
  appendFileSync(file, `\n${lines(session, from, to)}`);
}
