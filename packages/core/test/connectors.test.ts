import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Connectors, connectorKind, parseConnectors } from '../src/connectors.ts';
import { tempConfig } from './helpers.ts';

const LIST = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✘ Failed to connect
claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
my-own-server: npx -y some-mcp - ✔ Connected
`;

test('parses only the claude.ai connectors, with the CLI status and prepared actions', () => {
  const connectors = parseConnectors(LIST);
  assert.deepEqual(
    connectors.map((c) => [c.id, c.name, c.kind, c.status]),
    [
      ['claude.ai Claude Docs', 'Claude Docs', 'docs', 'connected'],
      ['claude.ai Gmail', 'Gmail', 'gmail', 'needs-auth'],
      ['claude.ai Google Calendar', 'Google Calendar', 'calendar', 'unknown'],
      ['claude.ai Slack', 'Slack', 'other', 'connected'],
    ],
  );
  const [docs, gmail, calendar, slack] = connectors;
  assert.ok(docs?.actions?.length);
  // Nothing to ask of a connector that cannot answer yet, nor of one Agentry has no prompts for
  assert.equal(gmail?.actions, undefined);
  assert.ok(calendar?.actions?.length);
  assert.equal(slack?.actions, undefined);
  assert.match(calendar?.detail ?? '', /fail/i);
});

test('classifies a connector by its name', () => {
  assert.equal(connectorKind('claude.ai Google Calendar'), 'calendar');
  assert.equal(connectorKind('claude.ai Gmail'), 'gmail');
  assert.equal(connectorKind('claude.ai Claude Docs'), 'docs');
  assert.equal(connectorKind('claude.ai Slack'), 'other');
});

test('overview reports what is missing, what a person must do and what has no CLI surface', async () => {
  const config = tempConfig();
  const stub = join(config.dataDir, 'claude-stub.sh');
  const counter = join(config.dataDir, 'calls');
  // A shell stub stands in for the CLI: `claude mcp list` is the only thing asked of it
  writeFileSync(stub, `#!/bin/sh\necho x >> '${counter}'\ncat <<'EOF'\nclaude.ai Gmail: https://g - ✔ Connected\nEOF\n`);
  chmodSync(stub, 0o755);
  const connectors = new Connectors({ ...config, claudeBin: stub });

  const overview = await connectors.overview();
  assert.equal(overview.error, undefined);
  assert.deepEqual(overview.notListed, ['docs', 'calendar']);
  assert.ok(overview.authorisation.steps.some((s) => s.includes('/mcp')));
  assert.deepEqual(overview.unavailable.map((l) => l.id), ['web-artifacts', 'claude-ai-memory']);
  for (const limit of overview.unavailable) assert.match(limit.reason, /no public API and no CLI command/);

  // Served from the cache until a refresh is asked for
  await connectors.overview();
  await connectors.overview(true);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 2);
});

test('a missing CLI is an error on the overview, not an empty list read as "no connectors"', async () => {
  const overview = await new Connectors({ ...tempConfig(), claudeBin: '/nonexistent/claude' }).overview();
  assert.deepEqual(overview.connectors, []);
  assert.ok(overview.error);
  assert.equal(overview.unavailable.length, 2);
});
