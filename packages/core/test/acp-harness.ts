import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { AcpDriver } from '../src/providers/acp/driver.ts';
import { PROVIDER_MANIFESTS } from '../src/providers/registry.ts';
import type { DriverHarness } from './conformance/suite.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * The conformance harness of one ACP agent: its binary name on the `PATH` is a shim that starts
 * the fake with that agent's profile, so the driver launches exactly what the manifest names. Each
 * file is a harness of a few lines, as a fourth ACP agent's would be.
 */
export function acpHarness(id: 'copilot' | 'gemini' | 'opencode'): DriverHarness {
  const manifest = PROVIDER_MANIFESTS.find((m) => m.id === id);
  if (!manifest) throw new Error(`no manifest for ${id}`);
  const dir = mkdtempSync(join(tmpdir(), `agentry-acp-bin-${id}-`));
  const shim = join(dir, manifest.commands.names[0] ?? id);
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" --profile ${id} "$@"\n`);
  chmodSync(shim, 0o755);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    manifest,
    env: { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
    driver: () => new AcpDriver(manifest, { dataDir: join(dir, 'data') }),
    script: {
      turn: 'TURN',
      ask: () => 'ASK execute',
      unexpected: 'ODD',
      // ACP has no budget, rate-limit window or structured result: the cases that use these are skipped
      budget: 'TURN',
      rateLimit: 'TURN',
      structured: 'TURN',
      noisy: 'NOISY',
      delegating: 'TURN',
      gitPush: 'GITPUSH',
      holdUntilCancel: 'CANCEL-WAIT',
      signedOut: 'AUTH',
    },
    structuredResult: null,
    decision: (result) => (result.includes('It ran') ? 'allow' : result.includes('It was refused') ? 'deny' : null),
    stderrText: 'agent log line 0',
  };
}
