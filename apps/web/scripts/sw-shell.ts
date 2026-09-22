// Stamps the built asset list into the service worker.
//
// The worker is hand-written (`public/sw.js`) and only its shell list is generated, so what ships
// is readable: a plugin that emits a worker would hide the one thing that must be reviewable —
// which requests it answers. Vite calls `buildServiceWorker` from `vite.config.ts`; the web tests
// call it too, to run the worker against a known list.

/** The block in `public/sw.js` this module owns, markers included. */
const BLOCK = /\/\* shell:start \*\/[\s\S]*?\/\* shell:end \*\//;

/**
 * A stable id for one build's shell. Not a cryptographic hash: it names a cache, and the only
 * property it needs is that two different shells get two different names. Two rounds with
 * different offset bases, because 32 bits alone would collide once in four billion deploys.
 */
export function shellId(parts: readonly string[]): string {
  const text = parts.join('\n');
  const round = (basis: number): string => {
    let hash = basis;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return round(0x811c9dc5) + round(0x7fffffff);
}

/**
 * Returns `source` with its shell block replaced by the real build id and asset list.
 *
 * `stamp` is folded into the id along with the paths: a build that changed only the contents of
 * `index.html` (the pre-paint theme script, a meta tag) leaves every hashed asset name alone, and
 * without it the worker's own bytes would not change either — so the browser would never fetch the
 * new worker and would go on serving last week's `index.html` from the cache forever.
 */
export function buildServiceWorker(source: string, shell: readonly string[], stamp = ''): string {
  if (!BLOCK.test(source)) throw new Error('sw.js no longer has a /* shell:start */ … /* shell:end */ block to fill in');
  const paths = [...new Set(shell)].sort();
  const list = paths.map((path) => `  ${JSON.stringify(path)},`).join('\n');
  return source.replace(BLOCK, `/* shell:start */\nconst BUILD = ${JSON.stringify(shellId([...paths, stamp]))};\nconst SHELL = [\n${list}\n];\n/* shell:end */`);
}
