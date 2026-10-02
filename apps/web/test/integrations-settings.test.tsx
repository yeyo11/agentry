// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodeHostStatus, CodeHostsSettings, TrackerId, TrackerStatus, TrackersSettings } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { TooltipProvider } from '@agentry/ui/components/controls';
import { ToastProvider } from '@agentry/ui/components/Toast';
import i18n from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { IntegrationsTab } from '../src/pages/config/IntegrationsTab';
import { GROUPS, isTab, TAB_LABELS } from '../src/pages/config/settingsTabs';

const host = (over: Partial<CodeHostStatus>): CodeHostStatus => ({
  id: 'github',
  label: 'GitHub',
  cli: 'gh',
  binaryPath: '/usr/bin/gh',
  version: '2.92.0',
  minimum: '2.92.0',
  recorded: ['2.92.0'],
  state: 'ready',
  reason: null,
  hosts: [{ hostname: 'github.com', default: true, signedIn: true, user: 'yeyo-dev' }],
  checkedAt: '2026-10-01T10:00:00Z',
  ...over,
});

const gitlab = (over: Partial<CodeHostStatus>): CodeHostStatus =>
  host({ id: 'gitlab', label: 'GitLab', cli: 'glab', binaryPath: '/usr/bin/glab', version: '1.120.0', minimum: '1.120.0', recorded: ['1.120.0'], ...over });

const settings: CodeHostsSettings = {
  hosts: { github: { enabled: true, binaryPath: null }, gitlab: { enabled: true, binaryPath: null } },
};

const tracker = (id: TrackerId, over: Partial<TrackerStatus> = {}): TrackerStatus => {
  const gitlabHost = id === 'gitlab-issues';
  const built = id === 'github-issues' || gitlabHost;
  return {
    id,
    label: id,
    cli: built ? (gitlabHost ? 'glab' : 'gh') : id === 'jira' ? 'acli' : 'youtrack-app',
    host: built ? (gitlabHost ? 'gitlab' : 'github') : null,
    binaryPath: built ? '/usr/bin/gh' : null,
    version: built ? '2.92.0' : null,
    minimum: built ? '2.92.0' : null,
    recorded: built ? ['2.92.0'] : [],
    state: built ? 'ready' : 'unknown',
    reason: built ? null : 'not-recorded',
    checkedAt: '2026-10-01T10:00:00Z',
    ...over,
  };
};

const defaultTrackers = (): TrackerStatus[] => [
  tracker('github-issues'),
  tracker('gitlab-issues', { cli: 'glab', binaryPath: '/usr/bin/glab', version: '1.120.0', minimum: '1.120.0', recorded: ['1.120.0'] }),
  tracker('jira'),
  tracker('youtrack'),
];

const trackerSettings: TrackersSettings = {
  trackers: {
    'github-issues': { enabled: true, binaryPath: null },
    'gitlab-issues': { enabled: true, binaryPath: null },
    jira: { enabled: true, binaryPath: null },
    youtrack: { enabled: true, binaryPath: null },
  },
};

