/**
 * How to find the verification URL and the code in what a device-code sign-in prints, one row per
 * tool, written from the recordings under packages/core/test/fixtures/logins/ (each run with no
 * terminal on the pinned version; see its README). A CLI that starts printing something else
 * changes the row, not the parser. Nothing but the URL and the code is ever
 * taken from the output: success is the tool's readiness probe, never a line the CLI printed.
 *
 * A row with a capture group takes the group; otherwise the whole match.
 */
export interface DevicePattern {
  url: RegExp;
  /** Null for a sign-in with no code to type: the URL is the whole of it (Tailscale) */
  code: RegExp | null;
}

// No Copilot row: its own `login --device-code` cannot keep the token without a keychain, so its
// Code signs gh in instead (methods.ts). Its recording stays under fixtures/logins/ as evidence.
export const DEVICE_PATTERNS: Readonly<Record<'gh' | 'codex' | 'glab' | 'tailscale', DevicePattern>> = {
  // stderr: `! First copy your one-time code: 250D-975E`, then `Open this URL to continue in your web browser: https://github.com/login/device`
  gh: { url: /web browser:\s*(https:\/\/\S+)/, code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/ },
  // stdout, coloured even with no terminal: the URL alone on the line after "Open this link", the
  // code alone on the line after "Enter this one-time code": `   https://auth.openai.com/codex/device`, `   LK0N-5V0Q5`
  codex: { url: /^\s*(https:\/\/\S+)\s*$/, code: /^\s*([A-Z0-9]{4}-[A-Z0-9]{5})\s*$/ },
  // stderr: `First copy your one-time code: WZS9BFLC` (eight characters, no dash), then
  // `Then open this URL on any device to authorize: https://gitlab.com/oauth/device`
  glab: { url: /to authorize:\s*(https:\/\/\S+)/, code: /one-time code:\s*([A-Z0-9]{8})\b/ },
  // stderr: `To authenticate, visit:`, an empty line, then the URL alone after a tab:
  // `\thttps://login.tailscale.com/a/12c7b6a0132b3`. Opening it is the sign-in; there is no code
  tailscale: { url: /^\s*(https:\/\/\S+)\s*$/, code: null },
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
  return { url: url && url.startsWith('https://') ? url : null, code: pattern.code ? pick(pattern.code, line) : null };
}
