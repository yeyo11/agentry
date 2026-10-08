/**
 * How to find the verification URL and the code in what a device-code sign-in prints, one row per
 * tool. Written from the vendors' documented formats; the recordings under
 * packages/core/test/fixtures/logins/ are what each row is tested against, and a recording that
 * prints something else changes the row, not the parser. Nothing but the URL and the code is ever
 * taken from the output: success is the tool's readiness probe, never a line the CLI printed.
 *
 * A row with a capture group takes the group; otherwise the whole match.
 */
export interface DevicePattern {
  url: RegExp;
  code: RegExp;
}

/** The first https address on a line */
const ANY_URL = /https:\/\/[^\s"'<>`]+/;
/** Two groups of capital letters and digits joined by a dash, the shape every documented code takes */
const ANY_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/;

export const DEVICE_PATTERNS: Readonly<Record<'gh' | 'copilot' | 'codex' | 'glab', DevicePattern>> = {
  // `! First copy your one-time code: XXXX-XXXX`, then `Open this URL to continue in your web browser: https://github.com/login/device`
  gh: { url: /(https:\/\/\S+\/login\/device)\b/, code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/ },
  // `To authenticate, visit https://github.com/login/device and enter code 1234-5678`
  copilot: { url: /visit\s+(https:\/\/\S+)/, code: /enter code\s+([A-Z0-9]{4}-[A-Z0-9]{4})\b/ },
  // Neither documents the exact wording: the first https address and the first code on any line
  codex: { url: ANY_URL, code: ANY_CODE },
  glab: { url: ANY_URL, code: ANY_CODE },
};

/** Colour and cursor sequences a CLI may print even with NO_COLOR */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

const pick = (pattern: RegExp, line: string): string | null => {
  const match = pattern.exec(line);
  if (!match) return null;
  return match[1] ?? match[0];
};

/**
 * Reads one line for the URL and the code, after taking out colour codes. A URL keeps no trailing
 * punctuation a sentence put after it, and only an https address counts: it becomes a link the
 * person opens.
 */
export function readDeviceLine(pattern: DevicePattern, raw: string): { url: string | null; code: string | null } {
  const line = raw.replace(ANSI, '');
  const url = pick(pattern.url, line)?.replace(/[.,;:!?)\]}]+$/, '') ?? null;
  return { url: url && url.startsWith('https://') ? url : null, code: pick(pattern.code, line) };
}