async function render(list: CodeHostStatus[], trackers: TrackerStatus[] = defaultTrackers()): Promise<string> {
  await i18n.changeLanguage('en');
  const client = new QueryClient();
  client.setQueryData(keys.hosts, list);
  client.setQueryData(keys.hostSettings, settings);
  client.setQueryData(keys.trackers, trackers);
  client.setQueryData(keys.trackerSettings, trackerSettings);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <MemoryRouter>
            <IntegrationsTab />
          </MemoryRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('Integrations is a tab of the Agentry group, right after Providers', () => {
  assert.ok(isTab('integrations'));
  const agentry = GROUPS.find((g) => g.id === 'agentry')?.tabs ?? [];
  assert.equal(agentry.indexOf('integrations'), agentry.indexOf('providers') + 1);
  assert.equal(TAB_LABELS.integrations, 'integrations:tab');
});

test('the copy of the tab has the same keys and placeholders in both languages', () => {
  const holes = (s: string) => [...s.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort().join();
  const flat = (o: Record<string, unknown>, at = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${at}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${at}${k}.`)));
  const spanish = new Map(flat(es.integrations));
  for (const [key, value] of flat(en.integrations)) {
    const other = spanish.get(key);
    assert.ok(other, `es ${key}`);
    assert.equal(holes(value), holes(other), key);
  }
  assert.equal(spanish.size, flat(en.integrations).length);
});

test('each program shows its state in words, its hosts with their account, and the remedy its state asks for', async () => {
  const html = await render([
    host({}),
    gitlab({
      version: '1.134.0',
      state: 'degraded',
      reason: 'version-untested',
      hosts: [{ hostname: 'gitlab.com', default: true, signedIn: true, user: 'yeyo' }],
    }),
  ]);
  const text = words(html);
  assert.match(text, /2 programs · 1 ready/);
  assert.match(text, /GitHub PR #12/);
  assert.match(text, /GitLab MR !12/);
  assert.match(text, /gh 2\.92\.0 · \/usr\/bin\/gh/);
  assert.match(text, /Installed, signed in and answering\./);
  assert.match(text, /1\.134\.0 is newer than 1\.120\.0, the latest Agentry has been tested with\./);
  assert.match(text, /Hosts gh knows github\.com yeyo-dev/);
  assert.match(html, /data-host="gitlab"[^>]*data-state="degraded"/);
  assert.match(html, /data-action="choose-binary"/);
});

test('a signed-out host is a word beside its name, and a missing program offers its install page', async () => {
  const html = await render([
    host({ state: 'signed-out', hosts: [{ hostname: 'git.acme.io', default: false, signedIn: false, user: null }] }),
    gitlab({ binaryPath: null, version: null, state: 'not-installed', hosts: [] }),
  ]);
  const text = words(html);
  assert.match(text, /git\.acme\.io\s+Signed out/);
  assert.match(text, /glab is not installed, or Agentry cannot find it\./);
  assert.match(html, /data-action="sign-in"/);
  assert.match(html, /data-action="install"/);
});

test('with neither program found the page is the one empty state', async () => {
  const html = await render([
    host({ state: 'not-installed', binaryPath: null, version: null, hosts: [] }),
    gitlab({ binaryPath: null, version: null, state: 'not-installed', hosts: [] }),
  ]);
  assert.match(words(html), /Agentry cannot find gh or glab/);
  assert.equal((html.match(/data-illustration=/g) ?? []).length, 1);
});

test('the trackers section lists the four trackers; Jira and YouTrack are not available yet, with their reason and no action', async () => {
  const html = await render([host({}), gitlab({})]);
  const text = words(html);
  assert.match(text, /4 trackers · 2 ready/);
  for (const id of ['github-issues', 'gitlab-issues', 'jira', 'youtrack']) assert.match(html, new RegExp(`data-tracker="${id}"`));
  assert.match(text, /Reads and writes issues with gh, with the session it already has\. It works in projects whose code is on GitHub\./);
  const row = (id: string) => html.split(`data-tracker="${id}"`)[1]?.split('data-tracker=')[0] ?? '';
  for (const id of ['jira', 'youtrack']) {
    assert.match(words(row(id)), /Not available yet/);
    assert.match(words(row(id)), /Agentry has not seen how .* answers/);
    assert.doesNotMatch(row(id), /data-action=/);
  }
  assert.match(row('github-issues'), /data-action="choose-binary"/);
  assert.equal((html.match(/grad-border/g) ?? []).length, 1, 'the trackers are the one gradient surface');
});

test('a tracker asks for the one remedy its state needs', async () => {
  const html = await render(
    [host({ state: 'signed-out' }), gitlab({ state: 'not-installed', binaryPath: null, version: null, hosts: [] })],
    [tracker('github-issues', { state: 'signed-out', reason: null }), tracker('gitlab-issues', { state: 'not-installed', cli: 'glab', reason: null, binaryPath: null, version: null }), tracker('jira'), tracker('youtrack')],
  );
  const row = (id: string) => html.split(`data-tracker="${id}"`)[1]?.split('data-tracker=')[0] ?? '';
  assert.match(row('github-issues'), /data-action="sign-in"/);
  assert.match(row('gitlab-issues'), /data-action="install"/);
});
