#!/usr/bin/env node
// Redaction rules for everything recorded from `gh`, `glab` and `youtrack-app`: the
// committed fixtures (this CLI) and, from task c13 on, `hosts/redact.ts`, which imports these rules
// so that a stored error detail and a committed recording are cleaned by the same code.
//
//   node packages/core/scripts/redact-recordings.mjs <source> <destination>
//
// copies a file or a directory tree, redacting every file on the way. Placeholders are stable and
// keep JSON valid (they are plain strings inside the existing quotes), so a redacted capture still
// parses and replays byte for byte against itself.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = Object.freeze({
  token: '<redacted:token>',
  secret: '<redacted:secret>',
  signature: '<redacted:signature>',
  auth: '<redacted:auth>',
  cookie: '<redacted:cookie>',
  email: 'user@example.com',
});

/**
 * The owner's own address, named so that no allow rule can ever let it through, and named by its
 * SHA-256 so that the address itself is not written into the repository.
 */
export const OWNER_EMAIL_SHA256 = Object.freeze(['3ebb8ebc7bf3b8d47da468fcd6e8c992254ab4119cbbd66b6f4806488fb66e96']);
const isOwnerEmail = (address) => OWNER_EMAIL_SHA256.includes(createHash('sha256').update(address.toLowerCase()).digest('hex'));

// GitLab's token prefixes (personal, OAuth, runner, CI job, feed, deploy, trigger, SCIM, incoming
// mail, agent, workspace, feature-flag client), documented in GitLab's "Token prefixes" page.
const GITLAB_TOKEN_PREFIXES = ['glpat', 'gloas', 'glrt', 'glrtr', 'glcbt', 'glft', 'gldt', 'glptt', 'glsoat', 'glimt', 'glagent', 'glwt', 'glffct'];

/** JSON keys whose string value is a credential wherever they appear (GitLab's project object carries `runners_token`). */
export const SECRET_KEYS = Object.freeze([
  'runners_token',
  'runner_token',
  'registration_token',
  'runners_registration_token',
  'feed_token',
  'incoming_email_token',
  'deploy_token',
  'private_token',
  'access_token',
  'refresh_token',
  'token',
  'secret',
  'webhook_secret',
  'password',
]);

const isPlaceholder = (value) => value.startsWith('<redacted:') || /^\*+$/.test(value) || value === '';

/**
 * An address that may stay: GitHub's noreply identities, any `noreply@` sender, the reserved
 * documentation domains, and `git@<host>`, which is the user part of an SSH remote, not a mailbox.
 */
export function isAllowedEmail(address) {
  if (isOwnerEmail(address)) return false;
  const lower = address.toLowerCase();
  const at = lower.lastIndexOf('@');
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (domain === 'users.noreply.github.com') return true;
  if (local === 'noreply' || local === 'no-reply') return true;
  if (/^(?:.+\.)?example\.(?:com|org|net)$/.test(domain) || /\.(?:example|invalid|test)$/.test(domain)) return true;
  if (local === 'git') return true;
  return false;
}

// The local part may not start right after a backslash, so a JSON-escaped `\u003cname@host\u003e`
// is matched from `name`, through the lookbehind on the escape.
const EMAIL = /(?:(?<=\\u003c)|(?<![\w.%+\\-]))[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Ordered rules; each is `{ name, pattern, replace }`, applied with `String.prototype.replace`. */
export const RULES = Object.freeze([
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: () => PLACEHOLDER.token,
  },
  {
    name: 'gitlab-token',
    pattern: new RegExp(`\\b(?:(?:${GITLAB_TOKEN_PREFIXES.join('|')})-[A-Za-z0-9_.-]{8,}|GR1348941[A-Za-z0-9_-]{8,})`, 'g'),
    replace: () => PLACEHOLDER.token,
  },
  {
    name: 'secret-json-key',
    pattern: new RegExp(`("(?:${SECRET_KEYS.join('|')})"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`, 'gi'),
    replace: (match, key, value) => {
      if (isPlaceholder(value)) return match;
      return `${key}"${/token/i.test(key) ? PLACEHOLDER.token : PLACEHOLDER.secret}"`;
    },
  },
  {
    name: 'hex-after-token',
    pattern: /\b(token|secret|password)(["']?\s*[:=]\s*["']?)(?:[0-9a-f]{64}|[0-9a-f]{40})\b/gi,
    replace: (_match, key, sep) => `${key}${sep}${PLACEHOLDER.token}`,
  },
  {
    name: 'authorization-header',
    pattern: /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(bearer|basic|token)\s+[^\s"'\\,]+/gi,
    replace: (_match, header, sep, scheme) => `${header}${sep}${scheme} ${PLACEHOLDER.auth}`,
  },
  {
    name: 'bearer',
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    replace: (_match, scheme) => `${scheme} ${PLACEHOLDER.auth}`,
  },
  {
    name: 'token-header',
    pattern: /\b(private-token|job-token|deploy-token|x-gitlab-token)(["']?\s*[:=]\s*["']?)[^"\r\n\\]*/gi,
    replace: (_match, header, sep) => `${header}${sep}${PLACEHOLDER.secret}`,
  },
  {
    name: 'hub-signature',
    pattern: /\b(x-hub-signature(?:-256)?)(["']?\s*[:=]\s*["']?)(sha1=|sha256=)?[0-9a-f]{20,}/gi,
    replace: (_match, header, sep, algorithm = '') => `${header}${sep}${algorithm}${PLACEHOLDER.signature}`,
  },
  {
    name: 'cookie',
    pattern: /\b((?:set-)?cookie)(["']?\s*[:=]\s*["']?)[^"\r\n\\]*/gi,
    replace: (_match, header, sep) => `${header}${sep}${PLACEHOLDER.cookie}`,
  },
  {
    name: 'email',
    pattern: EMAIL,
    replace: (address) => (isAllowedEmail(address) ? address : PLACEHOLDER.email),
  },
]);

/** The text with every rule applied, in order. */
export function redactText(text) {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

// A capture that is not UTF-8 text (none so far) is copied as is rather than mangled; the sentinel
// test still reads every file, so a secret in one would fail the suite.
const isText = (buffer) => !buffer.includes(0) && Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);

/** Copies `source` (a file or a directory) to `destination`, redacting every text file. Returns the number of files changed. */
export function redactTree(source, destination) {
  let changed = 0;
  const walk = (from, to) => {
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from).sort()) walk(join(from, name), join(to, name));
      return;
    }
    mkdirSync(dirname(to), { recursive: true });
    const buffer = readFileSync(from);
    if (!isText(buffer)) {
      copyFileSync(from, to);
      return;
    }
    const text = buffer.toString('utf8');
    const redacted = redactText(text);
    if (redacted !== text) changed += 1;
    writeFileSync(to, redacted);
  };
  walk(resolve(source), resolve(destination));
  return changed;
}

// Bundled into the API, this file is the entry point of the bundle: only its own name makes it a command
if (process.argv[1] && basename(process.argv[1]) === 'redact-recordings.mjs' && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    process.stderr.write('usage: redact-recordings.mjs <source> <destination>\n');
    process.exit(2);
  }
  const changed = redactTree(source, destination);
  process.stdout.write(`redacted ${changed} file(s) into ${destination}\n`);
}
