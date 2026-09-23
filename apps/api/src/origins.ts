/**
 * Who, on another origin, may read what this API answers.
 *
 * The CORS plugin cannot decide this alone: an event stream hijacks its reply and writes its own
 * headers, so it never reaches the plugin and would otherwise keep a second, laxer copy of the
 * rule. Both ask here instead, and the answer is read from the environment on every call so a
 * test — or a restart-free change — never talks to a stale copy.
 *
 * `AGENTRY_CORS_ORIGIN` is unset by default: the UI is served from this same origin and in dev it
 * goes through the Vite proxy, so nobody is invited until somebody says so.
 */
export function allowedOrigin(origin: string | undefined): string | null {
  const configured = process.env.AGENTRY_CORS_ORIGIN?.trim();
  if (!configured || !origin) return null;
  // The origin is echoed rather than answered with `*`, so a credentialed request still works
  if (configured === '*') return origin;
  const allowed = configured.split(',').map((entry) => entry.trim());
  return allowed.includes(origin) ? origin : null;
}
