import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { claudeCodeManifest } from '../src/providers/claude-code/manifest.ts';
import { driverConformance } from './conformance/suite.ts';

// The Claude driver through the conformance suite, on the control-protocol fake. The turns are
// replayed from recorded shapes of the CLI's stream (fixtures/replay), never invented here.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const replay = (file: string, raw = false) => `${raw ? 'REPLAY-RAW' : 'REPLAY'} ${fileURLToPath(new URL(join('./fixtures/replay', file), import.meta.url))}`;

driverConformance('claude-code', {
  manifest: claudeCodeManifest,
  driver: () => new ClaudeCodeDriver(FAKE_CLAUDE),
  script: {
    turn: replay('conformance-turn.jsonl'),
    ask: (tool) => `ASK ${tool}`,
    unexpected: 'ODD',
    budget: replay('budget.jsonl', true),
    rateLimit: replay('rate-limit.jsonl', true),
    structured: replay('structured.jsonl', true),
    noisy: 'STDERR conformance stderr line',
    delegating: replay('agent-turn.jsonl', true),
  },
  structuredResult: { verdict: 'pass', notes: ['a', 'b'] },
  decision: (result) => (result.includes('"behavior":"allow"') ? 'allow' : result.includes('"behavior":"deny"') ? 'deny' : null),
  stderrText: 'conformance stderr line',
});
