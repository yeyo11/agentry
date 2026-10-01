import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OWNER_EMAIL_SHA256, redactText } from '../scripts/redact-recordings.mjs';

// The recordings are real output from the owner's accounts. This test is written apart from the
// redaction rules on purpose: a rule that stops matching must not also blind the check.
const ROOT = fileURLToPath(new URL('./fixtures/recordings/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const PLACEHOLDER = /^<redacted:[a-z]+>$/;
const GITLAB_PREFIXES = 'glpat|gloas|glrt|glrtr|glcbt|glft|gldt|glptt|glsoat|glimt|glagent|glwt|glffct';

/** Every finding in one text, as `kind: excerpt`; empty when the text is clean. */
function findLeaks(text: string): string[] {
  const leaks: string[] = [];
  const report = (kind: string, excerpt: string) => leaks.push(`${kind}: ${excerpt.slice(0, 80)}`);
  const scan = (kind: string, pattern: RegExp, keep: (match: RegExpExecArray) => boolean = () => false) => {
    for (const match of text.matchAll(pattern)) if (!keep(match)) report(kind, match[0]);
  };

  scan('github token', /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g);
  scan('gitlab token', new RegExp(`\\b(?:(?:${GITLAB_PREFIXES})-[A-Za-z0-9_.-]{8,}|GR1348941[A-Za-z0-9_-]{8,})`, 'g'));
  scan('bearer token', /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/gi);
  scan('authorization header', /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+([^\s"'\\,]+)/gi, (m) =>
    PLACEHOLDER.test(m[1] ?? ''),
  );
  scan('secret key', /"(runners_token|runner_token|registration_token|runners_registration_token|feed_token|incoming_email_token|deploy_token|private_token|access_token|refresh_token|token|secret|webhook_secret|password)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi, (m) => {
    const value = m[2] ?? '';
    return value === '' || /^\*+$/.test(value) || PLACEHOLDER.test(value);
  });
  scan('hook signature', /\bx-hub-signature(?:-256)?["']?\s*[:=]\s*["']?(?:sha1=|sha256=)?[0-9a-f]{20,}/gi);
  scan('hook token', /\b(?:x-gitlab-token|private-token|job-token|deploy-token)["']?\s*[:=]\s*["']?([^"\r\n\\]*)/gi, (m) =>
    PLACEHOLDER.test(m[1] ?? ''),
  );
  scan('cookie', /\b(?:set-)?cookie["']?\s*[:=]\s*["']?([^"\r\n\\]*)/gi, (m) => PLACEHOLDER.test(m[1] ?? ''));
  scan('e-mail', /(?:(?<=\\u003c)|(?<![\w.%+\\-]))[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => {
    const address = m[0].toLowerCase();
    const [local = '', domain = ''] = address.split('@');
    return (
      domain === 'users.noreply.github.com' ||
      local === 'noreply' ||
      local === 'no-reply' ||
      address === 'user@example.com' ||
      /^(?:.+\.)?example\.(?:com|org|net)$/.test(domain) ||
      // The user of an SSH remote (`git@github.com:owner/repo.git`), not a mailbox.
      local === 'git'
    );
  });
  for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g)) {
    const hash = createHash('sha256').update(match[0].toLowerCase()).digest('hex');
    if (OWNER_EMAIL_SHA256.includes(hash)) report("owner's e-mail", match[0]);
  }
  return leaks;
}

test('no recorded file carries a token, a hook secret, a signature, a cookie or a personal e-mail', () => {
  const all = files(ROOT);
  assert.ok(all.length > 1000, `expected the whole recordings tree, found ${all.length} files`);
  const leaks = all.flatMap((path) => findLeaks(readFileSync(path, 'utf8')).map((leak) => `${relative(ROOT, path)}: ${leak}`));
  assert.deepEqual(leaks, []);
});

test('the sentinel notices each kind of secret it guards against', () => {
  // Built from pieces so this file never holds a token-shaped literal itself.
  const samples = [
    `"token": "${'gh'}p_${'a1'.repeat(18)}"`,
    `${'github'}_pat_${'B2'.repeat(15)}`,
    `${'gl'}pat-${'c3'.repeat(10)}`,
    `${'GR1348941'}${'d4'.repeat(6)}`,
    `Authorization: Bearer ${'e5'.repeat(15)}`,
    '"runners_token":"abcdef123456"',
    '"config":{"secret":"hunter2"}',
    `"X-Hub-Signature-256":"sha256=${'f6'.repeat(32)}"`,
    '"X-Gitlab-Token":"s3cret"',
    'Set-Cookie: _session=abc123',
    '"author_email":"someone@company.io"',
  ];
  for (const sample of samples) assert.notDeepEqual(findLeaks(sample), [], `the sentinel missed ${sample}`);
});

test('the redaction rules clean everything the sentinel looks for, and leave JSON valid', () => {
  const document = JSON.stringify({
    token: `${'gh'}o_${'a1'.repeat(18)}`,
    runners_token: `${'GR1348941'}${'d4'.repeat(6)}`,
    config: { secret: 'hunter2', url: 'https://example.invalid/probe' },
    request_headers: { 'X-Gitlab-Token': 's3cret', 'X-Hub-Signature': `sha1=${'0a'.repeat(20)}`, Cookie: 'a=b' },
    author_email: 'someone@company.io',
    committer_email: 'someone.else@company.io',
    noreply: '33735891+yeyo11@users.noreply.github.com',
    ssh_url_to_repo: 'git@gitlab.com:yeyo11/agentry.git',
    log: `AUTHORIZATION: basic ${'Zz'.repeat(12)} and ${'gl'}pat-${'c3'.repeat(10)}`,
  });
  const redacted = redactText(document);
  assert.deepEqual(findLeaks(redacted), []);
  const parsed = JSON.parse(redacted) as Record<string, unknown>;
  assert.equal(parsed.noreply, '33735891+yeyo11@users.noreply.github.com', 'noreply identities stay');
  assert.equal(parsed.ssh_url_to_repo, 'git@gitlab.com:yeyo11/agentry.git', 'SSH remotes stay');
  assert.equal(parsed.author_email, 'user@example.com');
  assert.equal(parsed.runners_token, '<redacted:token>');
});
